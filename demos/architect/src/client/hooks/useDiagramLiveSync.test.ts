import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDiagramStore } from "../stores/diagramStore";
import { useDiagramLiveSync } from "./useDiagramLiveSync";

/**
 * A deterministic WebSocket test double, mirroring `demos/chat`'s own `MockWebSocket`: real
 * browser WebSockets connect asynchronously and cannot be driven from a unit test.
 */
class MockWebSocket extends EventTarget {
  static instances: MockWebSocket[] = [];
  readonly url: string;
  closed = false;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    MockWebSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
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
      liveUpdateNotice: false,
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

  it("applies a graph_updated push newer than the store's own updatedAt", () => {
    renderHook(() => useDiagramLiveSync("diagram-1", true));

    latestSocket().simulateMessage({
      type: "graph_updated",
      graphData: JSON.stringify({
        nodes: [{ data: { label: "API", typeId: "worker" }, id: "n1" }],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    const state = useDiagramStore.getState();
    expect(state.nodes).toHaveLength(1);
    expect(state.liveUpdateNotice).toBe(true);
  });

  it("ignores a malformed frame", () => {
    renderHook(() => useDiagramLiveSync("diagram-1", true));
    latestSocket().simulateMessage("not json");
    expect(useDiagramStore.getState().nodes).toHaveLength(0);
  });

  it("ignores a frame missing the expected fields", () => {
    renderHook(() => useDiagramLiveSync("diagram-1", true));
    latestSocket().simulateMessage({ type: "graph_updated" });
    expect(useDiagramStore.getState().nodes).toHaveLength(0);
  });

  it("closes the socket on unmount", () => {
    const { unmount } = renderHook(() => useDiagramLiveSync("diagram-1", true));
    const socket = latestSocket();
    expect(socket.closed).toBe(false);
    unmount();
    expect(socket.closed).toBe(true);
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
