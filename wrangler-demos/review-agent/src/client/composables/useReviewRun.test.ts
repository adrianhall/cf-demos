import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, ref } from "vue";
import { useReviewRun } from "./useReviewRun";

/** A deterministic WebSocket test double for `AgentClient` (which extends
 * `ReconnectingWebSocket`, itself falling back to the global `WebSocket` constructor) --
 * mirrors `demos/agentic-ai-chat/src/client/composables/useChatAgent.test.ts`'s own identical
 * pattern, so `useReviewRun` can be driven with no real network connection. */
class MockWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  readonly url: string;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    MockWebSocket.instances.push(this);
  }

  send(): void {}

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

  /** Test helper: simulate an unexpected connection drop. */
  simulateServerClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code: 1_006 }));
  }
}

/** @returns The most recently constructed mock socket. */
async function latestSocket(): Promise<MockWebSocket> {
  await vi.waitFor(() => {
    if (MockWebSocket.instances.length === 0) {
      throw new Error("Expected a WebSocket to have been constructed.");
    }
  });
  const socket = MockWebSocket.instances.at(-1);
  if (socket === undefined) {
    throw new Error("Expected a WebSocket to have been constructed.");
  }
  return socket;
}

describe("useReviewRun", () => {
  let scope: ReturnType<typeof effectScope>;

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    scope = effectScope();
  });

  afterEach(() => {
    scope.stop();
    vi.unstubAllGlobals();
  });

  it("starts idle with no state, then connects and hydrates state from a cf_agent_state frame", async () => {
    const result = scope.run(() => useReviewRun(ref("run-1")));
    if (!result) throw new Error("effectScope did not run");
    expect(result.connectionStatus.value).toBe("connecting");
    expect(result.state.value).toBeNull();

    const socket = await latestSocket();
    socket.simulateOpen();
    expect(result.connectionStatus.value).toBe("connected");

    socket.simulateMessage({
      type: "cf_agent_state",
      state: {
        runId: "run-1",
        workflowInstanceId: "wf-1",
        status: "running",
        reviewers: [
          {
            role: "code-quality",
            status: "running",
            costUsd: null,
            costSource: "pending",
            findingCount: 0,
          },
        ],
      },
    });

    expect(result.state.value).toMatchObject({
      runId: "run-1",
      status: "running",
    });
  });

  it("connects to /agents/review-run/:id using the Agents SDK's own default routing", async () => {
    scope.run(() => useReviewRun(ref("run-42")));
    const socket = await latestSocket();

    expect(socket.url).toContain("/agents/review-run/run-42");
  });

  it("captures a reviewer_completed transition into the events stream", async () => {
    const result = scope.run(() => useReviewRun(ref("run-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    socket.simulateMessage({
      type: "reviewer_completed",
      role: "code-quality",
      event: "reviewer_completed",
      findingCount: 3,
    });

    expect(result.events.value).toHaveLength(1);
    expect(result.events.value[0]).toMatchObject({
      type: "reviewer_completed",
      role: "code-quality",
      findingCount: 3,
    });
    expect(result.events.value[0]?.receivedAt).toBeGreaterThan(0);
  });

  it("captures a reviewer_failed transition into the events stream", async () => {
    const result = scope.run(() => useReviewRun(ref("run-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    socket.simulateMessage({
      type: "reviewer_failed",
      role: "security",
      event: "reviewer_failed",
      errorDetail: "The model's JSON output was invalid twice.",
    });

    expect(result.events.value).toHaveLength(1);
    expect(result.events.value[0]).toMatchObject({
      type: "reviewer_failed",
      role: "security",
      errorDetail: "The model's JSON output was invalid twice.",
    });
  });

  it("captures a cost_reconciled transition into the events stream", async () => {
    const result = scope.run(() => useReviewRun(ref("run-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    socket.simulateMessage({
      type: "cost_reconciled",
      role: "architecture",
      event: "cost_reconciled",
      costUsd: 0.0042,
    });

    expect(result.events.value[0]).toMatchObject({
      type: "cost_reconciled",
      role: "architecture",
      costUsd: 0.0042,
    });
  });

  it("captures review_completed and review_failed terminal events", async () => {
    const result = scope.run(() => useReviewRun(ref("run-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    socket.simulateMessage({
      type: "review_completed",
      commentUrl: "https://github.com/owner/repo/pull/1#comment",
    });
    expect(result.events.value[0]).toMatchObject({
      type: "review_completed",
      commentUrl: "https://github.com/owner/repo/pull/1#comment",
    });

    socket.simulateMessage({ type: "review_failed", detail: "boom" });
    expect(result.events.value[1]).toMatchObject({
      type: "review_failed",
      detail: "boom",
    });
  });

  it("ignores an unrecognized frame type", async () => {
    const result = scope.run(() => useReviewRun(ref("run-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    socket.simulateMessage({ type: "cf_agent_identity" });

    expect(result.events.value).toHaveLength(0);
  });

  it("ignores a non-string message payload", async () => {
    const result = scope.run(() => useReviewRun(ref("run-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    socket.dispatchEvent(
      new MessageEvent("message", { data: new Blob(["not json"]) }),
    );

    expect(result.events.value).toHaveLength(0);
  });

  it("ignores an unparseable message payload", async () => {
    const result = scope.run(() => useReviewRun(ref("run-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    socket.dispatchEvent(new MessageEvent("message", { data: "not json" }));

    expect(result.events.value).toHaveLength(0);
  });

  it("ignores a message frame with no type field", async () => {
    const result = scope.run(() => useReviewRun(ref("run-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    socket.simulateMessage({ role: "code-quality" });

    expect(result.events.value).toHaveLength(0);
  });

  it("reports connecting again after an unexpected drop", async () => {
    const result = scope.run(() => useReviewRun(ref("run-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();
    expect(result.connectionStatus.value).toBe("connected");

    socket.simulateServerClose();

    expect(result.connectionStatus.value).toBe("connecting");
  });

  it("reports an error status when the current connection itself errors", async () => {
    const result = scope.run(() => useReviewRun(ref("run-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    socket.dispatchEvent(new Event("error"));

    expect(result.connectionStatus.value).toBe("error");
  });

  it("resets state and events, and opens a new connection, when the run id changes", async () => {
    const id = ref("run-1");
    const result = scope.run(() => useReviewRun(id));
    if (!result) throw new Error("effectScope did not run");
    const firstSocket = await latestSocket();
    firstSocket.simulateOpen();
    firstSocket.simulateMessage({
      type: "reviewer_completed",
      role: "code-quality",
      event: "reviewer_completed",
    });
    expect(result.events.value).toHaveLength(1);

    id.value = "run-2";
    await vi.waitFor(() => {
      if (MockWebSocket.instances.length < 2) {
        throw new Error(
          "Expected a second WebSocket to have been constructed.",
        );
      }
    });

    expect(result.state.value).toBeNull();
    expect(result.events.value).toHaveLength(0);
    expect(result.connectionStatus.value).toBe("connecting");
    const secondSocket = MockWebSocket.instances[1] as MockWebSocket;
    expect(secondSocket.url).toContain("/agents/review-run/run-2");
  });

  it("ignores a stale close/error from a previous connection after switching run id", async () => {
    const id = ref("run-1");
    const result = scope.run(() => useReviewRun(id));
    if (!result) throw new Error("effectScope did not run");
    const firstSocket = await latestSocket();
    firstSocket.simulateOpen();

    id.value = "run-2";
    const secondSocket = await vi.waitFor(() => {
      const socket = MockWebSocket.instances[1];
      if (!socket) throw new Error("Expected a second WebSocket.");
      return socket;
    });
    secondSocket.simulateOpen();
    expect(result.connectionStatus.value).toBe("connected");

    // The first (now-torn-down) socket's own "close"/"error" firing after teardown must not be
    // mistaken for the current connection dropping.
    firstSocket.dispatchEvent(new CloseEvent("close", { code: 1_006 }));
    firstSocket.dispatchEvent(new Event("error"));

    expect(result.connectionStatus.value).toBe("connected");
  });

  it("closes the socket on scope disposal", async () => {
    scope.run(() => useReviewRun(ref("run-1")));
    const socket = await latestSocket();
    const closeSpy = vi.spyOn(socket, "close");

    scope.stop();

    expect(closeSpy).toHaveBeenCalled();
  });
});
