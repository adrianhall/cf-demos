/**
 * @file Phase 4 integration coverage: live cooperative editing over the real
 * `/api/diagrams/:id/ws` upgrade route and `DiagramRoom`'s hibernatable WebSocket handling.
 *
 * Follows the exact cleanup recipe documented in the `testing-durable-objects` skill and
 * measured in `spikes/07-architect-collaboration/REPORT.md`: every test file that opens real
 * WebSockets sets `fileParallelism: false` (`./vitest.config.ts`, project-wide already), every
 * socket a test opens is tracked and closed best-effort (never awaited) in `afterEach`, and
 * `evictAllDurableObjects({ webSockets: "close" })` is the one unconditional guarantee that no
 * socket outlives a test. Assertions that need to prove something did *not* happen (cursor
 * transience, room isolation) inspect Durable Object SQLite storage directly with
 * `runInDurableObject` instead of racing a message against a timer.
 */
import {
  applyD1Migrations,
  evictAllDurableObjects,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { JWT_HEADER, signDevJwt } from "@adrianhall/cloudflare-toolkit/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/** Bind the generated Worker configuration to the Workers integration runtime. */
declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

/** Test-only D1 migrations binding injected by `./vitest.config.ts`. */
interface TestEnv extends Env {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/** A diagram, as returned by the diagrams API. */
interface DiagramResponse {
  id: string;
  ownerEmail: string;
  title: string;
}

/** Build and send an authenticated request against the real Worker, matching production shape. */
async function authenticatedRequest(
  path: string,
  options: {
    body?: unknown;
    email?: string;
    method?: string;
    origin?: string | null;
  } = {},
): Promise<Response> {
  const {
    body,
    email = "owner@example.com",
    method = "GET",
    origin = "http://example.test",
  } = options;
  const token = await signDevJwt(email);
  const headers = new Headers({ [JWT_HEADER]: token });
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (method !== "GET" && method !== "HEAD" && origin !== null) {
    headers.set("origin", origin);
  }
  return exports.default.fetch(
    new Request(`http://example.test${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers,
      method,
    }),
  );
}

/** Create a diagram (seeded at revision 1 by its starter blueprint) and return its directory record. */
async function createDiagram(
  title: string,
  email: string,
): Promise<DiagramResponse> {
  const response = await authenticatedRequest("/api/diagrams", {
    body: { title },
    email,
    method: "POST",
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { diagram: DiagramResponse };
  return body.diagram;
}

/** Invite and redeem, granting `editorEmail` durable editor membership on `diagramId`. */
async function addEditor(
  diagramId: string,
  ownerEmail: string,
  editorEmail: string,
): Promise<void> {
  const invited = await authenticatedRequest(
    `/api/diagrams/${diagramId}/invitations`,
    {
      body: {},
      email: ownerEmail,
      method: "POST",
    },
  );
  expect(invited.status).toBe(201);
  const { token } = (await invited.json()) as { token: string };
  const redeemed = await authenticatedRequest("/api/invitations/redeem", {
    body: { token },
    email: editorEmail,
    method: "POST",
  });
  expect(redeemed.status).toBe(200);
}

/** Add a minimal, valid `add_node` operation frame body for one test's throwaway node id. */
function addNodeOperation(
  operationId: string,
  baseRevision: number,
  nodeId: string,
) {
  return {
    operationId,
    baseRevision,
    kind: "add_node",
    payload: {
      node: {
        id: nodeId,
        type: "actor",
        position: { x: 0, y: 0 },
        data: { kind: "external-actor", label: nodeId },
      },
    },
  };
}

/** Plain, `runInDurableObject`-safe snapshot of one room's persisted revision/operation count. */
function inspectRoom(
  diagramId: string,
): Promise<{ revision: number; operationCount: number }> {
  return runInDurableObject(
    env.DIAGRAM_ROOM.getByName(diagramId),
    (_instance, state) => {
      const document = state.storage.sql
        .exec<{ revision: number }>(
          "SELECT revision FROM document_state WHERE id = 1",
        )
        .one();
      const operationCount = state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM operations")
        .one().count;
      return { revision: document.revision, operationCount };
    },
  );
}

describe("Phase 4 live cooperative editing", () => {
  const openSockets = new Set<WebSocket>();

  beforeAll(async () => {
    const testEnv = env as TestEnv;
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  afterEach(async () => {
    // Best-effort, un-awaited: never depend on a client-initiated close round trip completing
    // (testing-durable-objects skill, rule 3). evictAllDurableObjects is the one guarantee that
    // no socket outlives this test.
    for (const socket of openSockets) {
      if (
        socket.readyState !== WebSocket.CLOSED &&
        socket.readyState !== WebSocket.CLOSING
      ) {
        socket.close();
      }
    }
    openSockets.clear();
    await evictAllDurableObjects({ webSockets: "close" });
  });

  /**
   * Resolve with the next frame whose `type` matches, silently ignoring any other frame (a
   * presence/cursor broadcast that is not the one under test). Callers must register this
   * listener before performing the action expected to trigger the frame.
   */
  function nextFrame(
    socket: WebSocket,
    type: string,
    predicate: (frame: Record<string, unknown>) => boolean = () => true,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const listener = (event: MessageEvent) => {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (frame.type === type && predicate(frame)) {
          socket.removeEventListener("message", listener);
          resolve(frame);
        }
      };
      socket.addEventListener("message", listener);
    });
  }

  /** Resolve with the next `CloseEvent` on a socket — safe to await only for a *server*-initiated close. */
  function nextClose(socket: WebSocket): Promise<CloseEvent> {
    return new Promise((resolve) => {
      socket.addEventListener("close", (event) => resolve(event), {
        once: true,
      });
    });
  }

  /**
   * Open an authenticated diagram WebSocket through the real Worker route, register it for
   * automatic teardown, and resolve once its initial `sync` frame has arrived.
   */
  async function openDiagramSocket(
    diagramId: string,
    email: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ socket: WebSocket; sync: Record<string, unknown> }> {
    const token = await signDevJwt(email);
    const response = await exports.default.fetch(
      new Request(`http://example.test/api/diagrams/${diagramId}/ws`, {
        headers: {
          [JWT_HEADER]: token,
          Origin: "http://example.test",
          Upgrade: "websocket",
          ...extraHeaders,
        },
      }),
    );
    if (!response.webSocket) {
      throw new Error(
        `Expected a WebSocket upgrade for diagram "${diagramId}" but got HTTP ${response.status}.`,
      );
    }
    const socket = response.webSocket;
    openSockets.add(socket);
    const sync = nextFrame(socket, "sync");
    socket.accept();
    return { socket, sync: await sync };
  }

  it("lets a member connect and see the diagram's current revision and participants", async () => {
    const diagram = await createDiagram("Sync test", "owner-a@example.com");
    const { sync } = await openDiagramSocket(diagram.id, "owner-a@example.com");
    expect(sync).toMatchObject({
      revision: 1,
      participants: [{ email: "owner-a@example.com", role: "owner" }],
    });
  });

  it("broadcasts participant_joined (with the verified role) to an already-connected member", async () => {
    const diagram = await createDiagram("Presence test", "owner-b@example.com");
    await addEditor(diagram.id, "owner-b@example.com", "editor-b@example.com");

    const owner = await openDiagramSocket(diagram.id, "owner-b@example.com");
    openSockets.add(owner.socket);
    const joined = nextFrame(owner.socket, "participant_joined");
    const editor = await openDiagramSocket(diagram.id, "editor-b@example.com");
    openSockets.add(editor.socket);

    await expect(joined).resolves.toMatchObject({
      participant: { email: "editor-b@example.com", role: "editor" },
      participants: expect.arrayContaining([
        { email: "owner-b@example.com", role: "owner" },
        { email: "editor-b@example.com", role: "editor" },
      ]),
    });
  });

  it("broadcasts an accepted edit to every connected participant, converging on one revision", async () => {
    const diagram = await createDiagram(
      "Broadcast test",
      "owner-c@example.com",
    );
    await addEditor(diagram.id, "owner-c@example.com", "editor-c@example.com");
    const owner = await openDiagramSocket(diagram.id, "owner-c@example.com");
    const editor = await openDiagramSocket(diagram.id, "editor-c@example.com");
    openSockets.add(owner.socket);
    openSockets.add(editor.socket);

    const ownerSees = nextFrame(owner.socket, "operation_accepted");
    const editorSees = nextFrame(editor.socket, "operation_accepted");
    editor.socket.send(
      JSON.stringify({
        type: "operation",
        operation: addNodeOperation("add-from-editor", 1, "actor-1"),
      }),
    );

    const expected = {
      operationId: "add-from-editor",
      revision: 2,
      duplicate: false,
    };
    await expect(ownerSees).resolves.toMatchObject(expected);
    await expect(editorSees).resolves.toMatchObject(expected);
    await expect(inspectRoom(diagram.id)).resolves.toMatchObject({
      revision: 2,
      operationCount: 2,
    });
  });

  it("resolves a concurrent stale edit with exactly one acceptance and one resync, never two accepted", async () => {
    const diagram = await createDiagram(
      "Concurrent edit test",
      "owner-d@example.com",
    );
    await addEditor(diagram.id, "owner-d@example.com", "editor-d@example.com");
    const owner = await openDiagramSocket(diagram.id, "owner-d@example.com");
    const editor = await openDiagramSocket(diagram.id, "editor-d@example.com");
    openSockets.add(owner.socket);
    openSockets.add(editor.socket);

    const ownerAccepted = nextFrame(owner.socket, "operation_accepted");
    const editorResync = nextFrame(editor.socket, "resync");
    owner.socket.send(
      JSON.stringify({
        type: "operation",
        operation: addNodeOperation("owner-add", 1, "actor-owner"),
      }),
    );
    editor.socket.send(
      JSON.stringify({
        type: "operation",
        operation: addNodeOperation("editor-add", 1, "actor-editor"),
      }),
    );

    await expect(ownerAccepted).resolves.toMatchObject({
      operationId: "owner-add",
      revision: 2,
      duplicate: false,
    });
    await expect(editorResync).resolves.toMatchObject({ revision: 2 });
    // Never two accepted: exactly one row was inserted beyond the seed replace_document operation.
    await expect(inspectRoom(diagram.id)).resolves.toMatchObject({
      revision: 2,
      operationCount: 2,
    });
  });

  it("treats a duplicate operationId retry as harmless and does not apply it twice", async () => {
    const diagram = await createDiagram(
      "Duplicate retry test",
      "owner-e@example.com",
    );
    const { socket } = await openDiagramSocket(
      diagram.id,
      "owner-e@example.com",
    );

    const accepted = nextFrame(socket, "operation_accepted");
    socket.send(
      JSON.stringify({
        type: "operation",
        operation: addNodeOperation("retry-me", 1, "actor-once"),
      }),
    );
    await expect(accepted).resolves.toMatchObject({
      revision: 2,
      duplicate: false,
    });

    const duplicate = nextFrame(socket, "operation_accepted");
    // Retried with a different (now-stale) baseRevision and a different payload — a genuine
    // client retry after a dropped acknowledgement would not know the accepted revision either.
    socket.send(
      JSON.stringify({
        type: "operation",
        operation: addNodeOperation("retry-me", 1, "actor-once-different"),
      }),
    );
    await expect(duplicate).resolves.toMatchObject({
      operationId: "retry-me",
      revision: 2,
      duplicate: true,
    });
    await expect(inspectRoom(diagram.id)).resolves.toMatchObject({
      revision: 2,
      operationCount: 2,
    });
  });

  it("rejects a well-formed but invalid operation, notifying only the sender and persisting nothing", async () => {
    const diagram = await createDiagram(
      "Rejection test",
      "owner-f@example.com",
    );
    const { socket } = await openDiagramSocket(
      diagram.id,
      "owner-f@example.com",
    );

    const before = await inspectRoom(diagram.id);
    const rejected = nextFrame(socket, "operation_rejected");
    socket.send(
      JSON.stringify({
        type: "operation",
        operation: {
          operationId: "move-unknown",
          baseRevision: 1,
          kind: "move_node",
          payload: { nodeId: "does-not-exist", position: { x: 1, y: 1 } },
        },
      }),
    );
    await expect(rejected).resolves.toMatchObject({
      operationId: "move-unknown",
    });
    await expect(inspectRoom(diagram.id)).resolves.toEqual(before);
  });

  it("keeps cursor broadcasts transient, rate-limited, and excluded from every persisted room", async () => {
    const diagram = await createDiagram("Cursor test", "owner-g@example.com");
    await addEditor(diagram.id, "owner-g@example.com", "editor-g@example.com");
    const owner = await openDiagramSocket(diagram.id, "owner-g@example.com");
    const editor = await openDiagramSocket(diagram.id, "editor-g@example.com");
    openSockets.add(owner.socket);
    openSockets.add(editor.socket);

    const before = await inspectRoom(diagram.id);

    const first = nextFrame(editor.socket, "cursor");
    owner.socket.send(
      JSON.stringify({
        type: "cursor",
        x: 10,
        y: 20,
        selection: { kind: "node", id: "a" },
      }),
    );
    await expect(first).resolves.toMatchObject({
      email: "owner-g@example.com",
      role: "owner",
      x: 10,
      y: 20,
      selection: { kind: "node", id: "a" },
    });

    // Sent immediately after, well within the 50ms rate-limit window: this must be silently
    // dropped rather than queued, so the *next* cursor frame `editor` ever receives — even after
    // waiting past the window — is the third send below, never this one.
    owner.socket.send(
      JSON.stringify({ type: "cursor", x: 11, y: 21, selection: null }),
    );

    await new Promise((resolve) => setTimeout(resolve, 80));
    const third = nextFrame(editor.socket, "cursor");
    owner.socket.send(
      JSON.stringify({ type: "cursor", x: 30, y: 40, selection: null }),
    );
    await expect(third).resolves.toMatchObject({ x: 30, y: 40 });

    // Storage inspection, not a timer race, proves cursor frames never touch persisted state
    // (testing-durable-objects skill, rule 4).
    await expect(inspectRoom(diagram.id)).resolves.toEqual(before);
  });

  it("closes the socket with 4400 on a malformed collaboration frame", async () => {
    const diagram = await createDiagram(
      "Malformed frame test",
      "owner-h@example.com",
    );
    const { socket } = await openDiagramSocket(
      diagram.id,
      "owner-h@example.com",
    );

    const closed = nextClose(socket);
    socket.send("not valid json");
    await expect(closed).resolves.toMatchObject({ code: 4400 });
  });

  it("closes the socket with 4400 on a well-formed-but-unsupported frame type", async () => {
    const diagram = await createDiagram(
      "Unsupported frame test",
      "owner-i@example.com",
    );
    const { socket } = await openDiagramSocket(
      diagram.id,
      "owner-i@example.com",
    );

    const closed = nextClose(socket);
    socket.send(JSON.stringify({ type: "not-a-real-frame" }));
    await expect(closed).resolves.toMatchObject({ code: 4400 });
  });

  it("rejects a non-member's WebSocket upgrade with 404, never reaching DiagramRoom", async () => {
    const diagram = await createDiagram(
      "Locked diagram",
      "owner-j@example.com",
    );
    const token = await signDevJwt("outsider@example.com");
    const response = await exports.default.fetch(
      new Request(`http://example.test/api/diagrams/${diagram.id}/ws`, {
        headers: {
          [JWT_HEADER]: token,
          Origin: "http://example.test",
          Upgrade: "websocket",
        },
      }),
    );
    expect(response.status).toBe(404);
    expect(response.webSocket).toBeNull();
  });

  it("rejects an upgrade with a missing or foreign Origin", async () => {
    const diagram = await createDiagram("Origin test", "owner-k@example.com");
    const token = await signDevJwt("owner-k@example.com");

    const foreign = await exports.default.fetch(
      new Request(`http://example.test/api/diagrams/${diagram.id}/ws`, {
        headers: {
          [JWT_HEADER]: token,
          Origin: "http://attacker.test",
          Upgrade: "websocket",
        },
      }),
    );
    expect(foreign.status).toBe(403);

    const missing = await exports.default.fetch(
      new Request(`http://example.test/api/diagrams/${diagram.id}/ws`, {
        headers: { [JWT_HEADER]: token, Upgrade: "websocket" },
      }),
    );
    expect(missing.status).toBe(403);
  });

  it("rejects a same-origin request that is not actually a WebSocket upgrade", async () => {
    const diagram = await createDiagram(
      "Non-upgrade test",
      "owner-l@example.com",
    );
    const token = await signDevJwt("owner-l@example.com");
    // `authenticatedRequest()` deliberately never sets an Origin header for a `GET` (it matches
    // `requireSameOriginMutation`'s own safe-method bypass for every other route), so this route
    // needs its own explicit Origin to reach the "was this actually an upgrade?" check at all.
    const response = await exports.default.fetch(
      new Request(`http://example.test/api/diagrams/${diagram.id}/ws`, {
        headers: { [JWT_HEADER]: token, Origin: "http://example.test" },
      }),
    );
    expect(response.status).toBe(400);
  });

  it("keeps two different diagrams' rooms fully isolated", async () => {
    const diagramA = await createDiagram("Room A", "owner-m@example.com");
    const diagramB = await createDiagram("Room B", "owner-m@example.com");
    const { socket } = await openDiagramSocket(
      diagramA.id,
      "owner-m@example.com",
    );

    const accepted = nextFrame(socket, "operation_accepted");
    socket.send(
      JSON.stringify({
        type: "operation",
        operation: addNodeOperation("only-in-a", 1, "actor-a"),
      }),
    );
    await accepted;

    await expect(inspectRoom(diagramA.id)).resolves.toMatchObject({
      revision: 2,
      operationCount: 2,
    });
    await expect(inspectRoom(diagramB.id)).resolves.toMatchObject({
      revision: 1,
      operationCount: 1,
    });
  });

  it("persists an accepted edit through eviction, and a fresh connection sees the correct revision", async () => {
    const diagram = await createDiagram(
      "Eviction survival test",
      "owner-n@example.com",
    );
    const { socket } = await openDiagramSocket(
      diagram.id,
      "owner-n@example.com",
    );

    const accepted = nextFrame(socket, "operation_accepted");
    socket.send(
      JSON.stringify({
        type: "operation",
        operation: addNodeOperation("before-eviction", 1, "actor-n"),
      }),
    );
    await expect(accepted).resolves.toMatchObject({ revision: 2 });

    await evictAllDurableObjects({ webSockets: "close" });

    const reconnect = await openDiagramSocket(
      diagram.id,
      "owner-n@example.com",
    );
    openSockets.add(reconnect.socket);
    expect(reconnect.sync).toMatchObject({ revision: 2 });
    expect(
      (
        reconnect.sync as { document: { nodes: Array<{ id: string }> } }
      ).document.nodes.map((node) => node.id),
    ).toEqual(["actor-n"]);
  });

  it("updates the diagram directory's updated_at after an edit submitted only over WebSocket", async () => {
    const diagram = await createDiagram(
      "Directory touch test",
      "owner-o@example.com",
    );
    const before = await env.DB.prepare(
      "SELECT updated_at FROM diagrams WHERE id = ?",
    )
      .bind(diagram.id)
      .first<{ updated_at: string }>();

    const { socket } = await openDiagramSocket(
      diagram.id,
      "owner-o@example.com",
    );
    const accepted = nextFrame(socket, "operation_accepted");
    socket.send(
      JSON.stringify({
        type: "operation",
        operation: addNodeOperation("touch-directory", 1, "actor-o"),
      }),
    );
    await accepted;

    const after = await env.DB.prepare(
      "SELECT updated_at FROM diagrams WHERE id = ?",
    )
      .bind(diagram.id)
      .first<{ updated_at: string }>();
    expect(after?.updated_at).toBeDefined();
    expect(after?.updated_at).not.toBe(before?.updated_at);
  });

  it("broadcasts participant_left to remaining sockets after a disconnect", async () => {
    const diagram = await createDiagram(
      "Departure test",
      "owner-p@example.com",
    );
    await addEditor(diagram.id, "owner-p@example.com", "editor-p@example.com");
    const owner = await openDiagramSocket(diagram.id, "owner-p@example.com");
    const editor = await openDiagramSocket(diagram.id, "editor-p@example.com");
    openSockets.add(owner.socket);

    const left = nextFrame(owner.socket, "participant_left");
    editor.socket.close();
    openSockets.delete(editor.socket);
    await expect(left).resolves.toMatchObject({
      participant: { email: "editor-p@example.com", role: "editor" },
      participants: [{ email: "owner-p@example.com", role: "owner" }],
    });
  });
});
