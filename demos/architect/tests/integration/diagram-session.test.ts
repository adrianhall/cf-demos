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

/** Call one MCP tool as `email`, matching `mcp.test.ts`'s own request shape. */
async function callMcpTool(
  email: string,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  await request(
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
}

/** Resolve with the next decoded JSON frame received on a socket. */
function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.addEventListener(
      "message",
      (event: MessageEvent) => {
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
      },
      { once: true },
    );
  });
}

describe("GET /api/diagrams/:id/live", () => {
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

  it("rejects an unauthenticated request with a Problem Details 401", async () => {
    const diagramId = await createDiagram("alice@example.com");
    const response = await request(
      await apiRequest(undefined, `/api/diagrams/${diagramId}/live`, {
        headers: { origin: ORIGIN, Upgrade: "websocket" },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("reports a diagram owned by someone else as not found, establishing no socket", async () => {
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
    const response = await request(
      await apiRequest("alice@example.com", `/api/diagrams/${diagramId}/live`, {
        headers: { origin: ORIGIN, Upgrade: "websocket" },
      }),
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).not.toBeNull();
    if (socket !== null) {
      openSockets.add(socket);
      socket.accept();
    }
  });

  it("pushes a graph_updated message to every open socket when a remote MCP tool call mutates the diagram", async () => {
    const diagramId = await createDiagram("alice@example.com");

    const openLiveSocket = async (): Promise<WebSocket> => {
      const response = await request(
        await apiRequest(
          "alice@example.com",
          `/api/diagrams/${diagramId}/live`,
          {
            headers: { origin: ORIGIN, Upgrade: "websocket" },
          },
        ),
      );
      const socket = response.webSocket;
      if (socket === null) {
        throw new Error("Expected a WebSocket upgrade.");
      }
      openSockets.add(socket);
      socket.accept();
      return socket;
    };

    // Two "browser tabs" viewing the same diagram at once.
    const tabOne = await openLiveSocket();
    const tabTwo = await openLiveSocket();

    const tabOneReceives = nextMessage(tabOne);
    const tabTwoReceives = nextMessage(tabTwo);

    await callMcpTool("alice@example.com", "add_node", {
      diagramId,
      label: "API",
      position: { x: 0, y: 0 },
      typeId: "worker",
    });

    const [messageOne, messageTwo] = await Promise.all([
      tabOneReceives,
      tabTwoReceives,
    ]);
    expect(messageOne.type).toBe("graph_updated");
    expect(messageTwo.type).toBe("graph_updated");
    expect(JSON.parse(messageOne.graphData as string).nodes).toHaveLength(1);
    expect(messageOne.updatedAt).toBe(messageTwo.updatedAt);
  });

  it("DiagramSession.fetch() rejects a direct non-upgrade request with a 400", async () => {
    const diagramId = await createDiagram("alice@example.com");

    // Only plain, structured-clone-friendly values cross the `runInDurableObject` boundary
    // (see the testing-durable-objects skill) -- read the fields the assertion needs inside the
    // callback rather than returning the `Response` itself.
    const { status, hasWebSocket } = await runInDurableObject(
      env.DIAGRAM_SESSIONS.getByName(diagramId),
      (instance) => {
        const response = instance.fetch(
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

  it("webSocketMessage, webSocketClose, and webSocketError are no-ops", async () => {
    const diagramId = await createDiagram("alice@example.com");
    const stub = env.DIAGRAM_SESSIONS.getByName(diagramId);

    await expect(
      runInDurableObject(stub, (instance) => instance.webSocketMessage()),
    ).resolves.toBeUndefined();
    await expect(
      runInDurableObject(stub, (instance) => instance.webSocketClose()),
    ).resolves.toBeUndefined();
    await expect(
      runInDurableObject(stub, (instance) => instance.webSocketError()),
    ).resolves.toBeUndefined();
  });

  it("skips a socket that is no longer open when pushing a graph update", async () => {
    const diagramId = await createDiagram("alice@example.com");
    const response = await request(
      await apiRequest("alice@example.com", `/api/diagrams/${diagramId}/live`, {
        headers: { origin: ORIGIN, Upgrade: "websocket" },
      }),
    );
    const socket = response.webSocket;
    if (socket === null) {
      throw new Error("Expected a WebSocket upgrade.");
    }
    openSockets.add(socket);
    socket.accept();

    const stub = env.DIAGRAM_SESSIONS.getByName(diagramId);

    // Close the *server*-side socket, then push in the same synchronous turn, so
    // `notifyGraphUpdated()`'s `readyState === OPEN` guard deterministically sees the socket
    // already leaving OPEN (CLOSING) -- a client-initiated close round trip is unreliable in
    // this pool (see the testing-durable-objects skill) and cannot guarantee this timing.
    await expect(
      runInDurableObject(stub, (instance, state) => {
        for (const serverSocket of state.getWebSockets()) {
          serverSocket.close();
        }
        instance.notifyGraphUpdated(
          JSON.stringify({ edges: [], nodes: [] }),
          "2026-01-01T00:00:00.000Z",
        );
      }),
    ).resolves.toBeUndefined();
  });
});
