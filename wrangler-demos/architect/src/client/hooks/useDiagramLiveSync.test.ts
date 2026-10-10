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

  it("applies an origin: ai-chat operation_applied and appends an action transcript entry (docs/09D-ARCHITECT-AICHAT.md)", () => {
    const { result, rerender } = renderHook(() =>
      useDiagramLiveSync("diagram-1", true),
    );

    latestSocket().simulateMessage({
      type: "operation_applied",
      actorEmail: "owner@example.com",
      op: {
        input: { label: "Workers", position: { x: 0, y: 0 }, typeId: "worker" },
        kind: "add_node",
      },
      origin: "ai-chat",
      sequence: 1,
    });
    rerender();

    const state = useDiagramStore.getState();
    expect(state.nodes).toHaveLength(1);
    expect(state.liveUpdateNotice).toEqual({
      actorEmail: "owner@example.com",
      origin: "ai-chat",
    });
    expect(result.current.chatTranscript).toHaveLength(1);
    expect(result.current.chatTranscript[0]).toMatchObject({
      kind: "action",
      text: "Added node: Workers",
    });
  });

  it("suppresses the toast for an ai-chat operation_applied while this tab has its own turn in flight", () => {
    const { result, rerender } = renderHook(() =>
      useDiagramLiveSync("diagram-1", true),
    );
    act(() => latestSocket().simulateOpen());
    result.current.sendChatMessage("Add a Worker");

    latestSocket().simulateMessage({
      type: "operation_applied",
      actorEmail: "owner@example.com",
      op: {
        input: { label: "Workers", position: { x: 0, y: 0 }, typeId: "worker" },
        kind: "add_node",
      },
      origin: "ai-chat",
      sequence: 1,
    });
    rerender();

    // Still applied to local state (every connected tab sees the canvas update)...
    expect(useDiagramStore.getState().nodes).toHaveLength(1);
    // ...but the toast itself is suppressed for the tab that is currently chatting.
    expect(useDiagramStore.getState().liveUpdateNotice).toBeNull();
  });

  it("shows the toast for an ai-chat operation_applied on a tab with no chat turn in flight", () => {
    const { rerender } = renderHook(() =>
      useDiagramLiveSync("diagram-1", true),
    );

    latestSocket().simulateMessage({
      type: "operation_applied",
      actorEmail: "owner@example.com",
      op: { kind: "remove_node", nodeId: "n1" },
      origin: "ai-chat",
      sequence: 1,
    });
    rerender();

    expect(useDiagramStore.getState().liveUpdateNotice).toEqual({
      actorEmail: "owner@example.com",
      origin: "ai-chat",
    });
  });

  it("resumes showing the ai-chat toast once this tab's own turn resolves", () => {
    const { result, rerender } = renderHook(() =>
      useDiagramLiveSync("diagram-1", true),
    );
    act(() => latestSocket().simulateOpen());
    const clientRequestId = result.current.sendChatMessage("Add a Worker");

    latestSocket().simulateMessage({
      clientRequestId,
      assistantText: "Done.",
      type: "chat_done",
    });
    rerender();

    latestSocket().simulateMessage({
      type: "operation_applied",
      actorEmail: "owner@example.com",
      op: { kind: "remove_node", nodeId: "n1" },
      origin: "ai-chat",
      sequence: 1,
    });
    rerender();

    expect(useDiagramStore.getState().liveUpdateNotice).toEqual({
      actorEmail: "owner@example.com",
      origin: "ai-chat",
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

  describe("AI chat (docs/09D-ARCHITECT-AICHAT.md)", () => {
    it("sendChatMessage sends a well-formed frame, returns the generated id, and appends a user entry", () => {
      const { result, rerender } = renderHook(() =>
        useDiagramLiveSync("diagram-1", true),
      );
      act(() => latestSocket().simulateOpen());

      const clientRequestId = result.current.sendChatMessage("Add a Worker");
      rerender();

      expect(clientRequestId).not.toBe(false);
      expect(latestSocket().sentMessages).toEqual([
        JSON.stringify({
          clientRequestId,
          text: "Add a Worker",
          type: "chat_message",
        }),
      ]);
      expect(result.current.chatInFlight).toBe(true);
      expect(result.current.chatTranscript).toEqual([
        { id: expect.any(String), kind: "user", text: "Add a Worker" },
      ]);
    });

    it("sendChatMessage returns false and sends nothing when not connected", () => {
      const { result } = renderHook(() =>
        useDiagramLiveSync("diagram-1", true),
      );

      const sent = result.current.sendChatMessage("Add a Worker");

      expect(sent).toBe(false);
      expect(latestSocket().sentMessages).toHaveLength(0);
      expect(result.current.chatInFlight).toBe(false);
    });

    it("appends a status entry on chat_status", () => {
      const { result, rerender } = renderHook(() =>
        useDiagramLiveSync("diagram-1", true),
      );

      latestSocket().simulateMessage({
        clientRequestId: "req-1",
        message: "Checking Cloudflare docs…",
        type: "chat_status",
      });
      rerender();

      expect(result.current.chatTranscript).toEqual([
        {
          id: expect.any(String),
          kind: "status",
          text: "Checking Cloudflare docs…",
        },
      ]);
    });

    it("keeps the transcript in chronological order when a turn narrates, acts, then narrates again", () => {
      // The reported symptom (docs/DECISIONS.md #43): the turn's closing summary appeared
      // *above* the tool activity that preceded it, because the assistant bubble stayed
      // anchored wherever its first token landed while every status appended to the end.
      const { result, rerender } = renderHook(() =>
        useDiagramLiveSync("diagram-1", true),
      );
      act(() => latestSocket().simulateOpen());
      const clientRequestId = result.current.sendChatMessage("Build it");
      rerender();

      latestSocket().simulateMessage({
        clientRequestId,
        text: "Now I'll wire everything together:",
        type: "chat_token",
      });
      latestSocket().simulateMessage({
        clientRequestId,
        message: "Renaming the diagram…",
        type: "chat_status",
      });
      latestSocket().simulateMessage({
        clientRequestId,
        text: "All connected.",
        type: "chat_token",
      });
      rerender();

      expect(
        result.current.chatTranscript.map((entry) => [
          entry.kind,
          "text" in entry ? entry.text : "",
        ]),
      ).toEqual([
        ["user", "Build it"],
        ["assistant", "Now I'll wire everything together:"],
        ["status", "Renaming the diagram…"],
        ["assistant", "All connected."],
      ]);
    });

    it("accumulates streamed chat_token frames onto one assistant entry", () => {
      const { result, rerender } = renderHook(() =>
        useDiagramLiveSync("diagram-1", true),
      );

      latestSocket().simulateMessage({
        clientRequestId: "req-1",
        text: "Sure, ",
        type: "chat_token",
      });
      latestSocket().simulateMessage({
        clientRequestId: "req-1",
        text: "adding it now.",
        type: "chat_token",
      });
      rerender();

      expect(result.current.chatTranscript).toHaveLength(1);
      expect(result.current.chatTranscript[0]).toMatchObject({
        kind: "assistant",
        stopped: false,
        text: "Sure, adding it now.",
      });
    });

    it("leaves an earlier, non-assistant transcript entry untouched while accumulating chat_token onto the active assistant entry", () => {
      // Regression coverage: the chat_token accumulator's `.map()` walks every transcript
      // entry, not just the active assistant one, so it must skip (return unchanged) any
      // entry whose id does not match `activeAssistantEntryIdRef` -- exercised here by
      // sending the user's own message first (via `sendChatMessage`, which prepends a
      // `kind: "user"` entry) so the transcript already has a second, non-assistant entry by
      // the time the accumulating second `chat_token` frame's `.map()` runs.
      const { result, rerender } = renderHook(() =>
        useDiagramLiveSync("diagram-1", true),
      );
      act(() => latestSocket().simulateOpen());
      const clientRequestId = result.current.sendChatMessage("Add a Worker");
      rerender();

      latestSocket().simulateMessage({
        clientRequestId,
        text: "Sure, ",
        type: "chat_token",
      });
      latestSocket().simulateMessage({
        clientRequestId,
        text: "adding it now.",
        type: "chat_token",
      });
      rerender();

      expect(result.current.chatTranscript).toHaveLength(2);
      expect(result.current.chatTranscript[0]).toMatchObject({
        kind: "user",
        text: "Add a Worker",
      });
      expect(result.current.chatTranscript[1]).toMatchObject({
        kind: "assistant",
        stopped: false,
        text: "Sure, adding it now.",
      });
    });

    it("appends a docs_result entry on chat_tool_result with a successful result", () => {
      const { result, rerender } = renderHook(() =>
        useDiagramLiveSync("diagram-1", true),
      );

      latestSocket().simulateMessage({
        args: { query: "Workers AI" },
        clientRequestId: "req-1",
        result: [
          {
            title: "Workers AI",
            url: "https://developers.cloudflare.com/workers-ai/",
            snippet: "…",
          },
        ],
        tool: "search_cloudflare_documentation",
        type: "chat_tool_result",
      });
      rerender();

      expect(result.current.chatTranscript[0]).toMatchObject({
        kind: "docs_result",
        query: "Workers AI",
        result: [
          {
            title: "Workers AI",
            url: "https://developers.cloudflare.com/workers-ai/",
            snippet: "…",
          },
        ],
      });
    });

    it("appends a docs_result entry on chat_tool_result with the non-fatal fallback message", () => {
      const { result, rerender } = renderHook(() =>
        useDiagramLiveSync("diagram-1", true),
      );

      latestSocket().simulateMessage({
        args: { query: "Durable Objects" },
        clientRequestId: "req-1",
        result: { message: "documentation search is currently unavailable" },
        tool: "search_cloudflare_documentation",
        type: "chat_tool_result",
      });
      rerender();

      expect(result.current.chatTranscript[0]).toMatchObject({
        kind: "docs_result",
        result: { message: "documentation search is currently unavailable" },
      });
    });

    it("leaves the streamed assistant entry intact on chat_done and clears chatInFlight", () => {
      const { result, rerender } = renderHook(() =>
        useDiagramLiveSync("diagram-1", true),
      );
      act(() => latestSocket().simulateOpen());
      const clientRequestId = result.current.sendChatMessage("Add a Worker");
      rerender();

      latestSocket().simulateMessage({
        clientRequestId,
        text: "Sure, I added a Worker node.",
        type: "chat_token",
      });
      latestSocket().simulateMessage({
        clientRequestId,
        assistantText: "Sure, I added a Worker node.",
        type: "chat_done",
      });
      rerender();

      expect(result.current.chatInFlight).toBe(false);
      const assistantEntries = result.current.chatTranscript.filter(
        (entry) => entry.kind === "assistant",
      );
      // `chat_done` deliberately does not rewrite the streamed text: `assistantText` is the
      // concatenation of exactly the tokens already rendered, and a turn may own several
      // assistant bubbles once tool activity splits them (docs/DECISIONS.md #43).
      expect(assistantEntries).toHaveLength(1);
      expect(assistantEntries[0]).toMatchObject({
        stopped: false,
        text: "Sure, I added a Worker node.",
      });
    });

    it("records the answer on chat_done when no token streamed at all", () => {
      const { result, rerender } = renderHook(() =>
        useDiagramLiveSync("diagram-1", true),
      );
      act(() => latestSocket().simulateOpen());
      const clientRequestId = result.current.sendChatMessage("Add a Worker");
      rerender();

      latestSocket().simulateMessage({
        clientRequestId,
        assistantText: "Done, with no streamed tokens.",
        type: "chat_done",
      });
      rerender();

      const assistantEntries = result.current.chatTranscript.filter(
        (entry) => entry.kind === "assistant",
      );
      expect(assistantEntries).toHaveLength(1);
      expect(assistantEntries[0]).toMatchObject({
        text: "Done, with no streamed tokens.",
      });
    });

    it("reconciles to a single assistant entry when chat_done is batched into the same render as the streamed tokens", () => {
      // Regression coverage for docs/ISSUE-5.md's duplicated answer. React defers a
      // `setState` updater to render time whenever that hook already has queued work, which is
      // the normal case while tokens are streaming: the last `chat_token` and the `chat_done`
      // that follows it land in the same batch. The `chat_done` handler must therefore capture
      // the active assistant entry id *before* it resets that ref, or its own deferred updater
      // observes the already-cleared ref and appends a second, complete copy of the answer.
      // Delivering every frame inside one `act()` is what reproduces that batching here.
      const { result, rerender } = renderHook(() =>
        useDiagramLiveSync("diagram-1", true),
      );
      act(() => latestSocket().simulateOpen());
      const clientRequestId = result.current.sendChatMessage("Add a Worker");
      rerender();

      act(() => {
        latestSocket().simulateMessage({
          clientRequestId,
          text: "Sure, ",
          type: "chat_token",
        });
        latestSocket().simulateMessage({
          clientRequestId,
          text: "I added a Worker node.",
          type: "chat_token",
        });
        latestSocket().simulateMessage({
          assistantText: "Sure, I added a Worker node.",
          clientRequestId,
          type: "chat_done",
        });
      });
      rerender();

      expect(
        result.current.chatTranscript.filter(
          (entry) => entry.kind === "assistant",
        ),
      ).toEqual([
        {
          id: expect.any(String),
          kind: "assistant",
          stopped: false,
          text: "Sure, I added a Worker node.",
        },
      ]);
      expect(result.current.chatInFlight).toBe(false);
    });

    it("records the turn's complete text on chat_done even when no chat_token ever arrived", () => {
      const { result, rerender } = renderHook(() =>
        useDiagramLiveSync("diagram-1", true),
      );
      act(() => latestSocket().simulateOpen());
      const clientRequestId = result.current.sendChatMessage("Add a Worker");
      rerender();

      latestSocket().simulateMessage({
        clientRequestId,
        assistantText: "Done.",
        type: "chat_done",
      });
      rerender();

      const assistantEntry = result.current.chatTranscript.find(
        (entry) => entry.kind === "assistant",
      );
      expect(assistantEntry).toMatchObject({ text: "Done." });
      expect(result.current.chatInFlight).toBe(false);
    });

    it("appends an error entry on chat_error and clears chatInFlight", () => {
      const { result, rerender } = renderHook(() =>
        useDiagramLiveSync("diagram-1", true),
      );
      act(() => latestSocket().simulateOpen());
      const clientRequestId = result.current.sendChatMessage("Add a Worker");
      rerender();

      latestSocket().simulateMessage({
        clientRequestId,
        message: "The assistant hit an unexpected error.",
        type: "chat_error",
      });
      rerender();

      expect(result.current.chatInFlight).toBe(false);
      expect(
        result.current.chatTranscript.find((entry) => entry.kind === "error"),
      ).toMatchObject({ text: "The assistant hit an unexpected error." });
    });

    it("silently consumes a chat_error for an already-stopped request without a duplicate entry", () => {
      const { result, rerender } = renderHook(() =>
        useDiagramLiveSync("diagram-1", true),
      );
      act(() => latestSocket().simulateOpen());
      const clientRequestId = result.current.sendChatMessage("Add a Worker");
      rerender();

      act(() => result.current.stopChatTurn());
      rerender();

      latestSocket().simulateMessage({
        clientRequestId,
        message: "The assistant hit an unexpected error.",
        type: "chat_error",
      });
      rerender();

      expect(
        result.current.chatTranscript.some((entry) => entry.kind === "error"),
      ).toBe(false);
    });

    it("stopChatTurn before any token has arrived still stops the turn, with no assistant entry to mark", () => {
      const { result, rerender } = renderHook(() =>
        useDiagramLiveSync("diagram-1", true),
      );
      act(() => latestSocket().simulateOpen());
      result.current.sendChatMessage("Add a Worker");
      rerender();

      act(() => result.current.stopChatTurn());

      expect(result.current.chatInFlight).toBe(false);
      expect(
        result.current.chatTranscript.some(
          (entry) => entry.kind === "assistant",
        ),
      ).toBe(false);
    });

    it("applies a diagram_renamed broadcast via applyRemoteRename, without marking dirty", () => {
      useDiagramStore.setState({ dirty: false });
      renderHook(() => useDiagramLiveSync("diagram-1", true));

      latestSocket().simulateMessage({
        description: "New description",
        title: "New Title",
        type: "diagram_renamed",
      });

      const state = useDiagramStore.getState();
      expect(state.title).toBe("New Title");
      expect(state.description).toBe("New description");
      expect(state.dirty).toBe(false);
    });

    it("normalizes a null diagram_renamed description to an empty string", () => {
      renderHook(() => useDiagramLiveSync("diagram-1", true));

      latestSocket().simulateMessage({
        description: null,
        title: "New Title",
        type: "diagram_renamed",
      });

      expect(useDiagramStore.getState().description).toBe("");
    });

    it("stopChatTurn marks the in-flight assistant entry stopped and drops further tokens", () => {
      const { result, rerender } = renderHook(() =>
        useDiagramLiveSync("diagram-1", true),
      );
      act(() => latestSocket().simulateOpen());
      const clientRequestId = result.current.sendChatMessage("Add a Worker");
      rerender();

      latestSocket().simulateMessage({
        clientRequestId,
        text: "Partial",
        type: "chat_token",
      });
      rerender();

      act(() => result.current.stopChatTurn());
      expect(result.current.chatInFlight).toBe(false);

      // A token arriving after Stop is dropped -- "stop watching," not "cancel the model."
      latestSocket().simulateMessage({
        clientRequestId,
        text: " more text",
        type: "chat_token",
      });
      rerender();

      const assistantEntry = result.current.chatTranscript.find(
        (entry) => entry.kind === "assistant",
      );
      expect(assistantEntry).toMatchObject({ stopped: true, text: "Partial" });

      // The turn's eventual chat_done (the server kept running) is consumed silently, not
      // re-appended as a second entry or un-stopping the existing one.
      latestSocket().simulateMessage({
        clientRequestId,
        assistantText: "Partial more text after all",
        type: "chat_done",
      });
      rerender();

      const assistantEntries = result.current.chatTranscript.filter(
        (entry) => entry.kind === "assistant",
      );
      expect(assistantEntries).toHaveLength(1);
      expect(assistantEntries[0]).toMatchObject({
        stopped: true,
        text: "Partial",
      });
    });

    it("stopChatTurn does nothing when no turn is in flight", () => {
      const { result } = renderHook(() =>
        useDiagramLiveSync("diagram-1", true),
      );

      expect(() => act(() => result.current.stopChatTurn())).not.toThrow();
      expect(result.current.chatInFlight).toBe(false);
    });

    it("clearChatTranscript empties the transcript without touching chatInFlight", () => {
      const { result, rerender } = renderHook(() =>
        useDiagramLiveSync("diagram-1", true),
      );
      act(() => latestSocket().simulateOpen());
      result.current.sendChatMessage("Add a Worker");
      rerender();
      expect(result.current.chatTranscript.length).toBeGreaterThan(0);

      act(() => result.current.clearChatTranscript());
      rerender();

      expect(result.current.chatTranscript).toEqual([]);
      expect(result.current.chatInFlight).toBe(true);
    });

    it("resets the chat transcript and in-flight state when the diagram id changes", () => {
      const { result, rerender } = renderHook(
        ({ id }: { id: string }) => useDiagramLiveSync(id, true),
        { initialProps: { id: "diagram-1" } },
      );
      act(() => latestSocket().simulateOpen());
      result.current.sendChatMessage("Add a Worker");
      rerender({ id: "diagram-1" });
      expect(result.current.chatTranscript.length).toBeGreaterThan(0);

      rerender({ id: "diagram-2" });

      expect(result.current.chatTranscript).toEqual([]);
      expect(result.current.chatInFlight).toBe(false);
    });
  });
});
