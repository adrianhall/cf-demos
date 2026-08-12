import {
  applyD1Migrations,
  evictAllDurableObjects,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { JWT_HEADER, signDevJwt } from "@adrianhall/cloudflare-toolkit/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/** Test-only Worker bindings injected by the integration Vitest project. */
interface TestEnv extends Env {
  /** Parsed D1 migrations that initialize Miniflare's otherwise empty D1 database. */
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

const ORIGIN = "https://architect.example";

/** Build an authenticated request for one development Access identity. */
async function apiRequest(
  email: string | undefined,
  path: string,
  init: RequestInit = {},
): Promise<Request> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
  };
  if (email !== undefined) {
    headers[JWT_HEADER] = await signDevJwt(email);
  }
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

/** Dispatch a request through the configured Worker. */
async function request(requestValue: Request): Promise<Response> {
  return exports.default.fetch(requestValue);
}

/** Sign in an identity for the first time (upserts it into `users` via `GET /api/me`) -- a
 * collaborator must already exist in `users` before it can be added
 * (docs/09C-COLLABORATIVE-EDITING.md's Collaborator Model). */
async function signIn(email: string): Promise<void> {
  const response = await request(
    await apiRequest(email, "/api/me", { headers: { origin: ORIGIN } }),
  );
  if (response.status !== 200) {
    throw new Error(`signIn(${email}) failed with status ${response.status}`);
  }
}

/** Grant `collaboratorEmail` edit access to `diagramId` as its owner. */
async function addCollaborator(
  owner: string,
  diagramId: string,
  collaboratorEmail: string,
): Promise<void> {
  const response = await request(
    await apiRequest(owner, `/api/diagrams/${diagramId}/collaborators`, {
      body: JSON.stringify({ email: collaboratorEmail }),
      headers: { "content-type": "application/json", origin: ORIGIN },
      method: "POST",
    }),
  );
  if (response.status !== 201) {
    throw new Error(
      `addCollaborator(${collaboratorEmail}) failed with status ${response.status}`,
    );
  }
}

/** Create a diagram owned by `email`, returning its id. */
async function createDiagram(email: string): Promise<string> {
  const response = await request(
    await apiRequest(email, "/api/diagrams", {
      body: JSON.stringify({}),
      headers: { "content-type": "application/json", origin: ORIGIN },
      method: "POST",
    }),
  );
  const { diagram } = (await response.json()) as { diagram: { id: string } };
  return diagram.id;
}

/** Load a diagram's current persisted fields straight from D1 via the owner-authenticated REST
 * route -- the simplest way to assert on "the final D1 row" without reaching into D1 directly. */
async function loadDiagram(
  email: string,
  diagramId: string,
): Promise<{ graphData: string; updatedAt: string }> {
  const response = await request(
    await apiRequest(email, `/api/diagrams/${diagramId}`, {
      headers: { origin: ORIGIN },
    }),
  );
  const { diagram } = (await response.json()) as {
    diagram: { graphData: string; updatedAt: string };
  };
  return diagram;
}

/** One JSON-RPC 2.0 result payload, loosely typed for these assertions -- matching
 * `mcp.test.ts`'s own shape. */
interface JsonRpcEnvelope {
  jsonrpc: "2.0";
  id: number;
  result?: {
    content?: { type: "text"; text: string }[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

/** Parse a `createMcpHandler` response body into a typed JSON-RPC envelope -- see
 * `mcp.test.ts`'s own copy of this helper for why a hand-built request needs this dual-format
 * handling. */
async function jsonRpcBody(response: Response): Promise<JsonRpcEnvelope> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (contentType.includes("application/json")) {
    return JSON.parse(text);
  }
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (dataLine === undefined) {
    throw new Error(`No SSE "data:" line found in response body:\n${text}`);
  }
  return JSON.parse(dataLine.slice("data: ".length));
}

/** Call one MCP tool as `email`, matching `mcp.test.ts`'s own request shape, returning the
 * parsed diagram result. */
async function callMcpTool(
  email: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ id: string; graphData: string; updatedAt: string }> {
  const response = await request(
    await apiRequest(email, "/mcp", {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: args, name },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      method: "POST",
    }),
  );
  const envelope = await jsonRpcBody(response);
  const [content] = envelope.result?.content ?? [];
  return JSON.parse(content?.text ?? "{}");
}

/**
 * Resolve with the next frame whose `type` matches, silently ignoring any other frame -- the
 * listener is registered before the action expected to trigger it in every caller below (see
 * the `testing-durable-objects` skill), so no backlog/queueing is needed to catch a frame that
 * arrived too early.
 */
function nextMessageOfType(
  socket: WebSocket,
  type: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const handler = (event: MessageEvent) => {
      const decoded = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (decoded.type === type) {
        socket.removeEventListener("message", handler);
        resolve(decoded);
      }
    };
    socket.addEventListener("message", handler);
  });
}

/** Resolve once `count` frames of `type` have arrived, in arrival order. */
function collectMessagesOfType(
  socket: WebSocket,
  type: string,
  count: number,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const collected: Record<string, unknown>[] = [];
    const handler = (event: MessageEvent) => {
      const decoded = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (decoded.type === type) {
        collected.push(decoded);
        if (collected.length === count) {
          socket.removeEventListener("message", handler);
          resolve(collected);
        }
      }
    };
    socket.addEventListener("message", handler);
  });
}

/** Build a fixture `ReadableStream` of SSE-framed bytes for one final assistant answer -- the
 * minimal shape `src/worker/ai/chat-engine.ts`'s own `consumeSseStream()` parses
 * (docs/DECISIONS.md #10), mirroring `src/worker/ai/chat-engine.test.ts`'s own `sseStream()`
 * fixture. */
function fakeAiSseStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ response: text })}\n\n`),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

/**
 * Build a fixture Workers AI double for a real `DiagramSession` instance's own `env.AI` binding
 * (see the "AI chat (Phase 23)" describe block's own top-of-file JSDoc for why reassigning
 * `instance.env` on a live instance -- not a call-site `env` substitution -- is the one way to
 * reach it in this pool). One non-streaming, tool-calling round per entry of `toolRounds`
 * (`[]` for an organic "no more tool calls" round, matching `runDiagramChatTurn()`'s own
 * "no tool_calls returns break" contract); the turn's one final `stream: true` round always
 * resolves to `finalText`, framed as {@link fakeAiSseStream}.
 *
 * @param toolRounds One entry per non-streaming round this fixture should answer, in order.
 * @param finalText The final streamed answer's complete text.
 * @returns A plain object shaped like `ChatAiBinding` (`src/worker/ai/chat-engine.ts`) -- not
 * imported/typed as such here, matching this file's own existing convention of not importing
 * `src/worker/**` types into this project's integration tests.
 */
function fakeChatAi(
  toolRounds: { name: string; arguments: Record<string, unknown> }[][],
  finalText: string,
): { run: (...args: unknown[]) => Promise<unknown> } {
  let round = 0;
  return {
    run: async (_model: unknown, inputs: unknown): Promise<unknown> => {
      const { stream } = inputs as { stream?: boolean };
      if (stream) return fakeAiSseStream(finalText);
      const calls = toolRounds[round] ?? [];
      round += 1;
      return calls.length > 0 ? { tool_calls: calls } : { response: "" };
    },
  };
}

describe("DiagramSession / GET /api/diagrams/:id/live", () => {
  const openSockets = new Set<WebSocket>();

  beforeAll(async () => {
    const testEnv = env as TestEnv;
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  afterEach(async () => {
    for (const socket of openSockets) {
      if (
        socket.readyState !== WebSocket.CLOSED &&
        socket.readyState !== WebSocket.CLOSING
      ) {
        socket.close();
      }
    }
    openSockets.clear();
    // The one guarantee that no hibernatable socket outlives this test (see the
    // testing-durable-objects skill): a client-initiated close round trip is not reliable in
    // this pool.
    await evictAllDurableObjects({ webSockets: "close" });
  });

  /** Open an authenticated live-sync WebSocket, register it for automatic teardown, and
   * resolve once its initial `graph_snapshot` frame has arrived. */
  async function openLiveSocket(
    email: string,
    diagramId: string,
  ): Promise<{ socket: WebSocket; snapshot: Record<string, unknown> }> {
    const response = await request(
      await apiRequest(email, `/api/diagrams/${diagramId}/live`, {
        headers: { origin: ORIGIN, Upgrade: "websocket" },
      }),
    );
    const socket = response.webSocket;
    if (socket === null) {
      throw new Error(
        `Expected a WebSocket upgrade but got HTTP ${response.status}.`,
      );
    }
    openSockets.add(socket);
    const snapshot = nextMessageOfType(socket, "graph_snapshot");
    socket.accept();
    return { socket, snapshot: await snapshot };
  }

  it("rejects an unauthenticated request with a Problem Details 401", async () => {
    const diagramId = await createDiagram("alice@example.com");
    const response = await request(
      await apiRequest(undefined, `/api/diagrams/${diagramId}/live`, {
        headers: { origin: ORIGIN, Upgrade: "websocket" },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("reports a diagram neither owned nor collaborated on as not found, establishing no socket", async () => {
    const diagramId = await createDiagram("alice@example.com");
    const response = await request(
      await apiRequest(
        "mallory@example.com",
        `/api/diagrams/${diagramId}/live`,
        {
          headers: { origin: ORIGIN, Upgrade: "websocket" },
        },
      ),
    );
    expect(response.status).toBe(404);
    expect(response.webSocket).toBeNull();
  });

  it("rejects a non-upgrade request with a 400", async () => {
    const diagramId = await createDiagram("alice@example.com");
    const response = await request(
      await apiRequest("alice@example.com", `/api/diagrams/${diagramId}/live`, {
        headers: { origin: ORIGIN },
      }),
    );
    expect(response.status).toBe(400);
  });

  it("accepts the owner's authenticated WebSocket upgrade", async () => {
    const diagramId = await createDiagram("alice@example.com");
    const { socket } = await openLiveSocket("alice@example.com", diagramId);
    expect(socket).toBeDefined();
  });

  it("ctx.id.name resolves to the diagram id for a getByName()-obtained stub (Decision B sanity check)", async () => {
    const diagramId = await createDiagram("alice@example.com");

    const name = await runInDurableObject(
      env.DIAGRAM_SESSIONS.getByName(diagramId),
      (_instance, state) => state.id.name,
    );

    expect(name).toBe(diagramId);
  });

  it("DiagramSession.fetch() rejects a direct non-upgrade request with a 400 (defense in depth, redundant with the Worker's own check)", async () => {
    const diagramId = await createDiagram("alice@example.com");

    // Only plain, structured-clone-friendly values cross the `runInDurableObject` boundary (see
    // the testing-durable-objects skill) -- read the fields the assertion needs inside the
    // callback rather than returning the `Response` itself.
    const { status, hasWebSocket } = await runInDurableObject(
      env.DIAGRAM_SESSIONS.getByName(diagramId),
      async (instance) => {
        const response = await instance.fetch(
          new Request("https://diagram-session.internal/"),
        );
        return {
          hasWebSocket: response.webSocket !== null,
          status: response.status,
        };
      },
    );

    expect(status).toBe(400);
    expect(hasWebSocket).toBe(false);
  });

  // `ensureHydrated()`'s two `throw new Error(...)` edge cases (an unnamed `ctx.id.name`, or a
  // diagram deleted out from under an already-authorized request) are deliberately not exercised
  // here: `blockConcurrencyWhile()`'s callback throwing marks the whole Durable Object instance
  // "broken" at the platform level, and Miniflare separately surfaces that as its own top-level
  // "Unhandled Rejection"/`durableObjectReset` diagnostic *in addition to* properly rejecting the
  // awaited call -- unavoidable from the test side, and it fails this project's overall `vitest
  // run` exit code even though every individual assertion still passes. Both branches remain a
  // plain, clearly-worded `Error` per Decision C's own framing ("a genuine edge case that does
  // not need more elaborate handling"); this is the corresponding decision not to force an
  // automated test through a platform side effect that would make the suite red.

  it("webSocketMessage silently ignores a malformed (non-JSON) frame", async () => {
    const diagramId = await createDiagram("alice@example.com");
    const { socket } = await openLiveSocket("alice@example.com", diagramId);

    socket.send("not json");
    // Nothing to await for an intentional no-op -- confirm the object is still healthy by
    // successfully completing an ordinary RPC call afterward.
    await expect(
      env.DIAGRAM_SESSIONS.getByName(diagramId).getSnapshot(),
    ).resolves.toMatchObject({ sequence: 0 });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("webSocketMessage silently ignores a well-formed frame of a genuinely unrecognized type", async () => {
    const diagramId = await createDiagram("alice@example.com");
    const { socket } = await openLiveSocket("alice@example.com", diagramId);

    socket.send(JSON.stringify({ type: "not_a_real_frame_type", x: 1, y: 2 }));
    await expect(
      env.DIAGRAM_SESSIONS.getByName(diagramId).getSnapshot(),
    ).resolves.toMatchObject({ sequence: 0 });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("webSocketMessage silently ignores a cursor_moved frame with a non-numeric x/y", async () => {
    const diagramId = await createDiagram("alice@example.com");
    const { socket: sender } = await openLiveSocket(
      "alice@example.com",
      diagramId,
    );
    const { socket: bystander } = await openLiveSocket(
      "alice@example.com",
      diagramId,
    );

    let relayed = false;
    bystander.addEventListener("message", (event) => {
      const decoded = JSON.parse(String(event.data)) as { type?: string };
      if (decoded.type === "cursor_moved") relayed = true;
    });

    sender.send(JSON.stringify({ type: "cursor_moved", x: "nope", y: 2 }));
    // Nothing to await for an intentional no-op -- confirm the object is still healthy by
    // successfully completing an ordinary RPC call afterward.
    await env.DIAGRAM_SESSIONS.getByName(diagramId).getSnapshot();
    expect(relayed).toBe(false);
  });

  it("webSocketMessage decodes a binary (ArrayBuffer) frame identically to a string one", async () => {
    const diagramId = await createDiagram("alice@example.com");
    const { socket } = await openLiveSocket("alice@example.com", diagramId);

    const received = nextMessageOfType(socket, "operation_applied");
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        clientOpId: "binary-op",
        op: {
          input: { label: "API", position: { x: 0, y: 0 }, typeId: "worker" },
          kind: "add_node",
        },
        type: "operation",
      }),
    );
    socket.send(bytes.buffer);

    const message = await received;
    expect(message.clientOpId).toBe("binary-op");
  });

  it("ensureHydrated() hydrates safely for two concurrent, unawaited callers", async () => {
    const diagramId = await createDiagram("alice@example.com");
    const stub = env.DIAGRAM_SESSIONS.getByName(diagramId);

    // Neither call is awaited before the other starts. `blockConcurrencyWhile()` blocks every
    // other event on this object -- including a second caller's own `ensureHydrated()` call --
    // until its callback resolves, so both calls below are guaranteed to see a fully hydrated
    // object either way, never a half-loaded one.
    const [snapshot, response] = await Promise.all([
      stub.getSnapshot(),
      stub.fetch(
        new Request("https://diagram-session.internal/", {
          headers: { Upgrade: "websocket" },
        }),
      ),
    ]);
    expect(snapshot.sequence).toBe(0);
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket !== null) {
      openSockets.add(socket);
      socket.accept();
    }
  });

  it("skips a socket that is no longer open when broadcasting an operation", async () => {
    const diagramId = await createDiagram("alice@example.com");
    await openLiveSocket("alice@example.com", diagramId);
    const stub = env.DIAGRAM_SESSIONS.getByName(diagramId);

    // Close the *server*-side socket, then apply an operation in the same synchronous turn, so
    // `broadcast()`'s `readyState === OPEN` guard deterministically sees the socket already
    // leaving OPEN (CLOSING) -- a client-initiated close round trip is unreliable in this pool
    // (see the testing-durable-objects skill) and cannot guarantee this timing.
    await expect(
      runInDurableObject(stub, (instance, state) => {
        for (const serverSocket of state.getWebSockets()) {
          serverSocket.close();
        }
        return instance.applyOperation(
          {
            input: { label: "API", position: { x: 0, y: 0 }, typeId: "worker" },
            kind: "add_node",
          },
          "alice@example.com",
          "human",
        );
      }),
    ).resolves.toMatchObject({ sequence: 1 });
  });

  it("defaults a live-sync connection's identity to an empty string when the Worker forwards no identity query parameter", async () => {
    const diagramId = await createDiagram("alice@example.com");

    // Calls the real Durable Object stub's own `fetch()` directly -- exactly how
    // `../../src/worker/routes/diagrams.ts`'s route itself reaches this object, just without
    // its own `identity` query parameter forwarding -- to exercise `DiagramSession.fetch()`'s
    // `?? ""` fallback directly. A real request through the Worker route always carries
    // `identity`, but this object's own defensive default is still real, authored behavior
    // worth covering. Deliberately not `runInDurableObject()` (see the testing-durable-objects
    // skill): a WebSocket accepted that way never behaves like a normal request-dispatched one,
    // and hangs this file's `afterEach` cleanup for every later test.
    const response = await env.DIAGRAM_SESSIONS.getByName(diagramId).fetch(
      new Request("https://diagram-session.internal/", {
        headers: { Upgrade: "websocket" },
      }),
    );
    const socket = response.webSocket;
    if (socket === null) {
      throw new Error("Expected a WebSocket upgrade.");
    }
    openSockets.add(socket);
    const snapshot = nextMessageOfType(socket, "graph_snapshot");
    socket.accept();

    expect(response.status).toBe(101);
    await expect(snapshot).resolves.toMatchObject({ type: "graph_snapshot" });
  });

  it("persistGraph() falls back to a best-effort timestamp when the diagram row no longer exists to update", async () => {
    const diagramId = await createDiagram("alice@example.com");
    // Hydrate this session (reading the owner email) before the row disappears out from under
    // it -- `ensureHydrated()` only ever reads D1 once per activation.
    await env.DIAGRAM_SESSIONS.getByName(diagramId).getSnapshot();

    await request(
      await apiRequest("alice@example.com", `/api/diagrams/${diagramId}`, {
        headers: { origin: ORIGIN },
        method: "DELETE",
      }),
    );

    const result = await env.DIAGRAM_SESSIONS.getByName(
      diagramId,
    ).applyOperation(
      {
        input: { label: "API", position: { x: 0, y: 0 }, typeId: "worker" },
        kind: "add_node",
      },
      "alice@example.com",
      "human",
    );
    expect(typeof result.updatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(result.updatedAt))).toBe(false);
  });

  it("sends an immediate graph_snapshot reflecting the diagram's current D1 state on connect", async () => {
    const diagramId = await createDiagram("alice@example.com");
    await callMcpTool("alice@example.com", "add_node", {
      diagramId,
      label: "API",
      position: { x: 0, y: 0 },
      typeId: "worker",
    });

    const { snapshot } = await openLiveSocket("alice@example.com", diagramId);

    expect(snapshot.type).toBe("graph_snapshot");
    expect(JSON.parse(snapshot.graphData as string).nodes).toHaveLength(1);
    // The seeding `add_node` MCP call above already incremented `this.sequence` to 1 before
    // this connection was ever opened.
    expect(snapshot.sequence).toBe(1);
  });

  it("broadcasts operation_applied to every open connection, including the sender's own echo/ack", async () => {
    const diagramId = await createDiagram("alice@example.com");
    const { socket: tabOne } = await openLiveSocket(
      "alice@example.com",
      diagramId,
    );
    const { socket: tabTwo } = await openLiveSocket(
      "alice@example.com",
      diagramId,
    );

    const tabOneReceives = nextMessageOfType(tabOne, "operation_applied");
    const tabTwoReceives = nextMessageOfType(tabTwo, "operation_applied");

    tabOne.send(
      JSON.stringify({
        clientOpId: "client-op-1",
        op: {
          input: { label: "API", position: { x: 0, y: 0 }, typeId: "worker" },
          kind: "add_node",
        },
        type: "operation",
      }),
    );

    const [messageOne, messageTwo] = await Promise.all([
      tabOneReceives,
      tabTwoReceives,
    ]);

    expect(messageOne.origin).toBe("human");
    expect(messageOne.actorEmail).toBe("alice@example.com");
    expect(messageOne.clientOpId).toBe("client-op-1");
    expect(messageTwo.origin).toBe("human");
    expect(messageTwo.clientOpId).toBe("client-op-1");
  });

  it("an MCP tool call is visible to a connected human socket, with origin agent", async () => {
    const diagramId = await createDiagram("alice@example.com");
    const { socket } = await openLiveSocket("alice@example.com", diagramId);

    const received = nextMessageOfType(socket, "operation_applied");

    await callMcpTool("alice@example.com", "add_node", {
      diagramId,
      label: "API",
      position: { x: 0, y: 0 },
      typeId: "worker",
    });

    const message = await received;
    expect(message.origin).toBe("agent");
    expect(message.actorEmail).toBe("alice@example.com");
    expect(message.clientOpId).toBeUndefined();
  });

  it("auto_layout_diagram's applyWholeGraphReplace() broadcasts graph_snapshot, not operation_applied", async () => {
    const diagramId = await createDiagram("alice@example.com");
    await callMcpTool("alice@example.com", "add_node", {
      diagramId,
      label: "A",
      position: { x: 0, y: 0 },
      typeId: "worker",
    });
    await callMcpTool("alice@example.com", "add_node", {
      diagramId,
      label: "B",
      position: { x: 10, y: 10 },
      typeId: "worker",
    });
    const { socket } = await openLiveSocket("alice@example.com", diagramId);

    const received = nextMessageOfType(socket, "graph_snapshot");

    await callMcpTool("alice@example.com", "auto_layout_diagram", {
      diagramId,
    });

    const message = await received;
    expect(message.type).toBe("graph_snapshot");
    expect(JSON.parse(message.graphData as string).nodes).toHaveLength(2);
  });

  it("rejects an operation targeting a node another operation already removed, without closing the socket or affecting other clients", async () => {
    const diagramId = await createDiagram("alice@example.com");
    const { graphData } = await callMcpTool("alice@example.com", "add_node", {
      diagramId,
      label: "API",
      position: { x: 0, y: 0 },
      typeId: "worker",
    });
    const nodeId = (JSON.parse(graphData).nodes[0] as { id: string }).id;

    const { socket: deleter } = await openLiveSocket(
      "alice@example.com",
      diagramId,
    );
    const { socket: updater } = await openLiveSocket(
      "alice@example.com",
      diagramId,
    );
    const { socket: bystander } = await openLiveSocket(
      "alice@example.com",
      diagramId,
    );

    const deleterAck = nextMessageOfType(deleter, "operation_applied");
    deleter.send(
      JSON.stringify({
        clientOpId: "delete-op",
        op: { kind: "remove_node", nodeId },
        type: "operation",
      }),
    );
    await deleterAck;

    const rejected = nextMessageOfType(updater, "operation_rejected");
    updater.send(
      JSON.stringify({
        clientOpId: "stale-update-op",
        op: { kind: "update_node", nodeId, patch: { label: "too late" } },
        type: "operation",
      }),
    );

    const rejection = await rejected;
    expect(rejection.clientOpId).toBe("stale-update-op");
    expect(typeof rejection.reason).toBe("string");
    expect(updater.readyState).toBe(WebSocket.OPEN);

    // The bystander is unaffected: still open, and the diagram's actual state (inspected
    // directly rather than racing a timer against an absent message -- see the
    // testing-durable-objects skill) reflects only the real delete, never the rejected update.
    const finalSnapshot =
      await env.DIAGRAM_SESSIONS.getByName(diagramId).getSnapshot();
    expect(JSON.parse(finalSnapshot.graphData).nodes).toHaveLength(0);
    expect(bystander.readyState).toBe(WebSocket.OPEN);
  });

  it("two update_node operations on the same node, sent without an intervening round trip, leave exactly one deterministic winner in memory and D1", async () => {
    const diagramId = await createDiagram("alice@example.com");
    const { graphData } = await callMcpTool("alice@example.com", "add_node", {
      diagramId,
      label: "API",
      position: { x: 0, y: 0 },
      typeId: "worker",
    });
    const nodeId = (JSON.parse(graphData).nodes[0] as { id: string }).id;

    const { socket: tabA } = await openLiveSocket(
      "alice@example.com",
      diagramId,
    );
    const { socket: tabB } = await openLiveSocket(
      "alice@example.com",
      diagramId,
    );

    const applied = collectMessagesOfType(tabA, "operation_applied", 2);

    // Sent back to back, with no `await` in between -- both are in flight from this test's own
    // perspective, exactly like the Phase 16 spike's race prototype.
    tabA.send(
      JSON.stringify({
        clientOpId: "op-a",
        op: {
          kind: "update_node",
          nodeId,
          patch: { position: { x: 1, y: 1 } },
        },
        type: "operation",
      }),
    );
    tabB.send(
      JSON.stringify({
        clientOpId: "op-b",
        op: {
          kind: "update_node",
          nodeId,
          patch: { position: { x: 2, y: 2 } },
        },
        type: "operation",
      }),
    );

    const [first, second] = await applied;
    const winner =
      (first.sequence as number) > (second.sequence as number) ? first : second;
    expect(first.sequence).not.toBe(second.sequence);

    const winningPosition = (
      winner.op as { patch: { position: { x: number; y: number } } }
    ).patch.position;

    const persisted = await loadDiagram("alice@example.com", diagramId);
    const persistedNode = JSON.parse(persisted.graphData).nodes[0] as {
      position: { x: number; y: number };
    };
    expect(persistedNode.position).toEqual(winningPosition);

    const snapshot =
      await env.DIAGRAM_SESSIONS.getByName(diagramId).getSnapshot();
    const inMemoryNode = JSON.parse(snapshot.graphData).nodes[0] as {
      position: { x: number; y: number };
    };
    expect(inMemoryNode.position).toEqual(winningPosition);
  });

  it("two operations on different targets, sent without an intervening round trip, do not collide -- both survive", async () => {
    const diagramId = await createDiagram("alice@example.com");
    const { graphData } = await callMcpTool("alice@example.com", "add_node", {
      diagramId,
      label: "A",
      position: { x: 0, y: 0 },
      typeId: "worker",
    });
    const existingNodeId = (JSON.parse(graphData).nodes[0] as { id: string })
      .id;

    const { socket: tabA } = await openLiveSocket(
      "alice@example.com",
      diagramId,
    );
    const { socket: tabB } = await openLiveSocket(
      "alice@example.com",
      diagramId,
    );

    const applied = collectMessagesOfType(tabA, "operation_applied", 2);

    tabA.send(
      JSON.stringify({
        clientOpId: "op-add-node",
        op: {
          input: { label: "B", position: { x: 50, y: 50 }, typeId: "d1" },
          kind: "add_node",
        },
        type: "operation",
      }),
    );
    tabB.send(
      JSON.stringify({
        clientOpId: "op-update-node",
        op: {
          kind: "update_node",
          nodeId: existingNodeId,
          patch: { label: "Renamed" },
        },
        type: "operation",
      }),
    );

    await applied;

    const persisted = await loadDiagram("alice@example.com", diagramId);
    const nodes = JSON.parse(persisted.graphData).nodes as {
      id: string;
      data: { label: string };
    }[];
    expect(nodes).toHaveLength(2);
    expect(nodes.find((n) => n.id === existingNodeId)?.data.label).toBe(
      "Renamed",
    );
  });

  it("re-hydrates from D1 after eviction rather than starting from an empty graph", async () => {
    const diagramId = await createDiagram("alice@example.com");
    await callMcpTool("alice@example.com", "add_node", {
      diagramId,
      label: "API",
      position: { x: 0, y: 0 },
      typeId: "worker",
    });

    // Simulate a cold start: this object's in-memory `this.graph` is discarded.
    await evictAllDurableObjects();

    const snapshot =
      await env.DIAGRAM_SESSIONS.getByName(diagramId).getSnapshot();
    expect(JSON.parse(snapshot.graphData).nodes).toHaveLength(1);

    const { snapshot: connectSnapshot } = await openLiveSocket(
      "alice@example.com",
      diagramId,
    );
    expect(JSON.parse(connectSnapshot.graphData as string).nodes).toHaveLength(
      1,
    );
  });

  describe("Presence and cursors (Phase 19)", () => {
    it("a connecting client receives an accurate presence_snapshot, and the already-connected identity receives presence_joined", async () => {
      const owner = "alice-presence-1@example.com";
      const colleague = "bob-presence-1@example.com";
      const diagramId = await createDiagram(owner);
      await signIn(colleague);
      await addCollaborator(owner, diagramId, colleague);

      const { socket: ownerSocket } = await openLiveSocket(owner, diagramId);
      const joined = nextMessageOfType(ownerSocket, "presence_joined");

      const response = await request(
        await apiRequest(colleague, `/api/diagrams/${diagramId}/live`, {
          headers: { origin: ORIGIN, Upgrade: "websocket" },
        }),
      );
      const colleagueSocket = response.webSocket;
      if (colleagueSocket === null) {
        throw new Error("Expected a WebSocket upgrade.");
      }
      openSockets.add(colleagueSocket);
      const presenceSnapshot = nextMessageOfType(
        colleagueSocket,
        "presence_snapshot",
      );
      colleagueSocket.accept();

      const [joinedMessage, snapshotMessage] = await Promise.all([
        joined,
        presenceSnapshot,
      ]);

      expect(joinedMessage.type).toBe("presence_joined");
      expect(joinedMessage.email).toBe(colleague);
      expect(joinedMessage.displayName).toBeNull();
      expect(typeof joinedMessage.color).toBe("string");

      expect(snapshotMessage.type).toBe("presence_snapshot");
      const participants = snapshotMessage.participants as {
        email: string;
        displayName: string | null;
        color: string;
      }[];
      expect(participants).toHaveLength(1);
      expect(participants[0]?.email).toBe(owner);
      expect(participants[0]?.displayName).toBeNull();
      expect(typeof participants[0]?.color).toBe("string");
    });

    it("does not broadcast a second presence_joined for a second connection from an already-connected email", async () => {
      const owner = "alice-presence-2@example.com";
      const diagramId = await createDiagram(owner);

      const { socket: tabOne } = await openLiveSocket(owner, diagramId);
      let joinCount = 0;
      tabOne.addEventListener("message", (event) => {
        const decoded = JSON.parse(String(event.data)) as { type?: string };
        if (decoded.type === "presence_joined") joinCount += 1;
      });

      await openLiveSocket(owner, diagramId);
      // Barrier: an ordinary RPC call completing confirms the second connection's own
      // `fetch()` handler (including any `presence_joined` broadcast it might have sent) has
      // already fully run, since this object processes events one at a time.
      await env.DIAGRAM_SESSIONS.getByName(diagramId).getSnapshot();

      expect(joinCount).toBe(0);
    });

    it("does not broadcast presence_left while another connection for the same email remains open", async () => {
      const owner = "alice-presence-3@example.com";
      const colleague = "bob-presence-3@example.com";
      const diagramId = await createDiagram(owner);
      await signIn(colleague);
      await addCollaborator(owner, diagramId, colleague);

      const { socket: bystander } = await openLiveSocket(colleague, diagramId);
      await openLiveSocket(owner, diagramId);
      const { socket: tabTwo } = await openLiveSocket(owner, diagramId);

      let presenceLeftReceived = false;
      bystander.addEventListener("message", (event) => {
        const decoded = JSON.parse(String(event.data)) as { type?: string };
        if (decoded.type === "presence_left") presenceLeftReceived = true;
      });

      // Best-effort, not awaited for its own "close" event round trip (unreliable in this
      // pool -- see the testing-durable-objects skill); this test only observes the *other*
      // (bystander) connection's own frames, never this socket's own close echo.
      tabTwo.close();
      // Barrier: opening one more connection and waiting for its own graph_snapshot means
      // every earlier-enqueued event this single-threaded object received -- including any
      // presence_left broadcast tabTwo's close might have triggered -- has already run.
      await openLiveSocket(owner, diagramId);

      expect(presenceLeftReceived).toBe(false);
    });

    it("broadcasts presence_left once the last connection for an email closes", async () => {
      const owner = "alice-presence-4@example.com";
      const colleague = "bob-presence-4@example.com";
      const diagramId = await createDiagram(owner);
      await signIn(colleague);
      await addCollaborator(owner, diagramId, colleague);

      const { socket: bystander } = await openLiveSocket(colleague, diagramId);
      const { socket: tabOne } = await openLiveSocket(owner, diagramId);

      const left = nextMessageOfType(bystander, "presence_left");
      tabOne.close();

      const message = await left;
      expect(message.email).toBe(owner);
    });

    it("relays cursor_moved to other connections with the sender's email added, never back to the sender itself", async () => {
      const diagramId = await createDiagram("alice@example.com");
      const { socket: sender } = await openLiveSocket(
        "alice@example.com",
        diagramId,
      );
      const { socket: other } = await openLiveSocket(
        "alice@example.com",
        diagramId,
      );

      let senderReceivedOwnCursor = false;
      sender.addEventListener("message", (event) => {
        const decoded = JSON.parse(String(event.data)) as { type?: string };
        if (decoded.type === "cursor_moved") senderReceivedOwnCursor = true;
      });

      const received = nextMessageOfType(other, "cursor_moved");
      sender.send(JSON.stringify({ type: "cursor_moved", x: 12, y: 34 }));

      const message = await received;
      expect(message).toMatchObject({
        email: "alice@example.com",
        type: "cursor_moved",
        x: 12,
        y: 34,
      });
      expect(senderReceivedOwnCursor).toBe(false);
    });

    it("relays selection_changed to other connections with the sender's email added, defaulting absent fields to null", async () => {
      const diagramId = await createDiagram("alice@example.com");
      const { socket: sender } = await openLiveSocket(
        "alice@example.com",
        diagramId,
      );
      const { socket: other } = await openLiveSocket(
        "alice@example.com",
        diagramId,
      );

      const received = nextMessageOfType(other, "selection_changed");
      sender.send(JSON.stringify({ nodeId: "n1", type: "selection_changed" }));

      const message = await received;
      expect(message).toMatchObject({
        edgeId: null,
        email: "alice@example.com",
        nodeId: "n1",
        type: "selection_changed",
      });
    });

    it("webSocketError broadcasts presence_left the same way webSocketClose does", async () => {
      const owner = "alice-presence-5@example.com";
      const colleague = "bob-presence-5@example.com";
      const diagramId = await createDiagram(owner);
      await signIn(colleague);
      await addCollaborator(owner, diagramId, colleague);

      const { socket: bystander } = await openLiveSocket(colleague, diagramId);
      await openLiveSocket(owner, diagramId);

      const left = nextMessageOfType(bystander, "presence_left");
      const stub = env.DIAGRAM_SESSIONS.getByName(diagramId);
      await runInDurableObject(stub, (instance, state) => {
        const ownerSocket = state
          .getWebSockets()
          .find(
            (socket) =>
              (socket.deserializeAttachment() as { email: string }).email ===
              owner,
          );
        if (ownerSocket === undefined) {
          throw new Error("Expected to find the owner's own socket.");
        }
        instance.webSocketError(ownerSocket, new Error("simulated"));
      });

      const message = await left;
      expect(message.email).toBe(owner);
    });

    it("never triggers a D1 write for cursor_moved or selection_changed frames", async () => {
      const diagramId = await createDiagram("alice@example.com");
      const before = await loadDiagram("alice@example.com", diagramId);

      const { socket } = await openLiveSocket("alice@example.com", diagramId);
      socket.send(JSON.stringify({ type: "cursor_moved", x: 1, y: 2 }));
      socket.send(JSON.stringify({ nodeId: "n1", type: "selection_changed" }));

      // Barrier: an ordinary RPC call completing confirms both frames above (processed
      // earlier in this single-threaded object's event queue) have already been handled.
      await env.DIAGRAM_SESSIONS.getByName(diagramId).getSnapshot();

      const after = await loadDiagram("alice@example.com", diagramId);
      expect(after.updatedAt).toBe(before.updatedAt);
      expect(after.graphData).toBe(before.graphData);
    });
  });

  /**
   * AI chat (docs/09D-ARCHITECT-AICHAT.md, Phase 23). **Coverage note, corrected in Phase 26**:
   * this repository's own `tests/integration/vitest.config.ts` sets `remoteBindings: false` for
   * the same reason `demos/ai-chat`'s own integration project already does (docs/DECISIONS.md #9
   * -- Workers AI has no local simulation at all, so leaving remote bindings on would need real
   * Cloudflare credentials and network access just to boot this project's tests). Phase 23's own
   * investigation found `env.AI` cannot be substituted for a real `DiagramSession` instance at
   * its *call site* the way `demos/ai-chat`'s own `tests/integration/fixtures.ts` substitutes `{
   * ...env, AI: fakeAi }` when calling `app.fetch(request, env, ctx)` directly -- that trick
   * only works there because its own tests import the Hono app module and construct `env`
   * themselves, whereas this project's `request()` helper calls
   * `exports.default.fetch(requestValue)`, and a Durable Object's bindings are resolved by the
   * Workers runtime at construction time regardless of what `env` object a caller built. That
   * finding is still correct as far as it goes, but Phase 26 found a *different*, working seam:
   * `runInDurableObject()` (used extensively elsewhere in this file, e.g. the
   * `webSocketError`/`skips a socket that is no longer open` tests above) hands back the real,
   * live class instance, not a copy -- and `this.env` is an ordinary, mutable JS property on
   * that instance (set once by the `DurableObject` base class's own constructor), not a
   * runtime-enforced read-only binding site. Reassigning `instance.env` to a copy with a fixture
   * `AI` double, once, right after opening the live socket this describe block's own tests use,
   * really does reach every later `handleChatMessage()` call's `this.env.AI` -- proven directly
   * below, in "AI chat (Phase 23) -- full turn against a fixture Workers AI double". This is a
   * genuinely different technique than the call-site substitution Phase 23 already correctly
   * ruled out, not a reversal of that finding; both are true at once, and this describe block's
   * own two tests below (an unmodified `env.AI`, which still throws
   * `"Binding AI needs to be run remotely"` in this pool) are unaffected by it. See
   * docs/DECISIONS.md for the full write-up.
   */
  describe("AI chat (Phase 23)", () => {
    it("recognizes a chat_message frame and reports chat_error, without crashing the connection, when env.AI is unavailable", async () => {
      const diagramId = await createDiagram("alice@example.com");
      const { socket } = await openLiveSocket("alice@example.com", diagramId);

      const error = nextMessageOfType(socket, "chat_error");
      socket.send(
        JSON.stringify({
          clientRequestId: "chat-req-1",
          text: "Add a Worker node.",
          type: "chat_message",
        }),
      );

      const message = await error;
      expect(message.clientRequestId).toBe("chat-req-1");
      expect(typeof message.message).toBe("string");
      expect(socket.readyState).toBe(WebSocket.OPEN);
    });

    it("leaves the diagram's graph unchanged and the object otherwise healthy after a failed chat turn", async () => {
      const diagramId = await createDiagram("alice@example.com");
      const { socket } = await openLiveSocket("alice@example.com", diagramId);
      const before = await loadDiagram("alice@example.com", diagramId);

      const error = nextMessageOfType(socket, "chat_error");
      socket.send(
        JSON.stringify({
          clientRequestId: "chat-req-2",
          text: "Add a Worker node.",
          type: "chat_message",
        }),
      );
      await error;

      const after = await loadDiagram("alice@example.com", diagramId);
      expect(after.graphData).toBe(before.graphData);
      expect(after.updatedAt).toBe(before.updatedAt);

      // The object itself is still healthy: an ordinary operation frame still applies and
      // broadcasts normally after the failed chat turn.
      const applied = nextMessageOfType(socket, "operation_applied");
      socket.send(
        JSON.stringify({
          clientOpId: "post-chat-op",
          op: {
            input: { label: "API", position: { x: 0, y: 0 }, typeId: "worker" },
            kind: "add_node",
          },
          type: "operation",
        }),
      );
      const appliedMessage = await applied;
      expect(appliedMessage.origin).toBe("human");
    });
  });

  /**
   * Full turn, end-to-end, against a fixture Workers AI double substituted directly onto the
   * live `DiagramSession` instance (docs/DECISIONS.md's Phase 26 write-up; see the "AI chat
   * (Phase 23)" describe block's own top-of-file JSDoc for why this is a different, working
   * technique than the call-site `env` substitution Phase 23 already correctly ruled out).
   * Closes the `handleChatMessage()` success-path coverage gap Phase 23 left open
   * (docs/DECISIONS.md #36) for everything except the `search_cloudflare_documentation`
   * tool's own `onDocsLookup` callback, which is deliberately still not exercised here -- see
   * that one test's own comment below for why.
   */
  describe("AI chat (Phase 26) -- full turn against a fixture Workers AI double", () => {
    it("runs add_node and rename_diagram tool calls, streams a final answer, and broadcasts operation_applied/diagram_renamed with origin ai-chat to every connection", async () => {
      const diagramId = await createDiagram("alice@example.com");
      const { socket: originator } = await openLiveSocket(
        "alice@example.com",
        diagramId,
      );
      const { socket: bystander } = await openLiveSocket(
        "alice@example.com",
        diagramId,
      );

      const stub = env.DIAGRAM_SESSIONS.getByName(diagramId);
      await runInDurableObject(stub, (instance) => {
        // Reaching a real Durable Object instance's own `env` property to substitute a fixture
        // `AI` binding -- see this describe block's own top-of-file JSDoc.
        // biome-ignore lint/suspicious/noExplicitAny: see the comment above.
        const target = instance as any;
        target.env = {
          ...target.env,
          AI: fakeChatAi(
            [
              [
                {
                  arguments: { label: "API", typeId: "worker" },
                  name: "add_node",
                },
                {
                  arguments: { title: "Game Backend" },
                  name: "rename_diagram",
                },
              ],
            ],
            "I added a Worker node and renamed the diagram.",
          ),
        };
      });

      const status = nextMessageOfType(originator, "chat_status");
      const applied = nextMessageOfType(originator, "operation_applied");
      const bystanderApplied = nextMessageOfType(
        bystander,
        "operation_applied",
      );
      const renamed = nextMessageOfType(bystander, "diagram_renamed");
      const token = nextMessageOfType(originator, "chat_token");
      const done = nextMessageOfType(originator, "chat_done");

      originator.send(
        JSON.stringify({
          clientRequestId: "gen-1",
          text: "Add a Worker and rename the diagram.",
          type: "chat_message",
        }),
      );

      const [
        statusMessage,
        appliedMessage,
        bystanderAppliedMessage,
        renamedMessage,
        tokenMessage,
        doneMessage,
      ] = await Promise.all([
        status,
        applied,
        bystanderApplied,
        renamed,
        token,
        done,
      ]);

      expect(statusMessage.message).toBe('Adding node "API"…');
      expect(appliedMessage.origin).toBe("ai-chat");
      expect(appliedMessage.actorEmail).toBe("alice@example.com");
      expect(bystanderAppliedMessage.origin).toBe("ai-chat");
      expect(renamedMessage.title).toBe("Game Backend");
      expect(tokenMessage.text).toBe(
        "I added a Worker node and renamed the diagram.",
      );
      expect(doneMessage.assistantText).toBe(
        "I added a Worker node and renamed the diagram.",
      );
      expect(doneMessage.clientRequestId).toBe("gen-1");

      const snapshot = await stub.getSnapshot();
      expect(JSON.parse(snapshot.graphData).nodes).toHaveLength(1);
    });

    it("feeds a rejected mutation's reason back to the model as a tool result rather than failing the turn, and never broadcasts operation_applied for it", async () => {
      const diagramId = await createDiagram("alice@example.com");
      const { socket } = await openLiveSocket("alice@example.com", diagramId);
      const stub = env.DIAGRAM_SESSIONS.getByName(diagramId);

      await runInDurableObject(stub, (instance) => {
        // biome-ignore lint/suspicious/noExplicitAny: see the previous test's own comment.
        const target = instance as any;
        target.env = {
          ...target.env,
          AI: fakeChatAi(
            [
              [
                {
                  arguments: { label: "x", nodeId: "does-not-exist" },
                  name: "update_node",
                },
              ],
            ],
            "I could not find that node.",
          ),
        };
      });

      let sawOperationApplied = false;
      socket.addEventListener("message", (event) => {
        const decoded = JSON.parse(String(event.data)) as { type?: string };
        if (decoded.type === "operation_applied") sawOperationApplied = true;
      });

      const done = nextMessageOfType(socket, "chat_done");
      socket.send(
        JSON.stringify({
          clientRequestId: "reject-1",
          text: "Rename node does-not-exist.",
          type: "chat_message",
        }),
      );

      const message = await done;
      expect(message.assistantText).toBe("I could not find that node.");
      expect(sawOperationApplied).toBe(false);
    });

    // `search_cloudflare_documentation`'s own `onDocsLookup` closure (the `chat_tool_result`
    // frame `handleChatMessage()` sends) is deliberately not exercised in this describe block,
    // even though the `instance.env` substitution above could technically let a tool call reach
    // it: `../ai/docs-client.ts` has no injection seam of its own (its target URL is a literal,
    // and its `Client`/`StreamableHTTPClientTransport` open a real outbound connection every
    // call) and `vi.mock()` cannot reach code executing inside this pool's own workerd isolate
    // the way it reaches this file's own top-level imports -- so making the model call this
    // tool here would mean a real, unmocked network round trip to
    // `https://docs.mcp.cloudflare.com/mcp` on every `test:integration`/`test:coverage` run,
    // exactly the "needs real network access just to boot this project's tests" problem this
    // project's `remoteBindings: false` (docs/DECISIONS.md #9) already exists to avoid for the
    // `AI` binding itself. `onDocsLookup`'s own two-line body (surfacing `outcome.ok`/
    // `outcome.message` into a `chat_tool_result` frame) is trivial pass-through with no branch
    // of its own worth a real network dependency to reach; `../ai/chat-engine.test.ts` already
    // covers `executeToolCall()`'s own `search_cloudflare_documentation` dispatch (both the
    // `ok`/failure outcomes) against a mocked `searchCloudflareDocumentationSafe`, and
    // `../ai/docs-client.test.ts` already covers the real parsing/timeout/failure logic
    // `onDocsLookup` merely relays. This is the one remaining, deliberately accepted coverage
    // gap in `diagram-session.ts` from this document's own scope, matching docs/DECISIONS.md
    // #34's rigor for `ensureHydrated()`'s two pre-existing throw branches.
  });
});
