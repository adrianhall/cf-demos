import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDiagramStore } from "../stores/diagramStore";
import { useDiagramLiveSync } from "./useDiagramLiveSync";

/**
 * A deterministic WebSocket test double, mirroring `demos/chat`'s own `MockWebSocket`: real
 * browser WebSockets connect asynchronously and cannot be driven from a unit test. Extends the
 * standard `readyState`/`OPEN` constants and a recording `send()` so `sendOperation()`'s own
 * `readyState` gate and sent-frame assertions have something real to check against.
 */
class MockWebSocket extends EventTarget {
  static instances: MockWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  closed = false;
  readyState = MockWebSocket.CONNECTING;
  sentMessages: string[] = [];

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  /** Test helper: simulate the socket finishing its connection handshake. */
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  /** Test helper: simulate a server-sent frame. */
  simulateMessage(data: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: typeof data === "string" ? data : JSON.stringify(data),
      }),
    );
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

describe("useDiagramLiveSync", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    useDiagramStore.setState({
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      updatedAt: "2026-01-01T00:00:00.000Z",
      liveUpdateNotice: null,
      pendingOperations: new Map(),
      dirty: false,
      undoStack: [],
      redoStack: [],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not open a socket when disabled", () => {
    renderHook(() => useDiagramLiveSync("diagram-1", false));
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("does not open a socket before a diagram id is known", () => {
    renderHook(() => useDiagramLiveSync(null, true));
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("opens a same-origin ws(s) URL to the diagram's live-sync route when enabled", () => {
    renderHook(() => useDiagramLiveSync("diagram-1", true));

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(latestSocket().url).toContain("/api/diagrams/diagram-1/live");
  });

  it("uses a secure wss:// socket when the page itself was loaded over https", () => {
    vi.stubGlobal("location", new URL("https://architect.example/"));

    renderHook(() => useDiagramLiveSync("diagram-1", true));

    expect(latestSocket().url).toBe(
      "wss://architect.example/api/diagrams/diagram-1/live",
    );
  });

  it("reports connected once the socket's open event fires, and disconnected on close", () => {
    const { result, rerender } = renderHook(() =>
      useDiagramLiveSync("diagram-1", true),
    );
    expect(result.current.connected).toBe(false);

    act(() => latestSocket().simulateOpen());
    rerender();
    expect(result.current.connected).toBe(true);

    act(() => latestSocket().dispatchEvent(new Event("close")));
    rerender();
    expect(result.current.connected).toBe(false);
  });

  it("applies a graph_snapshot, clearing dirty/history", () => {
    renderHook(() => useDiagramLiveSync("diagram-1", true));

    latestSocket().simulateMessage({
      type: "graph_snapshot",
      graphData: JSON.stringify({
        nodes: [{ data: { label: "API", typeId: "worker" }, id: "n1" }],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      sequence: 1,
    });

    const state = useDiagramStore.getState();
    expect(state.nodes).toHaveLength(1);
    expect(state.dirty).toBe(false);
  });

  it("ignores a graph_snapshot whose sequence is older than one already seen", () => {
    renderHook(() => useDiagramLiveSync("diagram-1", true));
    const socket = latestSocket();

    socket.simulateMessage({
      type: "graph_snapshot",
      graphData: JSON.stringify({
        nodes: [{ id: "n1" }],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      sequence: 5,
    });
    socket.simulateMessage({
      type: "graph_snapshot",
      graphData: JSON.stringify({
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      sequence: 2,
    });

    expect(useDiagramStore.getState().nodes).toHaveLength(1);
  });

  it("ignores a malformed frame", () => {
    renderHook(() => useDiagramLiveSync("diagram-1", true));
    latestSocket().simulateMessage("not json");
    expect(useDiagramStore.getState().nodes).toHaveLength(0);
  });

  it("ignores a well-formed frame of a genuinely unrecognized type", () => {
    renderHook(() => useDiagramLiveSync("diagram-1", true));
    latestSocket().simulateMessage({
      type: "not_a_real_frame_type",
      x: 1,
      y: 2,
    });
    expect(useDiagramStore.getState().nodes).toHaveLength(0);
    expect(useDiagramStore.getState().liveUpdateNotice).toBeNull();
  });

  it("applies a remote operation_applied from a different actor and shows the toast", () => {
    renderHook(() => useDiagramLiveSync("diagram-1", true));

    latestSocket().simulateMessage({
      type: "operation_applied",
      actorEmail: "bob@example.com",
      op: {
        input: { label: "API", position: { x: 0, y: 0 }, typeId: "worker" },
        kind: "add_node",
      },
      origin: "human",
      sequence: 1,
    });

    const state = useDiagramStore.getState();
    expect(state.nodes).toHaveLength(1);
    expect(state.liveUpdateNotice).toEqual({
      actorEmail: "bob@example.com",
      origin: "human",
    });
  });

  it("does not re-apply an operation_applied echoing this tab's own pending clientOpId", () => {
    const { result } = renderHook(() => useDiagramLiveSync("diagram-1", true));
    act(() => latestSocket().simulateOpen());

    const sent = result.current.sendOperation(
      { kind: "remove_node", nodeId: "n1" },
      "op-1",
    );
    expect(sent).toBe(true);

    latestSocket().simulateMessage({
      type: "operation_applied",
      actorEmail: "alice@example.com",
      clientOpId: "op-1",
      op: { kind: "remove_node", nodeId: "n1" },
      origin: "human",
      sequence: 1,
    });

    // Nothing to apply -- the store's own applyRemoteOperation was never asked to remove a node
    // that never existed locally, so no toast either (own pending human echo).
    expect(useDiagramStore.getState().liveUpdateNotice).toBeNull();
  });

  it("still surfaces the toast for this tab's own echoed operation when origin is agent", () => {
    const { result } = renderHook(() => useDiagramLiveSync("diagram-1", true));
    act(() => latestSocket().simulateOpen());

    result.current.sendOperation({ kind: "remove_node", nodeId: "n1" }, "op-1");

    latestSocket().simulateMessage({
      type: "operation_applied",
      actorEmail: "alice@example.com",
      clientOpId: "op-1",
      op: { kind: "remove_node", nodeId: "n1" },
      origin: "agent",
      sequence: 1,
    });

    expect(useDiagramStore.getState().liveUpdateNotice).toEqual({
      actorEmail: "alice@example.com",
      origin: "agent",
    });
  });

  it("ignores an operation_rejected frame carrying no clientOpId", () => {
    renderHook(() => useDiagramLiveSync("diagram-1", true));

    latestSocket().simulateMessage({
      type: "operation_rejected",
      reason: "Node not found.",
    });

    expect(useDiagramStore.getState().liveUpdateNotice).toBeNull();
  });

  it("drops the pending entry on operation_rejected without showing a toast", () => {
    const { result } = renderHook(() => useDiagramLiveSync("diagram-1", true));
    act(() => latestSocket().simulateOpen());

    result.current.sendOperation({ kind: "remove_node", nodeId: "n1" }, "op-1");

    latestSocket().simulateMessage({
      type: "operation_rejected",
      clientOpId: "op-1",
      reason: "Node not found.",
    });

    expect(useDiagramStore.getState().liveUpdateNotice).toBeNull();
  });

  it("sendOperation sends a well-formed frame and returns true when connected", () => {
    const { result } = renderHook(() => useDiagramLiveSync("diagram-1", true));
    act(() => latestSocket().simulateOpen());

    const sent = result.current.sendOperation(
      { kind: "remove_node", nodeId: "n1" },
      "op-1",
    );

    expect(sent).toBe(true);
    expect(latestSocket().sentMessages).toEqual([
      JSON.stringify({
        clientOpId: "op-1",
        op: { kind: "remove_node", nodeId: "n1" },
        type: "operation",
      }),
    ]);
  });

  it("sendOperation returns false and sends nothing when not connected", () => {
    const { result } = renderHook(() => useDiagramLiveSync("diagram-1", true));

    const sent = result.current.sendOperation(
      { kind: "remove_node", nodeId: "n1" },
      "op-1",
    );

    expect(sent).toBe(false);
    expect(latestSocket().sentMessages).toHaveLength(0);
  });

  it("closes the socket on unmount", () => {
    const { unmount } = renderHook(() => useDiagramLiveSync("diagram-1", true));
    const socket = latestSocket();
    expect(socket.closed).toBe(false);
    unmount();
    expect(socket.closed).toBe(true);
  });

  it("seeds participants from presence_snapshot", () => {
    const { result, rerender } = renderHook(() =>
      useDiagramLiveSync("diagram-1", true),
    );

    latestSocket().simulateMessage({
      participants: [
        { color: "#111111", displayName: null, email: "bob@example.com" },
      ],
      type: "presence_snapshot",
    });
    rerender();

    expect(result.current.participants).toEqual({
      "bob@example.com": {
        color: "#111111",
        displayName: null,
        email: "bob@example.com",
      },
    });
  });

  it("adds a participant on presence_joined", () => {
    const { result, rerender } = renderHook(() =>
      useDiagramLiveSync("diagram-1", true),
    );

    latestSocket().simulateMessage({
      color: "#222222",
      displayName: null,
      email: "carol@example.com",
      type: "presence_joined",
    });
    rerender();

    expect(result.current.participants["carol@example.com"]).toEqual({
      color: "#222222",
      displayName: null,
      email: "carol@example.com",
    });
  });

  it("removes a participant, its cursor, and its selection on presence_left", () => {
    const { result, rerender } = renderHook(() =>
      useDiagramLiveSync("diagram-1", true),
    );
    const socket = latestSocket();

    socket.simulateMessage({
      color: "#333333",
      displayName: null,
      email: "dave@example.com",
      type: "presence_joined",
    });
    socket.simulateMessage({
      email: "dave@example.com",
      type: "cursor_moved",
      x: 5,
      y: 6,
    });
    socket.simulateMessage({
      edgeId: null,
      email: "dave@example.com",
      nodeId: "n1",
      type: "selection_changed",
    });
    rerender();
    expect(result.current.participants["dave@example.com"]).toBeDefined();
    expect(result.current.cursors["dave@example.com"]).toBeDefined();
    expect(result.current.remoteSelections["dave@example.com"]).toBeDefined();

    socket.simulateMessage({
      email: "dave@example.com",
      type: "presence_left",
    });
    rerender();

    expect(result.current.participants["dave@example.com"]).toBeUndefined();
    expect(result.current.cursors["dave@example.com"]).toBeUndefined();
    expect(result.current.remoteSelections["dave@example.com"]).toBeUndefined();
  });

  it("updates cursors on cursor_moved, keyed by email", () => {
    const { result, rerender } = renderHook(() =>
      useDiagramLiveSync("diagram-1", true),
    );

    latestSocket().simulateMessage({
      email: "erin@example.com",
      type: "cursor_moved",
      x: 42,
      y: 84,
    });
    rerender();

    expect(result.current.cursors["erin@example.com"]).toMatchObject({
      x: 42,
      y: 84,
    });
  });

  it("updates remoteSelections on selection_changed, keyed by email", () => {
    const { result, rerender } = renderHook(() =>
      useDiagramLiveSync("diagram-1", true),
    );

    latestSocket().simulateMessage({
      edgeId: null,
      email: "frank@example.com",
      nodeId: "n42",
      type: "selection_changed",
    });
    rerender();

    expect(result.current.remoteSelections["frank@example.com"]).toEqual({
      color: "#888888",
      edgeId: null,
      nodeId: "n42",
    });
  });

  it("resets participants/cursors/remoteSelections when the diagram id changes", () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useDiagramLiveSync(id, true),
      { initialProps: { id: "diagram-1" } },
    );

    latestSocket().simulateMessage({
      color: "#444444",
      displayName: null,
      email: "grace@example.com",
      type: "presence_joined",
    });
    rerender({ id: "diagram-1" });
    expect(result.current.participants["grace@example.com"]).toBeDefined();

    rerender({ id: "diagram-2" });
    expect(result.current.participants).toEqual({});
    expect(result.current.cursors).toEqual({});
    expect(result.current.remoteSelections).toEqual({});
  });

  it("sendCursor sends a well-formed frame when connected", () => {
    const { result } = renderHook(() => useDiagramLiveSync("diagram-1", true));
    act(() => latestSocket().simulateOpen());

    result.current.sendCursor(10, 20);

    expect(latestSocket().sentMessages).toEqual([
      JSON.stringify({ type: "cursor_moved", x: 10, y: 20 }),
    ]);
  });

  it("sendCursor does nothing when not connected", () => {
    const { result } = renderHook(() => useDiagramLiveSync("diagram-1", true));

    result.current.sendCursor(10, 20);

    expect(latestSocket().sentMessages).toHaveLength(0);
  });

  it("sendCursor throttles rapid successive calls to roughly 15/sec", () => {
    const { result } = renderHook(() => useDiagramLiveSync("diagram-1", true));
    act(() => latestSocket().simulateOpen());

    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000);
    result.current.sendCursor(1, 1);
    nowSpy.mockReturnValue(1_010);
    result.current.sendCursor(2, 2);
    nowSpy.mockReturnValue(1_100);
    result.current.sendCursor(3, 3);
    nowSpy.mockRestore();

    // The second call (10ms later) falls within the throttle window and is dropped; the
    // third (100ms after the first) clears it.
    expect(latestSocket().sentMessages).toEqual([
      JSON.stringify({ type: "cursor_moved", x: 1, y: 1 }),
      JSON.stringify({ type: "cursor_moved", x: 3, y: 3 }),
    ]);
  });

  it("sendSelectionChange sends a well-formed frame when connected, without throttling", () => {
    const { result } = renderHook(() => useDiagramLiveSync("diagram-1", true));
    act(() => latestSocket().simulateOpen());

    result.current.sendSelectionChange("n1", null);
    result.current.sendSelectionChange(null, "e1");

    expect(latestSocket().sentMessages).toEqual([
      JSON.stringify({
        edgeId: null,
        nodeId: "n1",
        type: "selection_changed",
      }),
      JSON.stringify({
        edgeId: "e1",
        nodeId: null,
        type: "selection_changed",
      }),
    ]);
  });

  it("sendSelectionChange does nothing when not connected", () => {
    const { result } = renderHook(() => useDiagramLiveSync("diagram-1", true));

    result.current.sendSelectionChange("n1", null);

    expect(latestSocket().sentMessages).toHaveLength(0);
  });

  it("closes the previous socket and opens a new one when the diagram id changes", () => {
    const { rerender } = renderHook(
      ({ id }: { id: string }) => useDiagramLiveSync(id, true),
      { initialProps: { id: "diagram-1" } },
    );
    const first = latestSocket();

    rerender({ id: "diagram-2" });

    expect(first.closed).toBe(true);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(latestSocket().url).toContain("/api/diagrams/diagram-2/live");
  });
});
