import { applyD1Migrations, evictAllDurableObjects, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { canonicalizeGraphData } from '../../src/worker/domain/graph.ts';
import {
  ALICE,
  callTool,
  createDiagram,
  expectNoFrameOfType,
  MALLORY,
  nextFrameOfType,
  openSocket,
  requestAs,
  saveGraph,
  send,
  SMUGGLED_IDENTITY_HEADER,
  storedGraph,
  testEnv,
  toolText
} from './live-sync-fixtures.ts';

/**
 * @file The live-sync loop through the real Workers runtime: the real Access middleware, the real
 *   diagram service, the real `DiagramSession` Durable Object and real hibernatable WebSockets. The
 *   unit suites cover the pure mutations and the persist-then-notify ordering against in-memory
 *   ports; this file proves the joins none of them can see — that authorization happens before the
 *   upgrade, that an identity header cannot be smuggled past it, and that one MCP tool call reaches
 *   every browser connected to that diagram. Three rules keep this suite deterministic rather than
 *   intermittently hanging, and each exists for a specific reason:
 *
 *   - **Every test addresses a freshly created diagram.** A `DiagramSession` is named by its
 *     diagram's id and survives eviction, so reusing an id would leak one test's connections into
 *     the next.
 *   - **Every socket is tracked and `afterEach` evicts with `{ webSockets: 'close' }`.** Awaiting an
 *     outbound close handshake is unreliable in this pool even once the server side has closed, so
 *     cleanup must not depend on it. Eviction is the documented, unconditional way to force every
 *     hibernatable socket closed, so a failed assertion can never leave one open and block the
 *     shared runtime from tearing down.
 *   - **An assertion that must prove something did _not_ happen reads D1 directly**, rather than
 *     racing a push against a timer — the pattern that produces intermittent hangs.
 */

/**
 * A graph with one node, used wherever a test needs a diagram with something in it.
 */
const ONE_NODE = {
  edges: [],
  nodes: [{ data: { label: 'API' }, id: 'api', position: { x: 0, y: 0 }, type: 'cf-node' }],
  viewport: { x: 0, y: 0, zoom: 1 }
};

/**
 * {@link ONE_NODE} exactly as `canonicalizeGraphData` stores it.
 *
 * Built through the real canonicaliser rather than written out, so an unchanged-graph assertion
 * compares against what the application genuinely persists — the canonical form orders its keys
 * `nodes, edges, viewport`, which a hand-written literal would have to mirror and could silently
 * stop mirroring.
 */
const ONE_NODE_STORED = canonicalizeGraphData(ONE_NODE);

/**
 * A well-formed diagram id that no diagram has.
 */
const ABSENT_ID = '11111111-1111-4111-8111-111111111111';

describe('live sync', () => {
  const openSockets = new Set<WebSocket>();

  beforeAll(async () => {
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  afterEach(async () => {
    for (const socket of openSockets) {
      if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
        socket.close();
      }
    }
    openSockets.clear();
    await evictAllDurableObjects({ webSockets: 'close' });
  });

  /**
   * Connects to a diagram and waits for the session's acknowledgement.
   *
   * @param diagramId Diagram to connect to.
   * @param email Identity to connect as.
   * @param extraHeaders Headers to send on the upgrade.
   * @returns The connected socket and the `connected` frame it received.
   */
  async function connect(
    diagramId: string,
    email: string = ALICE,
    extraHeaders: Record<string, string> = {}
  ): Promise<{ socket: WebSocket; connected: Record<string, unknown> }> {
    const socket = await openSocket(diagramId, email, extraHeaders);
    openSockets.add(socket);
    return { connected: await nextFrameOfType(socket, 'connected'), socket };
  }

  /**
   * Waits until exactly one of two client sockets has observed its close, and returns the other.
   *
   * The server closed one of them, but which client that is depends on the order the runtime
   * happens to list its sockets in, which is not specified. Polling the two `readyState` values is
   * what turns that unknown into an answer, and it is bounded so a close that never propagates
   * fails here rather than as an anonymous frame timeout later.
   *
   * @param first One connected client socket.
   * @param second The other connected client socket.
   * @returns Whichever socket is still open.
   * @throws {Error} When the close has not propagated within the window, or when both or neither
   *   socket closed — either of which would mean the fixture, not the session, is at fault.
   */
  async function settleOneClosed(first: WebSocket, second: WebSocket): Promise<WebSocket> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const open = [first, second].filter((socket) => socket.readyState === WebSocket.OPEN);
      if (open.length === 1) {
        return open[0] as WebSocket;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error(
      `Expected exactly one socket to close; states are ${first.readyState} and ${second.readyState}.`
    );
  }

  describe('authorization before the upgrade', () => {
    it('accepts an owner’s authenticated upgrade', async () => {
      const diagramId = await createDiagram();

      const { connected } = await connect(diagramId);

      expect(connected).toEqual({ type: 'connected', viewer: ALICE });
    });

    it('refuses an unauthenticated upgrade with a problem document, never a redirect', async () => {
      const diagramId = await createDiagram();

      const response = await send(
        new Request(`https://diagrams.test/api/diagrams/${diagramId}/live`, {
          headers: { Upgrade: 'websocket' }
        })
      );

      // `redirect: false` on the `/api` policy is what makes this a `401` rather than a `302`. A
      // browser's `WebSocket` constructor cannot follow a redirect, so a login redirect here
      // would surface as an unexplained connection failure instead of an auth error.
      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
      expect(response.webSocket).toBeNull();
    });

    // The same non-enumerating posture every diagram route has: a foreign diagram and an absent
    // one are indistinguishable, so a connection attempt cannot confirm a guessed id is real.
    it.each([
      ['a foreign diagram', async () => createDiagram(ALICE)],
      ['an absent diagram', () => Promise.resolve(ABSENT_ID)],
      ['a malformed id', () => Promise.resolve('not-a-uuid')]
    ])('refuses %s with 404 and no socket', async (_label, resolveId) => {
      const response = await send(
        await requestAs(
          `/api/diagrams/${await resolveId()}/live`,
          { headers: { Upgrade: 'websocket' } },
          MALLORY
        )
      );

      expect(response.status).toBe(404);
      expect(response.webSocket).toBeNull();
    });

    // The request is well-formed and the diagram exists; it is the protocol that is wrong, so a
    // `400` would misdescribe it.
    it('answers a plain GET with 426 Upgrade Required', async () => {
      const diagramId = await createDiagram();

      const response = await send(await requestAs(`/api/diagrams/${diagramId}/live`));
      const problem = (await response.json()) as { detail: string };

      expect(response.status).toBe(426);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
      expect(problem.detail).toContain('WebSocket');
    });

    // Checked before ownership, deliberately: the protocol error is a fact about the request, so
    // answering it first means a non-upgrade probe cannot be used to tell a foreign diagram from
    // an absent one either.
    it('answers a plain GET for a foreign diagram with 426, not 404', async () => {
      const diagramId = await createDiagram(ALICE);

      const response = await send(await requestAs(`/api/diagrams/${diagramId}/live`, {}, MALLORY));

      expect(response.status).toBe(426);
    });
  });

  describe('identity pinned to the socket', () => {
    // The transport half of the identity guarantee. The identity reaches the session in a header,
    // so a client might try to set that header itself; the Worker strips any inbound copy before
    // forwarding (see `src/worker/infrastructure/session-protocol.ts`).
    it('ignores an identity header the client tried to smuggle in', async () => {
      const diagramId = await createDiagram(MALLORY);

      const { connected } = await connect(diagramId, MALLORY, {
        [SMUGGLED_IDENTITY_HEADER]: ALICE
      });

      expect(connected).toEqual({ type: 'connected', viewer: MALLORY });
    });

    // Header names are case-insensitive, so a lowercase spelling must be overwritten too —
    // otherwise the defence is evaded by changing one character.
    it('ignores a differently-cased smuggled identity header', async () => {
      const diagramId = await createDiagram(MALLORY);

      const { connected } = await connect(diagramId, MALLORY, {
        'x-architect-identity': ALICE
      });

      expect(connected).toEqual({ type: 'connected', viewer: MALLORY });
    });

    // Smuggling the header does not widen access either: the ownership check runs on the verified
    // identity, well before the header is ever written.
    it('does not let a smuggled header reach somebody else’s diagram', async () => {
      const diagramId = await createDiagram(ALICE);

      const response = await send(
        await requestAs(
          `/api/diagrams/${diagramId}/live`,
          { headers: { Upgrade: 'websocket', [SMUGGLED_IDENTITY_HEADER]: ALICE } },
          MALLORY
        )
      );

      expect(response.status).toBe(404);
    });

    // Read back out of the attachment rather than from an instance field, which is what makes it
    // survive hibernation — see `SocketAttachment` in the Durable Object.
    it('stores the verified identity on the socket attachment', async () => {
      const diagramId = await createDiagram();
      await connect(diagramId);

      const attachments = await runInDurableObject(
        testEnv.DIAGRAM_SESSIONS.getByName(diagramId),
        (_instance, state) =>
          state.getWebSockets().map((socket) => socket.deserializeAttachment() as unknown)
      );

      expect(attachments).toEqual([{ viewer: ALICE }]);
    });
  });

  describe('server-to-client push', () => {
    // The automated proxy for this demo's central moment: an agent changes a diagram and every
    // open editor updates immediately, without a reload and without polling.
    it('delivers one tool call’s change to two connections on the same diagram', async () => {
      const diagramId = await createDiagram();
      await saveGraph(diagramId, ONE_NODE);
      const first = await connect(diagramId);
      const second = await connect(diagramId);

      const firstPush = nextFrameOfType(first.socket, 'graph_updated');
      const secondPush = nextFrameOfType(second.socket, 'graph_updated');
      const result = await callTool(ALICE, 'add_node', {
        diagramId,
        id: 'db',
        label: 'Database',
        position: { x: 0, y: 200 },
        typeId: 'd1'
      });

      const expected = toolText(result);
      expect(await firstPush).toMatchObject({ graphData: expected, type: 'graph_updated' });
      expect(await secondPush).toMatchObject({ graphData: expected, type: 'graph_updated' });
      // Both received the same graph the tool reported, and that graph is what D1 holds.
      expect(await storedGraph(diagramId)).toBe(expected);
    });

    it('carries the persisted updatedAt, which is what the client compares against', async () => {
      const diagramId = await createDiagram();
      await saveGraph(diagramId, ONE_NODE);
      const { socket } = await connect(diagramId);

      const push = nextFrameOfType(socket, 'graph_updated');
      await callTool(ALICE, 'update_node', { diagramId, label: 'Renamed', nodeId: 'api' });

      const frame = await push;
      const row = await testEnv.DB.prepare('SELECT updated_at FROM diagrams WHERE id = ?')
        .bind(diagramId)
        .first<{ updated_at: string }>();
      expect(frame.updatedAt).toBe(row?.updated_at);
    });

    it.each([
      [
        'remove_node',
        { nodeId: 'api' },
        (graph: { nodes: unknown[] }) => expect(graph.nodes).toEqual([])
      ],
      [
        'auto_layout_diagram',
        {},
        (graph: { nodes: { position: unknown }[] }) =>
          expect(graph.nodes[0]?.position).toEqual({ x: 0, y: 0 })
      ]
    ])('pushes a %s change', async (tool, args, assertGraph) => {
      const diagramId = await createDiagram();
      await saveGraph(diagramId, {
        ...ONE_NODE,
        nodes: [{ ...ONE_NODE.nodes[0], position: { x: 500, y: 500 } }]
      });
      const { socket } = await connect(diagramId);

      const push = nextFrameOfType(socket, 'graph_updated');
      await callTool(ALICE, tool, { diagramId, ...args });

      assertGraph(JSON.parse(String((await push).graphData)));
    });

    // The edge tools through the real protocol, which is also what proves their registered
    // schemas accept the arguments their descriptions promise — a unit test calls the tool
    // function directly and never sees the schema at all.
    it('pushes an edge added, updated and removed through the protocol', async () => {
      const diagramId = await createDiagram();
      await saveGraph(diagramId, {
        edges: [],
        nodes: [
          { data: { label: 'API' }, id: 'api', position: { x: 0, y: 0 }, type: 'cf-node' },
          { data: { label: 'DB' }, id: 'db', position: { x: 0, y: 200 }, type: 'cf-node' }
        ],
        viewport: { x: 0, y: 0, zoom: 1 }
      });
      const { socket } = await connect(diagramId);

      for (const [tool, args, expectedEdges] of [
        ['add_edge', { edgeType: 'service-binding', id: 'link', source: 'api', target: 'db' }, 1],
        ['update_edge', { edgeId: 'link', label: 'reads' }, 1],
        ['remove_edge', { edgeId: 'link' }, 0]
      ] as const) {
        const push = nextFrameOfType(socket, 'graph_updated');
        const result = await callTool(ALICE, tool, { diagramId, ...args });

        const frame = await push;
        expect(frame.graphData).toBe(toolText(result));
        expect((JSON.parse(String(frame.graphData)) as { edges: unknown[] }).edges).toHaveLength(
          expectedEdges
        );
      }
    });

    // Each diagram id is a different Durable Object, so isolation is structural rather than
    // enforced by a predicate somebody has to remember to write.
    it('does not deliver one diagram’s change to another’s connections', async () => {
      const changed = await createDiagram(ALICE, 'Changed');
      const quiet = await createDiagram(ALICE, 'Quiet');
      await saveGraph(changed, ONE_NODE);
      const changedSocket = await connect(changed);
      const quietSocket = await connect(quiet);

      const push = nextFrameOfType(changedSocket.socket, 'graph_updated');
      await callTool(ALICE, 'update_node', {
        diagramId: changed,
        label: 'Renamed',
        nodeId: 'api'
      });
      await push;

      await expectNoFrameOfType(quietSocket.socket, 'graph_updated');
    });

    // A refused tool call must not push anything: the mutation throws before the write, so there
    // is nothing to announce. D1 is read directly rather than racing a push against a timer.
    it('pushes nothing when the mutation is refused', async () => {
      const diagramId = await createDiagram();
      const before = await saveGraph(diagramId, ONE_NODE);
      const { socket } = await connect(diagramId);

      const result = await callTool(ALICE, 'remove_node', { diagramId, nodeId: 'ghost' });

      expect(result).toMatchObject({ result: { isError: true } });
      expect(await storedGraph(diagramId)).toBe(ONE_NODE_STORED);
      await expectNoFrameOfType(socket, 'graph_updated');
      expect(before).toEqual(expect.any(String));
    });

    // The browser's own autosave is deliberately *not* a push source: this phase adds a read
    // channel for agent changes, not a second write path or an echo of the tab's own saves.
    it('does not push a change the browser made through its own autosave', async () => {
      const diagramId = await createDiagram();
      const { socket } = await connect(diagramId);

      await saveGraph(diagramId, ONE_NODE);

      await expectNoFrameOfType(socket, 'graph_updated');
    });

    it('fans out to nobody, without failing, when no editor is open', async () => {
      const diagramId = await createDiagram();
      await saveGraph(diagramId, ONE_NODE);

      const result = await callTool(ALICE, 'update_node', {
        diagramId,
        label: 'Renamed',
        nodeId: 'api'
      });

      expect(JSON.parse(toolText(result))).toMatchObject({
        nodes: [expect.objectContaining({ data: expect.objectContaining({ label: 'Renamed' }) })]
      });
    });
  });

  describe('the channel is read-only', () => {
    it('answers a client frame with an error rather than acting on it', async () => {
      const diagramId = await createDiagram();
      const { socket } = await connect(diagramId);

      const rejection = nextFrameOfType(socket, 'error');
      socket.send(JSON.stringify({ graphData: '{"nodes":[],"edges":[]}', type: 'graph_updated' }));

      expect(await rejection).toMatchObject({
        detail: expect.stringContaining('read-only') as string,
        type: 'error'
      });
    });

    it('leaves the connection open and the diagram untouched', async () => {
      const diagramId = await createDiagram();
      await saveGraph(diagramId, ONE_NODE);
      const { socket } = await connect(diagramId);

      const rejection = nextFrameOfType(socket, 'error');
      socket.send(JSON.stringify({ nodes: [], type: 'anything' }));
      await rejection;

      expect(socket.readyState).toBe(WebSocket.OPEN);
      expect(await storedGraph(diagramId)).toBe(ONE_NODE_STORED);
    });
  });

  // The object has no route of its own, so neither of these is reachable through the Worker. They
  // exist so a direct call during development fails clearly rather than creating an unattributed
  // connection, and they are asserted here so that intent cannot quietly rot into dead code.
  describe('the session’s own defences, reached directly', () => {
    it.each([
      ['a non-upgrade request', {}],
      ['an upgrade with no identity header', { Upgrade: 'websocket' }]
    ])('refuses %s with 400 and no socket', async (_label, headers) => {
      const diagramId = await createDiagram();

      const response = await testEnv.DIAGRAM_SESSIONS.getByName(diagramId).fetch(
        new Request('https://session.invalid/', { headers })
      );

      expect(response.status).toBe(400);
      expect(response.webSocket).toBeNull();
      // Drained deliberately. An unread body leaves the call in flight, and `afterEach`'s
      // eviction waits for in-flight requests to drain before it closes anything — so skipping
      // this turns a passing test into a hung teardown.
      await response.text();
    });

    // A tab closing between the runtime listing the sockets and the session reaching theirs is an
    // ordinary race, not a failure, and sending to a closed socket throws. One departing viewer
    // must not abort delivery to everybody after them in the list, so the fan-out checks each
    // socket's state — and that check is only observable by arranging the race deliberately.
    it('still reaches a live connection when another closed mid-fan-out', async () => {
      const diagramId = await createDiagram();
      await saveGraph(diagramId, ONE_NODE);
      const first = await connect(diagramId);
      const second = await connect(diagramId);

      // The close and the push happen in the same turn inside the object, which is the race this
      // guard exists for and the only way to reproduce it deterministically. A socket closed from
      // the server side is still *in* `getWebSockets()` — as `CLOSING`, verified here rather than
      // assumed — so the fan-out genuinely reaches it, and sending on it would throw and abort
      // delivery to everybody listed after it. Letting the close settle first would instead remove
      // it from the list and quietly test nothing.
      // Both clients are listening before the push, because the push happens inside the call
      // below and a listener attached afterwards would have missed it.
      const pushes = [
        nextFrameOfType(first.socket, 'graph_updated'),
        nextFrameOfType(second.socket, 'graph_updated')
      ];

      const states = await runInDurableObject(
        testEnv.DIAGRAM_SESSIONS.getByName(diagramId),
        async (instance, state) => {
          (state.getWebSockets()[0] as WebSocket).close(1000, 'Tab closed.');
          const duringFanOut = state.getWebSockets().map((socket) => socket.readyState);
          await instance.applyOperation({ kind: 'auto_layout' });
          return duringFanOut;
        }
      );

      // One socket departing, one still open — so the push had to step over the first to reach
      // the second.
      expect(states).toContain(WebSocket.CLOSING);
      expect(states).toContain(WebSocket.OPEN);

      // Whichever client survived received it. Which of the two the runtime lists first is not
      // specified, so the test races both rather than assuming the list mirrors connect order.
      expect(await Promise.race(pushes)).toMatchObject({
        type: 'graph_updated',
        updatedAt: expect.any(String) as string
      });
      expect(await settleOneClosed(first.socket, second.socket)).toBeDefined();
    });

    // A viewer whose connection errored and one who closed their tab are both simply gone from
    // this object's point of view, and it holds no per-socket state for either to leave behind.
    // The handler is declared so its absence cannot be read as missing cleanup; asserting it is
    // what stops that intent rotting into code a later reader deletes.
    it('releases a failed connection exactly as it releases a clean close', async () => {
      const diagramId = await createDiagram();
      await connect(diagramId);

      const stored = await runInDurableObject(
        testEnv.DIAGRAM_SESSIONS.getByName(diagramId),
        async (instance, state) => {
          const server = state.getWebSockets()[0] as WebSocket;
          instance.webSocketError(server, new Error('Connection reset.'));
          instance.webSocketClose(server, 1006, 'Abnormal closure.');
          return [...(await state.storage.list()).keys()];
        }
      );

      expect(stored).toEqual([]);
    });

    // A socket with no provable identity must not exist. Closing beats answering, which is the
    // opposite of how an ordinary client frame is handled. The assertion reads the server side's
    // own state rather than awaiting a close event on the client: an outbound close handshake is
    // unreliable in this pool, and waiting for one is how this suite would start hanging.
    it('closes a connection whose identity attachment is missing', async () => {
      const diagramId = await createDiagram();
      await connect(diagramId);

      const readyState = await runInDurableObject(
        testEnv.DIAGRAM_SESSIONS.getByName(diagramId),
        (instance, state) => {
          const server = state.getWebSockets()[0] as WebSocket;
          // Erasing the attachment is the only way to reach this branch: `fetch` always attaches
          // before accepting, so nothing a client does can produce it.
          server.serializeAttachment(null);
          instance.webSocketMessage(server, '{}');
          return server.readyState;
        }
      );

      expect(readyState).not.toBe(WebSocket.OPEN);
    });
  });

  describe('hibernation', () => {
    // Eviction is what happens to an idle session whose editor tab is still open. The object is
    // reconstructed on the next event, holding nothing but what the runtime and the socket
    // attachments carry — which is exactly what this object is designed to depend on.
    it('reconstructs and still pushes after the session is evicted', async () => {
      const diagramId = await createDiagram();
      await saveGraph(diagramId, ONE_NODE);
      await connect(diagramId);

      // Closes the first connection as well, which is why a fresh one is opened below: this
      // stands in for the object being evicted, not for the browser going away.
      await evictAllDurableObjects({ webSockets: 'close' });
      openSockets.clear();

      const { connected, socket } = await connect(diagramId);
      expect(connected).toEqual({ type: 'connected', viewer: ALICE });

      const push = nextFrameOfType(socket, 'graph_updated');
      await callTool(ALICE, 'update_node', { diagramId, label: 'After eviction', nodeId: 'api' });

      expect(JSON.parse(String((await push).graphData))).toMatchObject({
        nodes: [
          expect.objectContaining({ data: expect.objectContaining({ label: 'After eviction' }) })
        ]
      });
    });

    // The session holds no durable graph at all: D1 is the one authoritative copy, so there is
    // nothing in the object's own storage for the two to disagree about. The working graph it now
    // keeps is a cache, and this is what proves the distinction is real rather than claimed.
    it('persists nothing of its own, even after serializing a write', async () => {
      const diagramId = await createDiagram();
      await saveGraph(diagramId, ONE_NODE);
      await connect(diagramId);
      await callTool(ALICE, 'update_node', { diagramId, label: 'Renamed', nodeId: 'api' });

      const stored = await runInDurableObject(
        testEnv.DIAGRAM_SESSIONS.getByName(diagramId),
        async (_instance, state) => [...(await state.storage.list()).keys()]
      );

      expect(stored).toEqual([]);
    });

    // The working graph is a cache of D1, so an evicted session must re-read rather than start
    // from nothing. Proved by actually evicting — constructing the class directly would prove only
    // that a constructor runs, which is not the property. A session that lost its state and did
    // not rehydrate would answer with an empty graph here, and then persist that emptiness on the
    // next edit.
    it('rehydrates its working graph from D1 after being evicted, rather than starting empty', async () => {
      const diagramId = await createDiagram();
      await saveGraph(diagramId, ONE_NODE);
      // Warms the session's in-memory copy, so what is asserted below is a genuine reload rather
      // than a first load that never had anything to lose.
      await callTool(ALICE, 'update_node', { diagramId, label: 'Before eviction', nodeId: 'api' });

      await evictAllDurableObjects({ webSockets: 'close' });
      openSockets.clear();

      const snapshot = await testEnv.DIAGRAM_SESSIONS.getByName(diagramId).getSnapshot();

      expect(snapshot?.graphData).toBe(await storedGraph(diagramId));
      expect(JSON.parse(String(snapshot?.graphData))).toMatchObject({
        nodes: [
          expect.objectContaining({ data: expect.objectContaining({ label: 'Before eviction' }) })
        ]
      });
    });

    // The failure mode the rehydration exists to prevent, stated as an outcome rather than as a
    // mechanism: an edit made after an eviction must build on what is stored, not replace it.
    it('applies an edit made after eviction on top of the stored graph', async () => {
      const diagramId = await createDiagram();
      await saveGraph(diagramId, {
        ...ONE_NODE,
        nodes: [
          ONE_NODE.nodes[0] as Record<string, unknown>,
          { data: { label: 'DB' }, id: 'db', position: { x: 0, y: 200 }, type: 'cf-node' }
        ]
      });
      await callTool(ALICE, 'update_node', { diagramId, label: 'Gateway', nodeId: 'api' });

      await evictAllDurableObjects({ webSockets: 'close' });
      openSockets.clear();

      await callTool(ALICE, 'update_node', { diagramId, label: 'Store', nodeId: 'db' });

      // Both edits survive. A session that started from an empty graph could not have found `db`
      // at all, and one that started from a stale copy would have discarded the rename.
      expect(JSON.parse(String(await storedGraph(diagramId)))).toMatchObject({
        nodes: [
          expect.objectContaining({ data: expect.objectContaining({ label: 'Gateway' }) }),
          expect.objectContaining({ data: expect.objectContaining({ label: 'Store' }) })
        ]
      });
    });
  });

  // The phase's own subject: every write to a diagram's graph, from any transport, now takes one
  // serialized path through its session. These assertions are about outcomes a caller can observe
  // — what storage ends up holding and what a connected editor is told — rather than about which
  // internal method was called.
  describe('one serialized write path', () => {
    /**
     * Creates a diagram holding two nodes, so an operation has distinct targets to contend over.
     *
     * @returns The new diagram's id.
     */
    async function withTwoNodes(): Promise<string> {
      const diagramId = await createDiagram();
      await saveGraph(diagramId, {
        edges: [],
        nodes: [
          { data: { label: 'API' }, id: 'api', position: { x: 0, y: 0 }, type: 'cf-node' },
          { data: { label: 'DB' }, id: 'db', position: { x: 0, y: 200 }, type: 'cf-node' }
        ],
        viewport: { x: 0, y: 0, zoom: 1 }
      });
      return diagramId;
    }

    // The race this phase exists to close. Two conflicting changes to the same node, dispatched
    // without awaiting between them, must leave exactly one winner — and D1 must hold what the
    // winning caller was told, rather than a third value neither of them saw.
    it('leaves one deterministic winner when two writes contend for the same node', async () => {
      const diagramId = await withTwoNodes();

      const [first, second] = await Promise.all([
        callTool(ALICE, 'update_node', { diagramId, label: 'First', nodeId: 'api' }),
        callTool(ALICE, 'update_node', { diagramId, label: 'Second', nodeId: 'api' })
      ]);

      // Neither was silently dropped: both were applied and both were answered.
      const labels = [first, second].map(
        (result) =>
          (JSON.parse(toolText(result)) as { nodes: { data: { label: string } }[] }).nodes[0]?.data
            .label
      );
      expect(labels).toContain('First');
      expect(labels).toContain('Second');

      // And storage agrees with the one that was applied last, rather than holding a graph that
      // lost one of the two changes entirely.
      const storedLabel = (
        JSON.parse(String(await storedGraph(diagramId))) as {
          nodes: { data: { label: string } }[];
        }
      ).nodes[0]?.data.label;
      expect(['First', 'Second']).toContain(storedLabel);
      // The later-applied write reported the graph that was persisted, which is the whole of
      // last-applied-wins being observable rather than merely true.
      expect(labels.at(-1)).toBe(storedLabel);
    });

    // Changes to different targets are not a conflict at all, and must both survive. An
    // implementation that serialized by discarding rather than by ordering would pass the test
    // above and fail this one.
    it('keeps both changes when two concurrent writes touch different nodes', async () => {
      const diagramId = await withTwoNodes();

      await Promise.all([
        callTool(ALICE, 'update_node', { diagramId, label: 'Gateway', nodeId: 'api' }),
        callTool(ALICE, 'update_node', { diagramId, label: 'Store', nodeId: 'db' })
      ]);

      expect(JSON.parse(String(await storedGraph(diagramId)))).toMatchObject({
        nodes: [
          expect.objectContaining({ data: expect.objectContaining({ label: 'Gateway' }) }),
          expect.objectContaining({ data: expect.objectContaining({ label: 'Store' }) })
        ]
      });
    });

    // Every operation kind, not just the one convenient to race. A write path that handled only
    // some of the vocabulary would leave the rest racing exactly as they did before.
    it.each([
      ['add_node', { id: 'kv', label: 'Cache', position: { x: 0, y: 400 }, typeId: 'kv' }],
      ['update_node', { label: 'Gateway', nodeId: 'api' }],
      ['remove_node', { nodeId: 'db' }],
      ['add_edge', { edgeType: 'data-flow', id: 'link', source: 'api', target: 'db' }],
      ['auto_layout_diagram', {}]
    ])('serializes a %s against a concurrent whole-graph save', async (tool, args) => {
      const diagramId = await withTwoNodes();

      // An agent's granular change and a browser's autosave arriving together: the two writers
      // that used to race, now sharing one queue.
      await Promise.all([
        callTool(ALICE, tool, { diagramId, ...args }),
        saveGraph(diagramId, {
          edges: [],
          nodes: [
            { data: { label: 'API' }, id: 'api', position: { x: 99, y: 99 }, type: 'cf-node' },
            { data: { label: 'DB' }, id: 'db', position: { x: 0, y: 200 }, type: 'cf-node' }
          ],
          viewport: { x: 0, y: 0, zoom: 1 }
        })
      ]);

      // Whichever landed last, storage holds a complete graph one of them actually produced —
      // never a half-applied one, and never the empty graph a lost hydration would leave.
      const stored = JSON.parse(String(await storedGraph(diagramId))) as { nodes: unknown[] };
      expect(stored.nodes.length).toBeGreaterThan(0);

      // And the session's working copy agrees with storage, so the next edit builds on what is
      // really there.
      const snapshot = await testEnv.DIAGRAM_SESSIONS.getByName(diagramId).getSnapshot();
      expect(snapshot?.graphData).toBe(await storedGraph(diagramId));
    });

    // The REST fallback is no longer an independent writer. Before this phase it wrote to D1
    // itself, so a save and a tool call could each overwrite the other's work unseen.
    it('converges an MCP change and a REST save on one graph', async () => {
      const diagramId = await withTwoNodes();

      await callTool(ALICE, 'add_node', {
        diagramId,
        id: 'kv',
        label: 'Cache',
        position: { x: 0, y: 400 },
        typeId: 'kv'
      });
      await saveGraph(diagramId, {
        edges: [],
        nodes: [
          { data: { label: 'API' }, id: 'api', position: { x: 0, y: 0 }, type: 'cf-node' },
          { data: { label: 'DB' }, id: 'db', position: { x: 0, y: 200 }, type: 'cf-node' },
          { data: { label: 'Cache' }, id: 'kv', position: { x: 0, y: 400 }, type: 'cf-node' },
          { data: { label: 'Queue' }, id: 'q', position: { x: 0, y: 600 }, type: 'cf-node' }
        ],
        viewport: { x: 0, y: 0, zoom: 1 }
      });

      // The agent's node is still there after the browser's save, and the session, storage and a
      // subsequent agent read all describe the same graph.
      const afterSave = await callTool(ALICE, 'get_diagram', { diagramId });
      const stored = String(await storedGraph(diagramId));
      expect(JSON.parse(toolText(afterSave))).toMatchObject({ graphData: stored });
      expect((JSON.parse(stored) as { nodes: unknown[] }).nodes).toHaveLength(4);
    });

    // Persist before broadcast, observed from inside the object where the ordering actually
    // happens. The server-side socket's `send` is intercepted and, at the moment the frame is
    // handed over, D1 is read. An implementation that broadcast first — which is what the source
    // design for this feature proposed — would be caught here: the read would find the graph the
    // frame claims has not been stored yet.
    it('has already persisted the change by the time it hands a frame to a socket', async () => {
      const diagramId = await withTwoNodes();
      await connect(diagramId);

      const { frame, storedAtSend } = await runInDurableObject(
        testEnv.DIAGRAM_SESSIONS.getByName(diagramId),
        async (instance, state) => {
          const server = state.getWebSockets()[0] as WebSocket;
          const realSend = server.send.bind(server);
          let sent: string | undefined;
          let readAtSend: Promise<string | null> | undefined;

          server.send = (data: string | ArrayBuffer | ArrayBufferView): void => {
            const text = String(data);
            if (text.includes('graph_updated')) {
              sent = text;
              // Started at the instant the frame is handed over, before this turn yields.
              readAtSend = testEnv.DB.prepare('SELECT graph_data FROM diagrams WHERE id = ?')
                .bind(diagramId)
                .first<{ graph_data: string }>()
                .then((row) => row?.graph_data ?? null);
            }
            realSend(data);
          };

          await instance.applyOperation({
            kind: 'update_node',
            nodeId: 'api',
            patch: { label: 'Gateway' }
          });

          return { frame: sent, storedAtSend: await readAtSend };
        }
      );

      expect(frame).toBeDefined();
      expect(storedAtSend).toBe((JSON.parse(String(frame)) as { graphData: string }).graphData);
    });

    // The same rule in its visible form: a change that did not reach storage is never announced.
    // Deleting the row is the one way to make a write fail through the real stack.
    it('announces nothing when the write cannot land', async () => {
      const diagramId = await withTwoNodes();
      const { socket } = await connect(diagramId);

      const deleted = await send(
        await requestAs(`/api/diagrams/${diagramId}`, { method: 'DELETE' })
      );
      await deleted.text();

      const result = await callTool(ALICE, 'update_node', {
        diagramId,
        label: 'Gateway',
        nodeId: 'api'
      });

      expect(result).toMatchObject({ result: { isError: true } });
      await expectNoFrameOfType(socket, 'graph_updated');
    });

    // The harder half of the same rule: the session is already **hot**, holding a working graph
    // for a diagram that has since been deleted. It will apply the operation to its cache quite
    // happily — the target is still there, as far as it knows — and only the persist discovers the
    // row has gone. An implementation that broadcast on its own in-memory success rather than on
    // what storage reported would announce a change to a diagram that no longer exists.
    it('announces nothing when the row vanishes under a session that is already hydrated', async () => {
      const diagramId = await withTwoNodes();
      const { socket } = await connect(diagramId);
      // Warms the working graph, so the operation below is applied in memory before the persist
      // finds nothing to write to. The listener is attached before the call that produces the
      // frame, because one attached afterwards would have missed it.
      const warmed = nextFrameOfType(socket, 'graph_updated');
      await callTool(ALICE, 'update_node', { diagramId, label: 'Gateway', nodeId: 'api' });
      await warmed;

      const deleted = await send(
        await requestAs(`/api/diagrams/${diagramId}`, { method: 'DELETE' })
      );
      await deleted.text();

      const refused = await runInDurableObject(
        testEnv.DIAGRAM_SESSIONS.getByName(diagramId),
        async (instance) =>
          instance.applyOperation({ kind: 'update_node', nodeId: 'db', patch: { label: 'Store' } })
      );

      expect(refused).toMatchObject({ outcome: 'rejected', status: 404 });
      await expectNoFrameOfType(socket, 'graph_updated');
      expect(await storedGraph(diagramId)).toBeNull();
    });

    // A refused operation must not disturb the session either: the next write still works, and the
    // graph it builds on is the one storage holds. The Phase 16 spike found that a rejected
    // promise left on the write chain poisons every write after it, which would show up exactly
    // here — as a second change that silently never persists.
    it('keeps accepting writes after one is refused', async () => {
      const diagramId = await withTwoNodes();

      const refused = await callTool(ALICE, 'remove_node', { diagramId, nodeId: 'ghost' });
      expect(refused).toMatchObject({ result: { isError: true } });

      await callTool(ALICE, 'update_node', { diagramId, label: 'Gateway', nodeId: 'api' });

      expect(JSON.parse(String(await storedGraph(diagramId)))).toMatchObject({
        nodes: [
          expect.objectContaining({ data: expect.objectContaining({ label: 'Gateway' }) }),
          expect.objectContaining({ data: expect.objectContaining({ label: 'DB' }) })
        ]
      });
    });

    // A collaborator's save goes through the same session as the owner's agent, which is what
    // makes Phase 17's grant mean "edit this document with me" rather than "edit a copy".
    it('serializes an owner’s agent and a collaborator’s save through one session', async () => {
      const diagramId = await withTwoNodes();
      const granted = await send(
        await requestAs(`/api/diagrams/${diagramId}/collaborators`, {
          body: JSON.stringify({ email: MALLORY }),
          method: 'POST'
        })
      );
      await granted.text();
      expect(granted.status).toBe(201);

      await callTool(ALICE, 'add_node', {
        diagramId,
        id: 'kv',
        label: 'Cache',
        position: { x: 0, y: 400 },
        typeId: 'kv'
      });
      await saveGraph(
        diagramId,
        {
          edges: [],
          nodes: [
            { data: { label: 'API' }, id: 'api', position: { x: 0, y: 0 }, type: 'cf-node' },
            { data: { label: 'DB' }, id: 'db', position: { x: 0, y: 200 }, type: 'cf-node' },
            { data: { label: 'Cache' }, id: 'kv', position: { x: 0, y: 400 }, type: 'cf-node' }
          ],
          viewport: { x: 0, y: 0, zoom: 1 }
        },
        MALLORY
      );

      const snapshot = await testEnv.DIAGRAM_SESSIONS.getByName(diagramId).getSnapshot();
      expect(snapshot?.graphData).toBe(await storedGraph(diagramId));
      expect((JSON.parse(String(snapshot?.graphData)) as { nodes: unknown[] }).nodes).toHaveLength(
        3
      );
    });

    // Addressing a session by a raw id rather than by its diagram's name leaves it with no way to
    // know which row to write, so it refuses rather than guessing. Unreachable through the
    // adapter, which only ever uses `getByName`; asserted so the guard cannot rot into dead code.
    //
    // It refuses rather than throwing, and the difference is load-bearing: an uncaught exception
    // in a Durable Object resets the instance, so a single misaddressed call would drop every
    // editor connected to that object. Both the status and the fact that the object survives are
    // asserted, because only the second one would notice a regression to a throw.
    it('refuses to write when it was not addressed by a diagram id, and stays usable', async () => {
      const stub = testEnv.DIAGRAM_SESSIONS.get(testEnv.DIAGRAM_SESSIONS.newUniqueId());

      expect(await stub.applyOperation({ kind: 'auto_layout' })).toMatchObject({
        outcome: 'rejected',
        status: 404
      });
      expect(await stub.getSnapshot()).toBeNull();
    });

    // A session for a diagram that does not exist has nothing to hydrate from, and says so rather
    // than inventing an empty graph it would then persist over nothing.
    it('reports no snapshot for a diagram that does not exist', async () => {
      const absent = await testEnv.DIAGRAM_SESSIONS.getByName(ABSENT_ID).getSnapshot();

      expect(absent).toBeNull();
    });

    // The same answer for a whole-graph save. The route in front of it refuses a vanished diagram
    // first, so this is reached only by a save that raced a delete — which is precisely the case
    // worth being sure about, since it is the one nobody can arrange on purpose.
    it('refuses a whole-graph save for a diagram that does not exist', async () => {
      expect(await testEnv.DIAGRAM_SESSIONS.getByName(ABSENT_ID).replaceGraph('{}')).toMatchObject({
        outcome: 'rejected',
        status: 404
      });
    });
  });
});
