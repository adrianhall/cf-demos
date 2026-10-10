import { applyD1Migrations, evictAllDurableObjects, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { canonicalizeGraphData } from '../../src/worker/domain/graph.ts';
import {
  ALICE,
  callTool,
  createDiagram,
  expectNoFrameOfType,
  type FrameRecorder,
  MALLORY,
  nextFrameOfType,
  openSocket,
  recordFrames,
  requestAs,
  saveGraph,
  send,
  SMUGGLED_IDENTITY_HEADER,
  storedGraph,
  testEnv,
  toolText,
  withFakeAi
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

    // An identity has to exist in the directory before it can be granted access to a diagram, and
    // the only way into that directory is an authenticated request — exactly as it is for a real
    // colleague told to "sign in once". That rule belongs to `./collaborators.test.ts`; here it is
    // a prerequisite for having a second editor to test with at all.
    const signedIn = await send(await requestAs('/api/me', {}, MALLORY));
    await signedIn.text();
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
   * Frames are recorded from the moment the socket is accepted, so a test can assert on one that
   * arrived before it started looking — which, now that the session sends a snapshot on connect, is
   * every test that does anything immediately afterwards.
   *
   * @param diagramId Diagram to connect to.
   * @param email Identity to connect as.
   * @param extraHeaders Headers to send on the upgrade.
   * @returns The connected socket, its frame recorder, and the `connected` frame it received.
   */
  async function connect(
    diagramId: string,
    email: string = ALICE,
    extraHeaders: Record<string, string> = {}
  ): Promise<{
    socket: WebSocket;
    connected: Record<string, unknown>;
    received: FrameRecorder;
  }> {
    const socket = await openSocket(diagramId, email, extraHeaders);
    openSockets.add(socket);
    const received = recordFrames(socket);
    return { connected: await received.next('connected'), received, socket };
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

      expect(attachments).toEqual([
        { color: expect.stringMatching(/^#/) as string, viewer: ALICE }
      ]);
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

      const firstPush = nextFrameOfType(first.socket, 'operation_applied');
      const secondPush = nextFrameOfType(second.socket, 'operation_applied');
      const result = await callTool(ALICE, 'add_node', {
        diagramId,
        id: 'db',
        label: 'Database',
        position: { x: 0, y: 200 },
        typeId: 'd1'
      });

      // The operation rather than the resulting graph, attributed to the agent that made it —
      // which is what lets a recipient apply the change without discarding its own pending edit.
      for (const frame of [await firstPush, await secondPush]) {
        expect(frame).toMatchObject({
          actor: ALICE,
          operation: { input: { id: 'db', label: 'Database' }, kind: 'add_node' },
          // No client operation id: a tool call did not come from a socket, so there is no
          // optimistic edit for the echo to be matched against.
          operationId: null,
          origin: 'agent',
          type: 'operation_applied'
        });
      }
      // And the graph that produces is what the tool reported and what D1 holds.
      expect(await storedGraph(diagramId)).toBe(toolText(result));
    });

    it('carries the persisted updatedAt, which is what the client compares against', async () => {
      const diagramId = await createDiagram();
      await saveGraph(diagramId, ONE_NODE);
      const { socket } = await connect(diagramId);

      const push = nextFrameOfType(socket, 'operation_applied');
      await callTool(ALICE, 'update_node', { diagramId, label: 'Renamed', nodeId: 'api' });

      const frame = await push;
      const row = await testEnv.DB.prepare('SELECT updated_at FROM diagrams WHERE id = ?')
        .bind(diagramId)
        .first<{ updated_at: string }>();
      expect(frame.updatedAt).toBe(row?.updated_at);
    });

    // Every operation kind over the real protocol, asserted as the change a recipient would
    // apply rather than as the graph it happens to produce.
    it.each([
      ['remove_node', { nodeId: 'api' }, { kind: 'remove_node', nodeId: 'api' }],
      ['auto_layout_diagram', {}, { kind: 'auto_layout' }]
    ])('pushes a %s change', async (tool, args, expectedOperation) => {
      const diagramId = await createDiagram();
      await saveGraph(diagramId, {
        ...ONE_NODE,
        nodes: [{ ...ONE_NODE.nodes[0], position: { x: 500, y: 500 } }]
      });
      const { socket } = await connect(diagramId);

      const push = nextFrameOfType(socket, 'operation_applied');
      await callTool(ALICE, tool, { diagramId, ...args });

      expect(await push).toMatchObject({ operation: expectedOperation });
    });

    // The edge tools through the real protocol, which is also what proves their registered
    // schemas accept the arguments their descriptions promise — a unit test calls the tool
    // function directly and never sees the schema at all. The sequence is asserted alongside,
    // because a recipient applying operations depends on each one arriving exactly one further
    // on than the last.
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
      const sequences: number[] = [];

      for (const [tool, args, expectedKind] of [
        [
          'add_edge',
          { edgeType: 'service-binding', id: 'link', source: 'api', target: 'db' },
          'add_edge'
        ],
        ['update_edge', { edgeId: 'link', label: 'reads' }, 'update_edge'],
        ['remove_edge', { edgeId: 'link' }, 'remove_edge']
      ] as const) {
        const push = nextFrameOfType(socket, 'operation_applied');
        await callTool(ALICE, tool, { diagramId, ...args });

        const frame = await push;
        expect(frame).toMatchObject({ operation: { kind: expectedKind } });
        sequences.push(frame.sequence as number);
      }

      // Consecutive, with no gaps: a recipient that saw a jump would have to discard its graph
      // and ask for a snapshot instead of applying these.
      expect(sequences).toEqual([
        sequences[0],
        (sequences[0] as number) + 1,
        (sequences[0] as number) + 2
      ]);
      expect(
        (JSON.parse(String(await storedGraph(diagramId))) as { edges: unknown[] }).edges
      ).toHaveLength(0);
    });

    // Each diagram id is a different Durable Object, so isolation is structural rather than
    // enforced by a predicate somebody has to remember to write.
    it('does not deliver one diagram’s change to another’s connections', async () => {
      const changed = await createDiagram(ALICE, 'Changed');
      const quiet = await createDiagram(ALICE, 'Quiet');
      await saveGraph(changed, ONE_NODE);
      const changedSocket = await connect(changed);
      const quietSocket = await connect(quiet);

      const push = nextFrameOfType(changedSocket.socket, 'operation_applied');
      await callTool(ALICE, 'update_node', {
        diagramId: changed,
        label: 'Renamed',
        nodeId: 'api'
      });
      await push;

      await expectNoFrameOfType(quietSocket.socket, 'operation_applied');
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
      await expectNoFrameOfType(socket, 'operation_applied');
      expect(before).toEqual(expect.any(String));
    });

    // A whole-graph save cannot be expressed as an operation, so it is announced as a snapshot —
    // the blunter frame, which a recipient applies by replacing its graph. The honesty of that
    // distinction is the point: an operation preserves a recipient's pending edit and this does
    // not, which is why the editor should prefer operations.
    it('announces a whole-graph save as an attributed snapshot, not an operation', async () => {
      const diagramId = await createDiagram();
      const { received, socket } = await connect(diagramId);
      // Consumes the snapshot the session sends on connect, so the assertion below is about the
      // save rather than about the handshake.
      await received.next('snapshot');

      await saveGraph(diagramId, ONE_NODE);

      expect(await received.next('snapshot')).toMatchObject({
        actor: ALICE,
        graphData: ONE_NODE_STORED,
        origin: 'human',
        type: 'snapshot'
      });
      await expectNoFrameOfType(socket, 'operation_applied');
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

  // A broadcast operation is **replicated**: the session applies it to its own graph and every
  // connected browser re-applies the same value to its own. That only works when applying it twice
  // produces the same ids, which an id-less `add_node`/`add_edge` does not — each side mints its
  // own UUID and diverges permanently, with no periodic resync to recover. The defect is
  // protocol-level rather than specific to any one origin; these tests drive it through the RPC
  // entry point because that is the one that authors an operation server-side, with no
  // optimistically-applied client id to carry.
  /**
   * Creates an OpenAI-chat-shaped non-streaming fake AI response queue for the hermetic runtime
   * suite. The engine accepts object results as a defensive fallback even though production
   * streams, which makes this fixture exercise the tool loop without a network binding.
   */
  function fakeAi(rounds: object[]): { run: () => Promise<object> } {
    let next = 0;
    return {
      async run(): Promise<object> {
        const result = rounds[next];
        next += 1;
        if (result === undefined) {
          throw new Error('Fake AI received more rounds than the test scripted.');
        }
        return result;
      }
    };
  }

  describe('AI chat turns', () => {
    it('persists graph changes, broadcasts them to another connection, and keeps the originator usable', async () => {
      const diagramId = await createDiagram();
      const first = await connect(diagramId);
      const second = await connect(diagramId);

      await withFakeAi(
        fakeAi([
          {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      function: {
                        arguments: '{"label":"API","typeId":"worker"}',
                        name: 'add_node'
                      },
                      id: 'call-node',
                      type: 'function'
                    },
                    {
                      function: { arguments: '{"title":"AI design"}', name: 'rename_diagram' },
                      id: 'call-title',
                      type: 'function'
                    }
                  ]
                }
              }
            ]
          },
          { choices: [{ message: { content: 'Done.' } }] }
        ]),
        async () => {
          first.socket.send(
            JSON.stringify({
              clientRequestId: 'turn-1',
              text: 'Add a Worker.',
              type: 'chat_message'
            })
          );
          expect(await first.received.next('chat_status')).toMatchObject({
            clientRequestId: 'turn-1',
            type: 'chat_status'
          });
          expect(await first.received.next('chat_done')).toMatchObject({
            assistantText: 'Done.',
            clientRequestId: 'turn-1'
          });
          expect(await second.received.next('operation_applied')).toMatchObject({
            origin: 'ai-chat',
            operation: { kind: 'add_node' }
          });
          expect(await second.received.next('diagram_renamed')).toMatchObject({
            title: 'AI design'
          });
        }
      );

      const row = await testEnv.DB.prepare('SELECT title, graph_data FROM diagrams WHERE id = ?')
        .bind(diagramId)
        .first<{ graph_data: string; title: string }>();
      expect(row?.title).toBe('AI design');
      expect(JSON.parse(row?.graph_data ?? '{}')).toMatchObject({
        nodes: [expect.objectContaining({ data: expect.objectContaining({ label: 'API' }) })]
      });

      // A failed or completed turn must not poison the socket. This ordinary live operation proves
      // the same connection remains usable after `chat_done`.
      first.socket.send(JSON.stringify({ type: 'resync' }));
      expect(await first.received.next('snapshot')).toMatchObject({ type: 'snapshot' });
    });

    it('reports a binding failure only to the chat originator and leaves its socket usable', async () => {
      const diagramId = await createDiagram();
      const first = await connect(diagramId);
      const second = await connect(diagramId);

      await withFakeAi(
        { run: async (): Promise<never> => Promise.reject(new Error('Gateway unavailable')) },
        async () => {
          first.socket.send(
            JSON.stringify({
              clientRequestId: 'turn-error',
              text: 'Explain.',
              type: 'chat_message'
            })
          );
          expect(await first.received.next('chat_error')).toMatchObject({
            clientRequestId: 'turn-error',
            message: 'Gateway unavailable'
          });
          await expectNoFrameOfType(second.socket, 'chat_error');
        }
      );

      first.socket.send(JSON.stringify({ type: 'resync' }));
      expect(await first.received.next('snapshot')).toMatchObject({ type: 'snapshot' });
    });
  });

  describe('a creating operation replicates the id it persisted', () => {
    it('broadcasts the id a server-authored add_node actually stored', async () => {
      const diagramId = await createDiagram();
      const { received } = await connect(diagramId);

      const push = received.next('operation_applied');
      // No `id` in the input, which is exactly the shape a chat tool call produces.
      await testEnv.DIAGRAM_SESSIONS.getByName(diagramId).applyOperation(
        { input: { label: 'API', position: { x: 0, y: 0 }, typeId: 'worker' }, kind: 'add_node' },
        ALICE
      );

      const frame = (await push) as { operation: { input: { id?: unknown } } };
      const broadcastId = frame.operation.input.id;
      const persisted = JSON.parse(String(await storedGraph(diagramId))) as {
        nodes: { id: string }[];
      };

      // The precise failure before this fix: `broadcastId` was `undefined` while a real UUID sat
      // in storage, so every replica invented a different one.
      expect(typeof broadcastId).toBe('string');
      expect(broadcastId).toBe(persisted.nodes[0]?.id);
    });

    // The sequence that makes the divergence visible, and the one an AI chat turn performs on
    // every "add these services and wire them together" request: create, learn the id from the
    // broadcast, then reference it. Against the unfixed session the second `add_edge` endpoint
    // names a node only the server has.
    it('accepts ids learned from add_node broadcasts as add_edge endpoints', async () => {
      const diagramId = await createDiagram();
      const { received } = await connect(diagramId);
      const session = testEnv.DIAGRAM_SESSIONS.getByName(diagramId);

      const ids: string[] = [];
      for (const label of ['API', 'DB']) {
        const push = received.next('operation_applied');
        await session.applyOperation(
          { input: { label, position: { x: 0, y: 0 }, typeId: 'worker' }, kind: 'add_node' },
          ALICE
        );
        const frame = (await push) as { operation: { input: { id: string } } };
        ids.push(frame.operation.input.id);
      }

      const edgePush = received.next('operation_applied');
      const outcome = await session.applyOperation(
        {
          input: { edgeType: 'data-flow', source: ids[0] as string, target: ids[1] as string },
          kind: 'add_edge'
        },
        ALICE
      );

      // Applied rather than refused with `notFound()`, which is what a replica-only id produces.
      expect(outcome.outcome).toBe('applied');
      const edgeFrame = (await edgePush) as {
        operation: { input: { id: string; source: string; target: string } };
      };
      expect(edgeFrame.operation.input).toMatchObject({ source: ids[0], target: ids[1] });

      // And the edge a replica would build from the broadcast is the edge that was stored.
      const persisted = JSON.parse(String(await storedGraph(diagramId))) as {
        edges: { id: string }[];
      };
      expect(edgeFrame.operation.input.id).toBe(persisted.edges[0]?.id);
    });

    // The client already supplies its own id so its optimistic edit round-trips unchanged. The fix
    // must not quietly replace it, which would make every human edit a rollback-and-reapply.
    it('leaves a caller-supplied id exactly as it was given', async () => {
      const diagramId = await createDiagram();
      const { received } = await connect(diagramId);

      const push = received.next('operation_applied');
      await testEnv.DIAGRAM_SESSIONS.getByName(diagramId).applyOperation(
        {
          input: { id: 'chosen-id', label: 'API', position: { x: 0, y: 0 }, typeId: 'worker' },
          kind: 'add_node'
        },
        ALICE
      );

      expect(await push).toMatchObject({ operation: { input: { id: 'chosen-id' } } });
    });
  });

  // This sub-phase's subject: the channel now carries operations in both directions, so a second
  // person's edit arrives while you are looking at the diagram rather than on your next reload.
  describe('two editors on one diagram', () => {
    /**
     * Creates a diagram the owner and a collaborator can both edit, holding two nodes.
     *
     * Going through the real collaborator route rather than inserting a grant means the fixture
     * cannot set up access the application itself would refuse.
     *
     * @returns The new diagram's id.
     * @throws {Error} When the grant fails, so a broken fixture fails at its own call site.
     */
    async function withCollaborator(): Promise<string> {
      const diagramId = await createDiagram();
      await saveGraph(diagramId, {
        edges: [],
        nodes: [
          { data: { label: 'API' }, id: 'api', position: { x: 0, y: 0 }, type: 'cf-node' },
          { data: { label: 'DB' }, id: 'db', position: { x: 0, y: 200 }, type: 'cf-node' }
        ],
        viewport: { x: 0, y: 0, zoom: 1 }
      });

      const granted = await send(
        await requestAs(`/api/diagrams/${diagramId}/collaborators`, {
          body: JSON.stringify({ email: MALLORY }),
          method: 'POST'
        })
      );
      await granted.text();
      if (granted.status !== 201) {
        throw new Error(`Fixture could not add a collaborator: HTTP ${granted.status}`);
      }
      return diagramId;
    }

    /**
     * Sends one operation over a socket.
     *
     * @param socket Socket to send on.
     * @param operation Operation to apply.
     * @param operationId Client-chosen id, echoed on the answer.
     */
    function sendOperation(
      socket: WebSocket,
      operation: Record<string, unknown>,
      operationId = 'op-1'
    ): void {
      socket.send(JSON.stringify({ operation, operationId, type: 'operation' }));
    }

    // Presence is derived from live socket attachments, never from D1 or browser-supplied identity.
    // These assertions exercise the full Worker → DO upgrade boundary, including the departure
    // callback that hibernatable sockets invoke after a browser tab goes away.
    it('announces joins, snapshots current participants, and announces the final departure', async () => {
      const diagramId = await withCollaborator();
      const owner = await connect(diagramId, ALICE);
      expect(await owner.received.next('presence_snapshot')).toEqual({
        participants: [],
        type: 'presence_snapshot'
      });

      const guest = await connect(diagramId, MALLORY);
      expect(await owner.received.next('presence_joined')).toMatchObject({
        color: expect.stringMatching(/^#/) as string,
        email: MALLORY,
        type: 'presence_joined'
      });
      expect(await guest.received.next('presence_snapshot')).toMatchObject({
        participants: [expect.objectContaining({ email: ALICE })],
        type: 'presence_snapshot'
      });

      // Another tab for the same identity does not make a duplicate collaborator appear or leave.
      const secondGuest = await connect(diagramId, MALLORY);
      expect(await secondGuest.received.next('presence_snapshot')).toMatchObject({
        participants: [expect.objectContaining({ email: ALICE })]
      });
      await expectNoFrameOfType(owner.socket, 'presence_joined');
      guest.socket.close();
      await expectNoFrameOfType(owner.socket, 'presence_left');

      secondGuest.socket.close();
      expect(await owner.received.next('presence_left')).toEqual({
        email: MALLORY,
        type: 'presence_left'
      });
    });

    it('relays cursor and selection only to the other editor without writing D1', async () => {
      const diagramId = await withCollaborator();
      const owner = await connect(diagramId, ALICE);
      const guest = await connect(diagramId, MALLORY);
      const before = await storedGraph(diagramId);

      guest.socket.send(JSON.stringify({ type: 'cursor_moved', x: 120, y: 240 }));
      expect(await owner.received.next('cursor_moved')).toMatchObject({
        color: expect.stringMatching(/^#/) as string,
        email: MALLORY,
        type: 'cursor_moved',
        x: 120,
        y: 240
      });
      await expectNoFrameOfType(guest.socket, 'cursor_moved');

      guest.socket.send(JSON.stringify({ edgeId: null, nodeId: 'api', type: 'selection_changed' }));
      expect(await owner.received.next('selection_changed')).toMatchObject({
        edgeId: null,
        email: MALLORY,
        nodeId: 'api',
        type: 'selection_changed'
      });
      await expectNoFrameOfType(guest.socket, 'selection_changed');
      expect(await storedGraph(diagramId)).toBe(before);
    });

    // **The headline behaviour of this sub-phase.** Two people, two sockets, one diagram: each
    // one's add, update and remove reaches the other live, carrying the change itself rather than
    // a whole graph, and D1 agrees with what they were both told.
    it('delivers each editor’s add, update and remove to the other, live', async () => {
      const diagramId = await withCollaborator();
      const owner = await connect(diagramId, ALICE);
      const guest = await connect(diagramId, MALLORY);

      // Owner adds. The guest sees it.
      sendOperation(owner.socket, {
        input: { id: 'kv', label: 'Cache', position: { x: 0, y: 400 }, typeId: 'kv' },
        kind: 'add_node'
      });
      expect(await guest.received.next('operation_applied')).toMatchObject({
        actor: ALICE,
        operation: { input: { id: 'kv' }, kind: 'add_node' },
        origin: 'human'
      });

      // The owner's own add echoes back to them too, which is deliberate — it is the
      // confirmation that what they drew locally is what the server stored. Consumed here so the
      // assertions below are about the guest's operations rather than the owner's own.
      expect(await owner.received.next('operation_applied')).toMatchObject({ actor: ALICE });

      // Guest updates. The owner sees it, attributed to the guest rather than to the owner.
      sendOperation(
        guest.socket,
        { kind: 'update_node', nodeId: 'api', patch: { label: 'Gateway' } },
        'op-2'
      );
      expect(await owner.received.next('operation_applied')).toMatchObject({
        actor: MALLORY,
        operation: { kind: 'update_node', nodeId: 'api' },
        operationId: 'op-2',
        origin: 'human'
      });

      // Guest removes. The owner sees that too — and because the owner's recorder advances
      // through the stream, this is genuinely the third operation rather than the first again.
      sendOperation(guest.socket, { kind: 'remove_node', nodeId: 'db' }, 'op-3');
      expect(await owner.received.next('operation_applied')).toMatchObject({
        operation: { kind: 'remove_node', nodeId: 'db' }
      });

      // And all three landed in D1, in order: the node the owner added is present, the rename
      // the guest made is present, and the node the guest removed is gone.
      expect(JSON.parse(String(await storedGraph(diagramId)))).toMatchObject({
        nodes: [
          expect.objectContaining({ data: expect.objectContaining({ label: 'Gateway' }) }),
          expect.objectContaining({ id: 'kv' })
        ]
      });
    });

    // The originator gets the echo too. Suppressing it would save a frame and cost the only
    // confirmation that what the client drew locally is what the server actually stored.
    it('echoes an operation to its originator, carrying their own operation id', async () => {
      const diagramId = await withCollaborator();
      const owner = await connect(diagramId, ALICE);

      sendOperation(owner.socket, { kind: 'remove_node', nodeId: 'db' }, 'my-edit');

      expect(await owner.received.next('operation_applied')).toMatchObject({
        operationId: 'my-edit',
        origin: 'human'
      });
    });

    // An agent and a person editing the same diagram at the same time. The origins differ even
    // though the identity does not, which is the whole reason the frame carries one: an agent
    // authenticates as the person who configured it.
    it('distinguishes the owner’s own agent from the owner’s own editing', async () => {
      const diagramId = await withCollaborator();
      const guest = await connect(diagramId, MALLORY);

      const owner = await connect(diagramId, ALICE);
      sendOperation(owner.socket, { kind: 'remove_node', nodeId: 'db' });
      expect(await guest.received.next('operation_applied')).toMatchObject({
        actor: ALICE,
        origin: 'human'
      });

      await callTool(ALICE, 'update_node', { diagramId, label: 'Gateway', nodeId: 'api' });
      expect(await guest.received.next('operation_applied')).toMatchObject({
        actor: ALICE,
        origin: 'agent'
      });

      expect(JSON.parse(String(await storedGraph(diagramId)))).toMatchObject({
        nodes: [expect.objectContaining({ data: expect.objectContaining({ label: 'Gateway' }) })]
      });
    });

    // The ordinary shape of collaboration rather than a bug: two people delete the same node, and
    // the second deletion names something already gone. The person who sent it is told; nobody
    // else is, because a rejection names an element they may be editing quite happily.
    it('rejects a stale target to its originator alone, leaving both connections working', async () => {
      const diagramId = await withCollaborator();
      const owner = await connect(diagramId, ALICE);
      const guest = await connect(diagramId, MALLORY);

      sendOperation(owner.socket, { kind: 'remove_node', nodeId: 'db' }, 'first-delete');
      await guest.received.next('operation_applied');
      // The owner's own echo, consumed so the final assertion below is about the guest's later
      // operation rather than this one.
      await owner.received.next('operation_applied');

      // The guest deletes the same node, not yet knowing it has gone.
      sendOperation(guest.socket, { kind: 'remove_node', nodeId: 'db' }, 'second-delete');

      expect(await guest.received.next('operation_rejected')).toMatchObject({
        detail: expect.stringContaining('db') as string,
        operationId: 'second-delete',
        status: 404,
        type: 'operation_rejected'
      });
      // The owner heard nothing about it.
      await expectNoFrameOfType(owner.socket, 'operation_rejected');

      // Both sockets are still open and both can still edit, which is the part that matters: a
      // race must not cost anybody their session.
      expect(owner.socket.readyState).toBe(WebSocket.OPEN);
      expect(guest.socket.readyState).toBe(WebSocket.OPEN);

      sendOperation(
        guest.socket,
        { kind: 'update_node', nodeId: 'api', patch: { label: 'Still working' } },
        'after-rejection'
      );
      expect(await owner.received.next('operation_applied')).toMatchObject({ actor: MALLORY });
    });

    // Attribution comes from the socket, never from the frame. The protocol has no author field,
    // so a payload carrying one is either a confused client or a probe — and it is refused rather
    // than quietly stripped, so the attempt is visible to whoever made it.
    it.each(['actor', 'author', 'origin'])(
      'refuses an operation that tries to assert its own %s',
      async (field) => {
        const diagramId = await withCollaborator();
        const guest = await connect(diagramId, MALLORY);

        guest.socket.send(
          JSON.stringify({
            operation: { [field]: ALICE, kind: 'remove_node', nodeId: 'db' },
            operationId: 'smuggled',
            type: 'operation'
          })
        );

        expect(await guest.received.next('error')).toMatchObject({
          detail: expect.stringContaining(field) as string,
          type: 'error'
        });
        // Nothing was applied: the node the operation named is still there.
        expect(
          (JSON.parse(String(await storedGraph(diagramId))) as { nodes: unknown[] }).nodes
        ).toHaveLength(2);
      }
    );

    // A client cannot be trusted to send well-formed anything. Each of these must produce an
    // answer rather than an exception, because an uncaught error in a Durable Object would reset
    // the instance and disconnect everybody else on the diagram.
    it.each([
      ['not JSON at all', 'this is not json'],
      ['a JSON array', '[]'],
      ['an unknown frame type', JSON.stringify({ type: 'nonsense' })],
      [
        'an operation with no id',
        JSON.stringify({ operation: { kind: 'auto_layout' }, type: 'operation' })
      ],
      [
        'an unknown operation kind',
        JSON.stringify({
          operation: { kind: 'drop_database' },
          operationId: 'x',
          type: 'operation'
        })
      ],
      [
        'an operation missing a required field',
        JSON.stringify({ operation: { kind: 'remove_node' }, operationId: 'x', type: 'operation' })
      ],
      [
        'a node position that is not numbers',
        JSON.stringify({
          operation: {
            input: { label: 'x', position: { x: 'left', y: 0 }, typeId: 'worker' },
            kind: 'add_node'
          },
          operationId: 'x',
          type: 'operation'
        })
      ]
    ])(
      'answers %s with an error, keeping the connection and the diagram intact',
      async (_label, payload) => {
        const diagramId = await withCollaborator();
        const stored = await storedGraph(diagramId);
        const { received, socket } = await connect(diagramId, MALLORY);

        socket.send(payload);
        await received.next('error');

        expect(socket.readyState).toBe(WebSocket.OPEN);
        expect(await storedGraph(diagramId)).toBe(stored);
      }
    );

    // One client's malformed frame must not disturb anybody else's session — which is exactly
    // what an uncaught exception in a Durable Object would do.
    it('keeps every other editor connected when one sends nonsense', async () => {
      const diagramId = await withCollaborator();
      const owner = await connect(diagramId, ALICE);
      const guest = await connect(diagramId, MALLORY);

      guest.socket.send('not json');
      await guest.received.next('error');

      sendOperation(guest.socket, { kind: 'remove_node', nodeId: 'db' }, 'after-nonsense');

      expect(await owner.received.next('operation_applied')).toMatchObject({ actor: MALLORY });
      expect(owner.socket.readyState).toBe(WebSocket.OPEN);
    });
  });

  // Operation-based sync has one characteristic failure and it is silent: apply an operation to
  // the wrong base graph and the canvas diverges from what is stored, with nobody finding out
  // until a reload. These cover the two things that stop that happening.
  describe('keeping a client in step', () => {
    // A joining editor is told the exact graph, and the exact point in the operation stream, that
    // subsequent operations will be applied to. The `GET` it has just made is not enough: a change
    // can land between that response and the socket opening.
    it('sends a joining editor the graph its operations will be applied to', async () => {
      const diagramId = await createDiagram();
      await saveGraph(diagramId, ONE_NODE);

      const { received } = await connect(diagramId);

      expect(await received.next('snapshot')).toMatchObject({
        // No origin or actor: this is an answer rather than somebody's change, so the client has
        // nothing to announce to its user.
        actor: null,
        graphData: ONE_NODE_STORED,
        origin: null,
        sequence: expect.any(Number) as number,
        type: 'snapshot'
      });
    });

    // A diagram deleted between the upgrade being authorized and the snapshot being prepared.
    // Nothing is sent rather than an error frame: the client is about to be told the diagram is
    // gone by every other route, and a failure on the socket would be the least clear way for it
    // to find out. The connection is left open and usable, which is what this asserts.
    it('sends no snapshot, and no error, when the diagram vanishes during the handshake', async () => {
      const diagramId = await createDiagram();
      const deleted = await send(
        await requestAs(`/api/diagrams/${diagramId}`, { method: 'DELETE' })
      );
      await deleted.text();

      // Reaching the session directly, because the route in front of it would now refuse the
      // upgrade — this is the race that only happens between those two checks.
      const response = await testEnv.DIAGRAM_SESSIONS.getByName(diagramId).fetch(
        new Request('https://session.invalid/', {
          headers: { 'Upgrade': 'websocket', 'X-Architect-Identity': ALICE }
        })
      );
      const socket = response.webSocket as WebSocket;
      socket.accept();
      openSockets.add(socket);
      const received = recordFrames(socket);

      await expectNoFrameOfType(socket, 'snapshot');
      expect(socket.readyState).toBe(WebSocket.OPEN);
      expect(received.frames.map((frame) => frame.type)).not.toContain('error');
    });

    // A client that has missed a frame cannot apply the next operation safely, so it asks to
    // start again rather than guessing.
    it('resends the whole graph on request', async () => {
      const diagramId = await createDiagram();
      await saveGraph(diagramId, ONE_NODE);
      const { received, socket } = await connect(diagramId);
      await received.next('snapshot');

      await callTool(ALICE, 'update_node', { diagramId, label: 'Renamed', nodeId: 'api' });
      socket.send(JSON.stringify({ type: 'resync' }));

      const frame = await received.next('snapshot');
      expect(frame).toMatchObject({ actor: null, origin: null, type: 'snapshot' });
      // What it resends is what is actually stored, which is the only thing that makes it a
      // recovery rather than a second guess.
      expect(frame.graphData).toBe(await storedGraph(diagramId));
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
        nextFrameOfType(first.socket, 'operation_applied'),
        nextFrameOfType(second.socket, 'operation_applied')
      ];

      const states = await runInDurableObject(
        testEnv.DIAGRAM_SESSIONS.getByName(diagramId),
        async (instance, state) => {
          (state.getWebSockets()[0] as WebSocket).close(1000, 'Tab closed.');
          const duringFanOut = state.getWebSockets().map((socket) => socket.readyState);
          await instance.applyOperation({ kind: 'auto_layout' }, ALICE);
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
        type: 'operation_applied',
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

      const { connected, received } = await connect(diagramId);
      expect(connected).toEqual({ type: 'connected', viewer: ALICE });
      // The reconstructed object hands the new connection the graph it rehydrated from D1, which
      // is the first thing the client needs and the first proof the eviction cost nothing.
      expect(await received.next('snapshot')).toMatchObject({ graphData: ONE_NODE_STORED });

      await callTool(ALICE, 'update_node', { diagramId, label: 'After eviction', nodeId: 'api' });

      expect(await received.next('operation_applied')).toMatchObject({
        operation: { kind: 'update_node', nodeId: 'api', patch: { label: 'After eviction' } }
      });
      expect(JSON.parse(String(await storedGraph(diagramId)))).toMatchObject({
        nodes: [
          expect.objectContaining({ data: expect.objectContaining({ label: 'After eviction' }) })
        ]
      });
    });

    it('rebuilds presence from surviving socket attachments after hibernation', async () => {
      const diagramId = await createDiagram();
      await saveGraph(diagramId, ONE_NODE);
      const granted = await send(
        await requestAs(`/api/diagrams/${diagramId}/collaborators`, {
          body: JSON.stringify({ email: MALLORY }),
          method: 'POST'
        })
      );
      await granted.text();
      expect(granted.status).toBe(201);
      const owner = await connect(diagramId, ALICE);
      const guest = await connect(diagramId, MALLORY);
      await owner.received.next('presence_joined');
      await guest.received.next('presence_snapshot');

      // The identity and colour are in the socket attachments, not an in-memory map. Default
      // eviction retains the sockets and reconstructs the object that will handle this cursor.
      await evictAllDurableObjects();
      guest.socket.send(JSON.stringify({ type: 'cursor_moved', x: 44, y: 55 }));

      expect(await owner.received.next('cursor_moved')).toMatchObject({
        email: MALLORY,
        type: 'cursor_moved',
        x: 44,
        y: 55
      });
      expect(await storedGraph(diagramId)).toContain('API');
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

    // The sequence counter is deliberately in memory while hibernatable sockets survive at the
    // edge. After reconstruction those two facts disagree: the socket may be at sequence 10 while
    // the new object starts at zero. Before it sends operation 1, it therefore rebases every
    // surviving client with a sequence-0 snapshot. Without it the client would mistake 1 for an old
    // duplicate and silently discard a real edit.
    it('rebases sockets that survived hibernation before restarting its operation sequence', async () => {
      const diagramId = await createDiagram();
      await saveGraph(diagramId, ONE_NODE);
      const connected = await connect(diagramId);
      await connected.received.next('snapshot');

      // First instance advances its counter.
      await callTool(ALICE, 'update_node', { diagramId, label: 'Before sleep', nodeId: 'api' });
      const before = await connected.received.next('operation_applied');
      expect(before.sequence).toBeGreaterThan(0);

      // Default eviction hibernates the WebSocket instead of closing it. The next RPC wakes a new
      // instance while this same client connection remains open.
      await evictAllDurableObjects();

      await callTool(ALICE, 'update_node', { diagramId, label: 'After sleep', nodeId: 'api' });

      const rebased = await connected.received.next('snapshot');
      const after = await connected.received.next('operation_applied');
      expect(rebased).toMatchObject({ origin: null, sequence: 0, type: 'snapshot' });
      expect(after).toMatchObject({ sequence: 1, type: 'operation_applied' });
      expect(connected.socket.readyState).toBe(WebSocket.OPEN);
      expect(String(await storedGraph(diagramId))).toContain('After sleep');
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
            if (text.includes('operation_applied')) {
              sent = text;
              // Started at the instant the frame is handed over, before this turn yields.
              readAtSend = testEnv.DB.prepare('SELECT graph_data FROM diagrams WHERE id = ?')
                .bind(diagramId)
                .first<{ graph_data: string }>()
                .then((row) => row?.graph_data ?? null);
            }
            realSend(data);
          };

          await instance.applyOperation(
            { kind: 'update_node', nodeId: 'api', patch: { label: 'Gateway' } },
            ALICE
          );

          return { frame: sent, storedAtSend: await readAtSend };
        }
      );

      // The frame announces the rename, and at the instant it was handed over, D1 already held
      // it. An implementation that broadcast first would have found the old label still stored.
      expect(frame).toContain('Gateway');
      expect(String(storedAtSend)).toContain('Gateway');
      expect(storedAtSend).toBe(await storedGraph(diagramId));
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
      await expectNoFrameOfType(socket, 'operation_applied');
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
      const warmed = nextFrameOfType(socket, 'operation_applied');
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
      await expectNoFrameOfType(socket, 'operation_applied');
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
