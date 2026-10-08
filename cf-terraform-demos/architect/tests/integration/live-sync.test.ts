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
      ['an absent diagram', () => Promise.resolve('11111111-1111-4111-8111-111111111111')],
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
          await instance.notifyGraphUpdated('{"nodes":[],"edges":[],"viewport":{}}', 'now');
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
        updatedAt: 'now'
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
    // nothing in the object's own storage for the two to disagree about.
    it('persists nothing of its own', async () => {
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
  });
});
