import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MALFORMED_FRAME_CLOSE_CODE,
  MISSING_TRUSTED_IDENTITY_CLOSE_CODE,
} from "../../collaboration-protocol";
import { useDiagramSocket } from "./useDiagramSocket";

/**
 * A deterministic WebSocket test double. Real browser WebSockets connect asynchronously and
 * cannot be driven from a unit test, so this mock lets each test explicitly trigger `open`,
 * `message`, and `close` events and inspect what the composable sent — mirrors
 * `demos/chat/src/client/stores/room.test.ts`'s own `MockWebSocket`.
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

describe("useDiagramSocket", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("opens a same-origin WebSocket to the diagram's upgrade route immediately", () => {
    const onFrame = vi.fn();
    const onStatusChange = vi.fn();

    useDiagramSocket("diagram-1", { onFrame, onStatusChange });

    expect(latestSocket().url).toMatch(
      /^ws:\/\/.+\/api\/diagrams\/diagram-1\/ws$/,
    );
    expect(onStatusChange).toHaveBeenCalledWith("connecting");
  });

  it("uses a secure wss:// socket when the page itself was loaded over https", () => {
    vi.stubGlobal(
      "location",
      new URL("https://architect.example/app/diagrams/d1"),
    );

    useDiagramSocket("d1", { onFrame: vi.fn(), onStatusChange: vi.fn() });

    expect(latestSocket().url).toBe(
      "wss://architect.example/api/diagrams/d1/ws",
    );
  });

  it("reports connected once the socket opens and resets the backoff delay", () => {
    const onStatusChange = vi.fn();
    useDiagramSocket("d1", { onFrame: vi.fn(), onStatusChange });

    latestSocket().simulateOpen();

    expect(onStatusChange).toHaveBeenCalledWith("connected");
  });

  it("decodes and forwards every server frame via onFrame", () => {
    const onFrame = vi.fn();
    useDiagramSocket("d1", { onFrame, onStatusChange: vi.fn() });
    const socket = latestSocket();
    socket.simulateOpen();

    socket.simulateMessage({
      type: "sync",
      revision: 1,
      document: {},
      participants: [],
    });

    expect(onFrame).toHaveBeenCalledWith({
      type: "sync",
      revision: 1,
      document: {},
      participants: [],
    });
  });

  it("ignores a malformed, non-JSON server frame instead of throwing", () => {
    const onFrame = vi.fn();
    useDiagramSocket("d1", { onFrame, onStatusChange: vi.fn() });
    const socket = latestSocket();
    socket.simulateOpen();

    expect(() =>
      socket.dispatchEvent(new MessageEvent("message", { data: "not json" })),
    ).not.toThrow();
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("sends a frame as JSON over the open socket", () => {
    const handle = useDiagramSocket("d1", {
      onFrame: vi.fn(),
      onStatusChange: vi.fn(),
    });
    const socket = latestSocket();
    socket.simulateOpen();

    handle.send({ type: "cursor", x: 1, y: 2, selection: null });

    expect(socket.sent).toEqual([
      JSON.stringify({ type: "cursor", x: 1, y: 2, selection: null }),
    ]);
  });

  it("silently drops a send attempted while not connected", () => {
    const handle = useDiagramSocket("d1", {
      onFrame: vi.fn(),
      onStatusChange: vi.fn(),
    });
    const socket = latestSocket();

    expect(() =>
      handle.send({ type: "cursor", x: 1, y: 2, selection: null }),
    ).not.toThrow();
    expect(socket.sent).toEqual([]);
  });

  it("reconnects after the initial backoff delay following a transient drop", () => {
    vi.useFakeTimers();
    const onStatusChange = vi.fn();
    useDiagramSocket("d1", { onFrame: vi.fn(), onStatusChange });
    latestSocket().simulateOpen();

    latestSocket().simulateServerClose(1_006);
    expect(onStatusChange).toHaveBeenCalledWith("reconnecting");
    expect(MockWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(1_000);
    expect(MockWebSocket.instances).toHaveLength(2);
    latestSocket().simulateOpen();
    expect(onStatusChange).toHaveBeenCalledWith("connected");
  });

  it("doubles the backoff delay for each consecutive drop that never reconnects", () => {
    vi.useFakeTimers();
    useDiagramSocket("d1", { onFrame: vi.fn(), onStatusChange: vi.fn() });
    latestSocket().simulateOpen();

    latestSocket().simulateServerClose(1_006);
    vi.advanceTimersByTime(1_000);
    expect(MockWebSocket.instances).toHaveLength(2);

    latestSocket().simulateServerClose(1_006);
    vi.advanceTimersByTime(1_000);
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it("resets the backoff delay to its initial value after a successful reconnect", () => {
    vi.useFakeTimers();
    useDiagramSocket("d1", { onFrame: vi.fn(), onStatusChange: vi.fn() });
    latestSocket().simulateOpen();
    latestSocket().simulateServerClose(1_006);
    vi.advanceTimersByTime(1_000);
    latestSocket().simulateOpen();

    latestSocket().simulateServerClose(1_006);
    vi.advanceTimersByTime(1_000);
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it("reports a distinct error status on a malformed-frame close and does not reconnect", () => {
    vi.useFakeTimers();
    const onStatusChange = vi.fn();
    useDiagramSocket("d1", { onFrame: vi.fn(), onStatusChange });
    latestSocket().simulateOpen();

    latestSocket().simulateServerClose(MALFORMED_FRAME_CLOSE_CODE);
    expect(onStatusChange).toHaveBeenCalledWith("error");

    vi.advanceTimersByTime(30_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("reports a distinct error status on a missing-trusted-identity close and does not reconnect", () => {
    vi.useFakeTimers();
    const onStatusChange = vi.fn();
    useDiagramSocket("d1", { onFrame: vi.fn(), onStatusChange });
    latestSocket().simulateOpen();

    latestSocket().simulateServerClose(MISSING_TRUSTED_IDENTITY_CLOSE_CODE);
    expect(onStatusChange).toHaveBeenCalledWith("error");

    vi.advanceTimersByTime(30_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("disconnects cleanly without scheduling a reconnect", () => {
    vi.useFakeTimers();
    const onStatusChange = vi.fn();
    const handle = useDiagramSocket("d1", { onFrame: vi.fn(), onStatusChange });
    latestSocket().simulateOpen();

    handle.disconnect();

    expect(onStatusChange).toHaveBeenCalledWith("idle");
    vi.advanceTimersByTime(30_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("cancels a pending scheduled reconnect when disconnecting before it fires", () => {
    vi.useFakeTimers();
    const handle = useDiagramSocket("d1", {
      onFrame: vi.fn(),
      onStatusChange: vi.fn(),
    });
    latestSocket().simulateOpen();
    latestSocket().simulateServerClose(1_006);

    handle.disconnect();
    vi.advanceTimersByTime(30_000);

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("ignores a stale event from a socket already superseded by a reconnect", () => {
    vi.useFakeTimers();
    const onFrame = vi.fn();
    useDiagramSocket("d1", { onFrame, onStatusChange: vi.fn() });
    const first = latestSocket();
    first.simulateOpen();
    first.simulateServerClose(1_006);
    vi.advanceTimersByTime(1_000);
    latestSocket().simulateOpen();

    // A late message on the abandoned first socket must never reach the caller.
    first.simulateMessage({
      type: "sync",
      revision: 99,
      document: {},
      participants: [],
    });

    expect(onFrame).not.toHaveBeenCalled();
  });
});
