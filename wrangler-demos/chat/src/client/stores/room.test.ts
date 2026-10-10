import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_REMOVED_CLOSE_CODE } from "../../chat-protocol";
import { useRoomStore } from "./room";

/**
 * A deterministic WebSocket test double. Real browser WebSockets connect asynchronously and
 * cannot be driven from a unit test, so this mock lets each test explicitly trigger `open`,
 * `message`, and `close` events and inspect what the store sent.
 */
class MockWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  readonly url: string;
  readonly sent: string[] = [];

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error("Cannot send while the socket is not open.");
    }
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code: 1_000 }));
  }

  /** Test helper: simulate the server completing the handshake. */
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  /** Test helper: simulate a server-sent frame. */
  simulateMessage(frame: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(frame) }),
    );
  }

  /** Test helper: simulate the server closing the connection with a given close code. */
  simulateServerClose(code: number): void {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code }));
  }
}

/** @returns The most recently constructed mock socket. */
function latestSocket(): MockWebSocket {
  const socket = MockWebSocket.instances.at(-1);
  if (socket === undefined) {
    throw new Error("Expected a WebSocket to have been constructed.");
  }
  return socket;
}

describe("useRoomStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("opens a same-origin WebSocket to the selected channel's upgrade route", () => {
    const room = useRoomStore();

    room.connect("general");

    expect(room.channel).toBe("general");
    expect(room.status).toBe("connecting");
    expect(latestSocket().url).toMatch(
      /^ws:\/\/.+\/api\/channels\/general\/ws$/,
    );
  });

  it("uses a secure wss:// socket when the page itself was loaded over https", () => {
    vi.stubGlobal("location", new URL("https://chat.example/"));
    const room = useRoomStore();

    room.connect("general");

    expect(latestSocket().url).toBe(
      "wss://chat.example/api/channels/general/ws",
    );
  });

  it("becomes connected once the socket opens, and applies the replayed history frame", () => {
    const room = useRoomStore();
    room.connect("general");
    const socket = latestSocket();

    socket.simulateOpen();
    expect(room.status).toBe("connected");

    socket.simulateMessage({
      type: "history",
      messages: [
        {
          author: "alice@example.com",
          body: "hi",
          createdAt: "2026-07-27T00:00:00.000Z",
          id: 1,
        },
      ],
    });

    expect(room.messages).toEqual([
      {
        author: "alice@example.com",
        body: "hi",
        createdAt: "2026-07-27T00:00:00.000Z",
        id: 1,
      },
    ]);
  });

  it("appends a broadcast message frame instead of replacing history", () => {
    const room = useRoomStore();
    room.connect("general");
    const socket = latestSocket();
    socket.simulateOpen();
    socket.simulateMessage({ type: "history", messages: [] });

    socket.simulateMessage({
      type: "message",
      message: {
        author: "bob@example.com",
        body: "hello",
        createdAt: "2026-07-27T00:00:01.000Z",
        id: 2,
      },
    });

    expect(room.messages).toEqual([
      {
        author: "bob@example.com",
        body: "hello",
        createdAt: "2026-07-27T00:00:01.000Z",
        id: 2,
      },
    ]);
  });

  it("updates the participant count from a presence frame", () => {
    const room = useRoomStore();
    room.connect("general");
    const socket = latestSocket();
    socket.simulateOpen();

    socket.simulateMessage({ type: "presence", participants: 3 });

    expect(room.participants).toBe(3);
  });

  it("surfaces a rejected-message error frame without closing the connection", () => {
    const room = useRoomStore();
    room.connect("general");
    const socket = latestSocket();
    socket.simulateOpen();

    socket.simulateMessage({ type: "error", detail: "Message was rejected." });

    expect(room.error).toBe("Message was rejected.");
    expect(room.status).toBe("connected");
  });

  it("sends a message body over the open socket", () => {
    const room = useRoomStore();
    room.connect("general");
    const socket = latestSocket();
    socket.simulateOpen();

    room.send("Hello, room");

    expect(socket.sent).toEqual([JSON.stringify({ body: "Hello, room" })]);
  });

  it("throws instead of sending when there is no open connection", () => {
    const room = useRoomStore();

    expect(() => room.send("Hello")).toThrow("Not connected to the channel.");
  });

  it("marks the room removed on the channel-removed close code and does not reconnect", () => {
    vi.useFakeTimers();
    const room = useRoomStore();
    room.connect("general");
    const socket = latestSocket();
    socket.simulateOpen();

    socket.simulateServerClose(CHANNEL_REMOVED_CLOSE_CODE);
    expect(room.status).toBe("removed");

    vi.advanceTimersByTime(30_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("also treats an explicit channel_removed frame as removal", () => {
    const room = useRoomStore();
    room.connect("general");
    const socket = latestSocket();
    socket.simulateOpen();

    socket.simulateMessage({ type: "channel_removed" });

    expect(room.status).toBe("removed");
  });

  it("reconnects after the initial backoff delay following a transient drop", () => {
    vi.useFakeTimers();
    const room = useRoomStore();
    room.connect("general");
    latestSocket().simulateOpen();

    latestSocket().simulateServerClose(1_006);
    expect(room.status).toBe("reconnecting");
    expect(MockWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(1_000);
    expect(MockWebSocket.instances).toHaveLength(2);
    latestSocket().simulateOpen();
    expect(room.status).toBe("connected");
  });

  it("doubles the backoff delay for each consecutive drop that never reconnects", () => {
    vi.useFakeTimers();
    const room = useRoomStore();
    room.connect("general");
    latestSocket().simulateOpen();

    // First drop: reconnects after the initial 1,000ms delay.
    latestSocket().simulateServerClose(1_006);
    vi.advanceTimersByTime(1_000);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Second drop, without ever reaching "connected" again: the delay has doubled to 2,000ms,
    // so it must not yet reconnect after only another 1,000ms.
    latestSocket().simulateServerClose(1_006);
    vi.advanceTimersByTime(1_000);
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it("resets the backoff delay to its initial value after a successful reconnect", () => {
    vi.useFakeTimers();
    const room = useRoomStore();
    room.connect("general");
    latestSocket().simulateOpen();
    latestSocket().simulateServerClose(1_006);
    vi.advanceTimersByTime(1_000);
    latestSocket().simulateOpen();

    // A second, independent drop reconnects after the initial 1,000ms delay again, proving the
    // backoff was reset by the intervening successful connection rather than continuing to grow.
    latestSocket().simulateServerClose(1_006);
    vi.advanceTimersByTime(1_000);
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it("closes and replaces the socket when switching channels, clearing prior state", () => {
    const room = useRoomStore();
    room.connect("general");
    const first = latestSocket();
    first.simulateOpen();
    first.simulateMessage({
      type: "message",
      message: {
        author: "alice@example.com",
        body: "only in general",
        createdAt: "2026-07-27T00:00:00.000Z",
        id: 1,
      },
    });
    first.simulateMessage({ type: "presence", participants: 2 });

    room.connect("random");

    expect(first.readyState).toBe(MockWebSocket.CLOSED);
    expect(room.channel).toBe("random");
    expect(room.messages).toEqual([]);
    expect(room.participants).toBe(0);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("does not reconnect a socket that a channel switch already superseded", () => {
    vi.useFakeTimers();
    const room = useRoomStore();
    room.connect("general");
    const first = latestSocket();
    first.simulateOpen();

    room.connect("random");
    expect(MockWebSocket.instances).toHaveLength(2);

    vi.advanceTimersByTime(30_000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("disconnects cleanly without scheduling a reconnect", () => {
    vi.useFakeTimers();
    const room = useRoomStore();
    room.connect("general");
    latestSocket().simulateOpen();

    room.disconnect();

    expect(room.channel).toBeNull();
    expect(room.status).toBe("idle");
    expect(room.messages).toEqual([]);
    vi.advanceTimersByTime(30_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("is a no-op when reconnecting to the channel already connected", () => {
    const room = useRoomStore();
    room.connect("general");
    latestSocket().simulateOpen();

    room.connect("general");

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("ignores a stale open event from a socket already superseded by a channel switch", () => {
    const room = useRoomStore();
    room.connect("general");
    const first = latestSocket();
    first.simulateOpen();

    room.connect("random");
    const statusBeforeStaleEvent = room.status;
    // A network-level open callback for the abandoned first socket arriving late must not
    // resurrect it as the store's active connection.
    first.simulateOpen();

    expect(room.status).toBe(statusBeforeStaleEvent);
  });

  it("ignores a stale message frame from a socket already superseded by a channel switch", () => {
    const room = useRoomStore();
    room.connect("general");
    const first = latestSocket();
    first.simulateOpen();

    room.connect("random");
    first.simulateMessage({ type: "presence", participants: 9 });

    expect(room.participants).toBe(0);
  });

  it("cancels a pending scheduled reconnect when disconnecting before it fires", () => {
    vi.useFakeTimers();
    const room = useRoomStore();
    room.connect("general");
    latestSocket().simulateOpen();
    latestSocket().simulateServerClose(1_006);
    expect(room.status).toBe("reconnecting");

    room.disconnect();
    vi.advanceTimersByTime(30_000);

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("ignores a malformed, non-JSON server frame instead of throwing", () => {
    const room = useRoomStore();
    room.connect("general");
    const socket = latestSocket();
    socket.simulateOpen();

    expect(() =>
      socket.dispatchEvent(new MessageEvent("message", { data: "not json" })),
    ).not.toThrow();
    expect(room.status).toBe("connected");
  });

  it("ignores a stale close event from a socket already superseded by a channel switch", () => {
    vi.useFakeTimers();
    const room = useRoomStore();
    room.connect("general");
    const first = latestSocket();
    first.simulateOpen();

    room.connect("random");
    // A late network error on the already-abandoned first connection must not trigger a
    // second, redundant reconnect cycle for the channel the browser has already left.
    first.simulateServerClose(1_006);
    vi.advanceTimersByTime(30_000);

    expect(MockWebSocket.instances).toHaveLength(2);
  });
});
