/** @file End-to-end local workerd proof for Spike 07's collaboration protocol. */
import { env, exports } from "cloudflare:workers";
import { evictAllDurableObjects } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

/** Resolves the next matching frame, ignoring asynchronous presence/cursor noise. */
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

/** Opens a real Worker-routed socket and waits for its initial full-document sync. */
async function open(room: string, client: "alice" | "bob", spoofedEmail?: string): Promise<WebSocket> {
  const response = await exports.default.fetch(new Request(`https://spike.test/rooms/${room}`, {
    headers: { Upgrade: "websocket", "x-spike-client": client, "x-spike-trusted-email": spoofedEmail ?? "" },
  }));
  if (!response.webSocket) throw new Error(`Expected WebSocket upgrade, received ${response.status}.`);
  const socket = response.webSocket;
  const synced = nextFrame(socket, "sync");
  socket.accept();
  await synced;
  return socket;
}

/** Closes all tracked clients without depending on an unreliable client close handshake. */
function closeBestEffort(sockets: Iterable<WebSocket>): void {
  for (const socket of sockets) {
    if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close();
  }
}

describe("Spike 07 collaborative diagram room", () => {
  const sockets = new Set<WebSocket>();

  afterEach(async () => {
    closeBestEffort(sockets);
    sockets.clear();
    // This hand-written DO never calls ctx.abort(); closing client sockets is best-effort only.
    await evictAllDurableObjects({ webSockets: "close" });
  });

  it("serializes concurrent edits, resyncs stale state, persists final positions, and keeps cursors transient", async () => {
    const room = "concurrent-room";
    const alice = await open(room, "alice", "mallory@example.test");
    const bob = await open(room, "bob");
    sockets.add(alice);
    sockets.add(bob);

    const accepted = nextFrame(alice, "operation_accepted");
    const stale = nextFrame(bob, "resync");
    alice.send(JSON.stringify({ type: "operation", operation: { operationId: "move-a", baseRevision: 0, kind: "final_position", payload: { nodeId: "a", x: 20, y: 30 } } }));
    bob.send(JSON.stringify({ type: "operation", operation: { operationId: "move-b", baseRevision: 0, kind: "final_position", payload: { nodeId: "b", x: 220, y: 30 } } }));
    await expect(accepted).resolves.toMatchObject({ revision: 1, duplicate: false, operationId: "move-a" });
    await expect(stale).resolves.toMatchObject({ revision: 1, document: { nodes: expect.arrayContaining([{ id: "a", x: 20, y: 30 }]) } });

    const aliceCursor = nextFrame(alice, "cursor", (frame) => frame.email === "alice@example.test");
    const bobCursor = nextFrame(bob, "cursor", (frame) => frame.email === "bob@example.test");
    alice.send(JSON.stringify({ type: "cursor", x: 1, y: 2, selection: "a" }));
    bob.send(JSON.stringify({ type: "cursor", x: 3, y: 4, selection: "b" }));
    await expect(aliceCursor).resolves.toMatchObject({ email: "alice@example.test", x: 1, y: 2 });
    await expect(bobCursor).resolves.toMatchObject({ email: "bob@example.test", x: 3, y: 4 });

    const state = await env.DIAGRAM_ROOM.getByName(room).inspect();
    expect(state).toEqual({ revision: 1, operationCount: 1, nodes: [{ id: "a", x: 20, y: 30 }, { id: "b", x: 200, y: 0 }] });
  });

  it("preserves attachment identity through hibernation and treats a reconnect duplicate as harmless", async () => {
    const room = "reconnect-room";
    const alice = await open(room, "alice");
    sockets.add(alice);
    const initial = nextFrame(alice, "operation_accepted");
    alice.send(JSON.stringify({ type: "operation", operation: { operationId: "move-a-once", baseRevision: 0, kind: "final_position", payload: { nodeId: "a", x: 50, y: 60 } } }));
    await initial;

    await evictAllDurableObjects({ webSockets: "hibernate" });
    const afterEviction = nextFrame(alice, "cursor");
    alice.send(JSON.stringify({ type: "cursor", x: 7, y: 8 }));
    await expect(afterEviction).resolves.toMatchObject({ email: "alice@example.test", x: 7, y: 8 });

    alice.close();
    const aliceReconnect = await open(room, "alice");
    sockets.add(aliceReconnect);
    const duplicate = nextFrame(aliceReconnect, "operation_accepted");
    aliceReconnect.send(JSON.stringify({ type: "operation", operation: { operationId: "move-a-once", baseRevision: 0, kind: "final_position", payload: { nodeId: "a", x: 999, y: 999 } } }));
    await expect(duplicate).resolves.toMatchObject({ operationId: "move-a-once", revision: 1, duplicate: true });
    await expect(env.DIAGRAM_ROOM.getByName(room).inspect()).resolves.toMatchObject({ revision: 1, operationCount: 1, nodes: expect.arrayContaining([{ id: "a", x: 50, y: 60 }]) });
  });
});
