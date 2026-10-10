import { env } from "cloudflare:workers";
import { evictAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_REMOVED_CLOSE_CODE } from "../../src/worker/chat-room/chat-room";
import {
  ALICE,
  BOB,
  authenticatedRequest,
  createChannel,
  resetChannelDirectory,
  uniqueChannelName,
} from "./fixtures";

/**
 * Exercises `ChatRoom` through the real, fully-authenticated `/api/channels/:channel/ws`
 * route rather than calling the Durable Object stub directly, so the Worker's trusted-identity
 * header handling described in docs/04-ENTERPRISE-CHAT.md is actually under test instead of
 * merely assumed.
 *
 * Lifecycle rules that keep these tests deterministic instead of flaky, chosen after this
 * suite's WebSocket tests proved unreliable under ad hoc cleanup (see docs/DECISIONS.md):
 *
 *  - Every test uses a brand-new, randomly named channel. Durable Object *storage* survives
 *    eviction — only `destroy()` erases it — so reusing a name would leak messages and
 *    participant history across tests.
 *  - Every socket a test opens is tracked. `afterEach` evicts every Durable Object with
 *    `{ webSockets: "close" }` — the documented, unconditional mechanism for forcing every
 *    hibernatable socket closed — so no test depends on the ambient client/server close
 *    handshake completing (awaiting our own outbound close proved unreliable in this pool even
 *    when the server-side close had already succeeded) and a failed assertion can never leave a
 *    hibernating socket open and block the pool from tearing down the shared runtime between
 *    test files.
 *  - Assertions that need to prove something *did not* happen (routing isolation, rejected
 *    input) inspect Durable Object SQLite storage directly with `runInDurableObject` instead of
 *    racing a WebSocket message against a timer, which is the pattern that produced hangs and
 *    "close timed out" failures during development.
 *  - This project also sets `fileParallelism: false` (see `vitest.config.ts`), matching
 *    Cloudflare's own guidance for suites whose test files share one workerd runtime and its
 *    Durable Object storage.
 */
describe("ChatRoom coordination", () => {
  const openSockets = new Set<WebSocket>();

  beforeEach(async () => {
    await resetChannelDirectory();
  });

  afterEach(async () => {
    // Requesting a close from the client side and awaiting our own close handshake proved
    // unreliable in this pool even when the server-side close had already succeeded, so
    // cleanup does not depend on that round-trip: it fires a best-effort close for tidiness,
    // then relies entirely on `evictAllDurableObjects({ webSockets: "close" })` — the
    // documented, unconditional mechanism for forcing every hibernatable socket closed — as
    // the one guarantee that no socket outlives this test.
    for (const socket of openSockets) {
      closeSocket(socket);
    }
    openSockets.clear();
    await evictAllDurableObjects({ webSockets: "close" });
  });

  /** Request a socket close without waiting for the close handshake; a no-op if already closed. */
  function closeSocket(socket: WebSocket): void {
    if (
      socket.readyState !== WebSocket.CLOSED &&
      socket.readyState !== WebSocket.CLOSING
    ) {
      socket.close();
    }
  }

  /**
   * Resolve with the next frame whose `type` matches, silently ignoring any other frame (for
   * example a presence update broadcast whenever another participant joins or leaves). The
   * listener is registered before the action that triggers the expected frame in every caller
   * below, so no backlog/queueing is needed to catch a frame that arrived too early.
   */
  function nextMessageOfType(
    socket: WebSocket,
    type: string,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const handler = (event: MessageEvent) => {
        const decoded = JSON.parse(String(event.data)) as Record<
          string,
          unknown
        >;
        if (decoded.type === type) {
          socket.removeEventListener("message", handler);
          resolve(decoded);
        }
      };
      socket.addEventListener("message", handler);
    });
  }

  /** Resolve with the next `CloseEvent` received on a socket. */
  function nextClose(socket: WebSocket): Promise<CloseEvent> {
    return new Promise((resolve) => {
      socket.addEventListener("close", (event) => resolve(event), {
        once: true,
      });
    });
  }

  /**
   * Open an authenticated room WebSocket through the real Worker route, register it for
   * automatic teardown, and resolve once its initial history frame has arrived.
   *
   * @param channel Channel name, already present in the D1 directory.
   * @param email Verified Access identity to sign a development token for.
   * @param extraHeaders Additional request headers, used to simulate a client attempting to
   *   smuggle its own `X-Chat-Identity`.
   */
  async function openChannelSocket(
    channel: string,
    email: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ socket: WebSocket; history: Record<string, unknown> }> {
    const response = await authenticatedRequest(
      `/api/channels/${channel}/ws`,
      { headers: { Upgrade: "websocket", ...extraHeaders } },
      email,
    );
    const socket = response.webSocket;
    if (socket === null) {
      throw new Error(
        `Expected a WebSocket upgrade for channel "${channel}" but got HTTP ${response.status}.`,
      );
    }
    openSockets.add(socket);
    const history = nextMessageOfType(socket, "history");
    socket.accept();
    return { socket, history: await history };
  }

  /** @returns The number of persisted messages for a channel, read directly from its SQLite store. */
  function messageCount(channel: string): Promise<number> {
    return runInDurableObject(
      env.CHAT_ROOM.getByName(channel),
      (_instance, state) => {
        return state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM messages")
          .one().count;
      },
    );
  }

  it("replays empty history to a newly joined channel", async () => {
    const channel = uniqueChannelName();
    await createChannel(channel);

    const { history } = await openChannelSocket(channel, ALICE);
    expect(history).toEqual({ type: "history", messages: [] });
  });

  it("persists a message under the verified sender identity, ignoring a client-supplied identity header", async () => {
    const channel = uniqueChannelName();
    await createChannel(channel);
    // A client attempting to smuggle another identity onto the upgrade request; the Worker
    // must strip this before forwarding to the Durable Object.
    const { socket } = await openChannelSocket(channel, ALICE, {
      "X-Chat-Identity": "mallory@example.com",
    });

    const broadcast = nextMessageOfType(socket, "message");
    socket.send(JSON.stringify({ body: "Hello from the real Alice" }));
    await expect(broadcast).resolves.toMatchObject({
      type: "message",
      message: { author: ALICE, body: "Hello from the real Alice" },
    });

    await runInDurableObject(
      env.CHAT_ROOM.getByName(channel),
      (_instance, state) => {
        const row = state.storage.sql
          .exec<{ author: string }>("SELECT author FROM messages")
          .one();
        expect(row.author).toBe(ALICE);
      },
    );
  });

  it("broadcasts a persisted message to every participant connected to the same channel", async () => {
    const channel = uniqueChannelName();
    await createChannel(channel);
    const alice = await openChannelSocket(channel, ALICE);
    const bob = await openChannelSocket(channel, BOB);

    const aliceReceives = nextMessageOfType(alice.socket, "message");
    const bobReceives = nextMessageOfType(bob.socket, "message");
    alice.socket.send(JSON.stringify({ body: "Hello, room" }));

    const expected = {
      type: "message",
      message: { author: ALICE, body: "Hello, room" },
    };
    await expect(aliceReceives).resolves.toMatchObject(expected);
    await expect(bobReceives).resolves.toMatchObject(expected);
  });

  it("keeps channels isolated: a message sent in one channel is never stored in another", async () => {
    const channelA = uniqueChannelName();
    const channelB = uniqueChannelName();
    await createChannel(channelA);
    await createChannel(channelB);
    const inChannelA = await openChannelSocket(channelA, ALICE);

    const posted = nextMessageOfType(inChannelA.socket, "message");
    inChannelA.socket.send(JSON.stringify({ body: "Only for channel A" }));
    await posted;

    expect(await messageCount(channelA)).toBe(1);
    expect(await messageCount(channelB)).toBe(0);
  });

  it("rejects a spoofed message author and an oversized body without persisting either", async () => {
    const channel = uniqueChannelName();
    await createChannel(channel);
    const { socket } = await openChannelSocket(channel, ALICE);

    const spoofRejected = nextMessageOfType(socket, "error");
    socket.send(
      JSON.stringify({ body: "Hello", author: "mallory@example.com" }),
    );
    await expect(spoofRejected).resolves.toEqual({
      type: "error",
      detail: "Message was rejected.",
    });

    const oversizeRejected = nextMessageOfType(socket, "error");
    socket.send(JSON.stringify({ body: "x".repeat(2_001) }));
    await expect(oversizeRejected).resolves.toEqual({
      type: "error",
      detail: "Message was rejected.",
    });

    expect(await messageCount(channel)).toBe(0);
  });

  it("replays persisted history to a client that disconnects and reconnects", async () => {
    const channel = uniqueChannelName();
    await createChannel(channel);
    const first = await openChannelSocket(channel, ALICE);
    const posted = nextMessageOfType(first.socket, "message");
    first.socket.send(JSON.stringify({ body: "Still here after reconnect" }));
    await posted;
    closeSocket(first.socket);

    const second = await openChannelSocket(channel, ALICE);
    expect(second.history).toMatchObject({
      type: "history",
      messages: [{ author: ALICE, body: "Still here after reconnect" }],
    });
  });

  it("destroy() notifies and disconnects every socket with the removal code and erases channel state", async () => {
    const channel = uniqueChannelName();
    await createChannel(channel);
    const { socket } = await openChannelSocket(channel, ALICE);
    const posted = nextMessageOfType(socket, "message");
    socket.send(JSON.stringify({ body: "Before removal" }));
    await posted;

    const removedNotice = nextMessageOfType(socket, "channel_removed");
    const closed = nextClose(socket);
    await env.CHAT_ROOM.getByName(channel).destroy();
    await expect(removedNotice).resolves.toEqual({ type: "channel_removed" });
    expect((await closed).code).toBe(CHANNEL_REMOVED_CLOSE_CODE);
    expect(await messageCount(channel)).toBe(0);

    // destroy() only purges Durable Object storage; the D1 directory row (created once, above)
    // is untouched, matching the Worker's own delete route ordering (state first, directory
    // row second). Rejoining the same name proves the store was freshly reinitialized empty.
    const recreated = await openChannelSocket(channel, BOB);
    expect(recreated.history).toEqual({ type: "history", messages: [] });
  });

  it("rejects a direct upgrade request missing the Worker-set identity headers", async () => {
    // The public `/api/channels/:channel/ws` route always sets these trusted headers before
    // forwarding to the Durable Object (see `src/worker/routes/rooms.ts`); this exercises
    // `ChatRoom.fetch()`'s own defensive guard against a request that bypassed the Worker
    // entirely. It deliberately never sets an `Upgrade: websocket` header on the *request* this
    // test sends: doing so (even without ever calling `acceptWebSocket`) reliably hung this
    // pool's eviction cleanup in development (see docs/DECISIONS.md). The guard's own condition
    // is still fully exercised, since a missing identity header alone already satisfies it.
    const channel = uniqueChannelName();
    await createChannel(channel);

    // Only plain, structured-clone-friendly values are returned across the `runInDurableObject`
    // boundary — returning the `Response` object itself hung this pool's eviction cleanup in
    // development (see docs/DECISIONS.md).
    const { status, hasWebSocket } = await runInDurableObject(
      env.CHAT_ROOM.getByName(channel),
      (instance) => {
        const response = instance.fetch(new Request("https://chat.internal/"));
        return {
          hasWebSocket: response.webSocket !== null,
          status: response.status,
        };
      },
    );

    expect(status).toBe(400);
    expect(hasWebSocket).toBe(false);
  });

  it("closes a socket with no attachment instead of persisting an unattributable message", async () => {
    // `serializeAttachment` always runs before `acceptWebSocket` in `fetch()`, so a socket with
    // no attachment can only arise defensively; this drives that guard directly through
    // `runInDurableObject` rather than trying to construct an un-attached real socket.
    const channel = uniqueChannelName();
    await createChannel(channel);
    const closed = vi.fn();
    const fakeSocket = {
      close: closed,
      deserializeAttachment: () => null,
    } as unknown as WebSocket;

    await runInDurableObject(env.CHAT_ROOM.getByName(channel), (instance) =>
      instance.webSocketMessage(fakeSocket, JSON.stringify({ body: "hi" })),
    );

    expect(closed).toHaveBeenCalledWith(1_011, "Missing chat identity.");
    expect(await messageCount(channel)).toBe(0);
  });

  it("skips sending a rejection frame to a socket that is no longer open", async () => {
    const channel = uniqueChannelName();
    await createChannel(channel);
    const fakeSocket = {
      deserializeAttachment: () => ({ channel, email: ALICE }),
      readyState: 3, // WebSocket.CLOSED — the socket closed before the rejection could be sent.
    } as unknown as WebSocket;

    await expect(
      runInDurableObject(env.CHAT_ROOM.getByName(channel), (instance) =>
        instance.webSocketMessage(fakeSocket, "not json"),
      ),
    ).resolves.toBeUndefined();
    expect(await messageCount(channel)).toBe(0);
  });

  it("webSocketError broadcasts an updated presence count without throwing", async () => {
    const channel = uniqueChannelName();
    await createChannel(channel);
    const fakeSocket = {
      deserializeAttachment: () => ({ channel, email: ALICE }),
    } as unknown as WebSocket;

    await expect(
      runInDurableObject(env.CHAT_ROOM.getByName(channel), (instance) =>
        instance.webSocketError(fakeSocket, new Error("connection reset")),
      ),
    ).resolves.toBeUndefined();
  });
});
