import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import { CHAT_REMOVED_CLOSE_CODE } from "../../agent-protocol";
import { useChatAgent } from "./useChatAgent";

/**
 * A deterministic WebSocket test double, in the same spirit as `demos/chat`'s
 * `MockWebSocket` -- but for `AgentClient` (which extends `ReconnectingWebSocket`, itself
 * falling back to the global `WebSocket` constructor when no `options.WebSocket` override is
 * given), so stubbing the global is enough for `useChatAgent` to drive it without any real
 * network connection.
 */
class MockWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  readonly url: string;
  readonly sent: string[] = [];

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
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

  /** Test helper: simulate the server closing the connection, unexpectedly by default (an
   * arbitrary non-removal code), or with an explicit `code` (for example
   * `CHAT_REMOVED_CLOSE_CODE`). */
  simulateServerClose(code = 1_006): void {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code }));
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

/** Build a fetch response resolving `GET /api/chats/:id/get-messages`. */
function historyResponse(
  messages: readonly { id: string; role: string; text: string }[],
): Response {
  return new Response(
    JSON.stringify(
      messages.map((message) => ({
        id: message.id,
        role: message.role,
        parts: [{ type: "text", text: message.text }],
      })),
    ),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("useChatAgent", () => {
  let scope: ReturnType<typeof effectScope>;

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    scope = effectScope();
  });

  afterEach(() => {
    scope.stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads persisted history before connecting, then reports connected once open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        historyResponse([
          { id: "m1", role: "user", text: "hi" },
          { id: "m2", role: "assistant", text: "hello" },
        ]),
      ),
    );

    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");

    await vi.waitFor(() => expect(result.turns.value).toHaveLength(2));
    expect(result.turns.value).toEqual([
      {
        id: "m1",
        role: "user",
        content: "hi",
        status: "done",
        errorDetail: null,
        attachments: [],
      },
      {
        id: "m2",
        role: "assistant",
        content: "hello",
        status: "done",
        errorDetail: null,
        attachments: [],
      },
    ]);
    expect(result.connectionStatus.value).toBe("connecting");

    (await latestSocket()).simulateOpen();
    await nextTick();
    expect(result.connectionStatus.value).toBe("connected");
  });

  it("streams an assistant turn's text-delta parts into its content incrementally", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = await latestSocket();
    socket.simulateOpen();

    result.send("What is the capital of France?");
    expect(result.isStreaming.value).toBe(true);
    expect(result.turns.value).toHaveLength(2);
    expect(result.turns.value[0]).toMatchObject({
      role: "user",
      content: "What is the capital of France?",
      status: "done",
    });
    expect(result.turns.value[1]).toMatchObject({
      role: "assistant",
      content: "",
      status: "streaming",
    });

    const sentFrame = JSON.parse(socket.sent[0] ?? "{}") as {
      type: string;
      id: string;
    };
    expect(sentFrame.type).toBe("cf_agent_use_chat_request");

    socket.simulateMessage({
      type: "cf_agent_use_chat_response",
      id: sentFrame.id,
      body: '{"type":"start"}{"type":"start-step"}{"type":"text-start","id":"a"}',
      done: false,
    });
    socket.simulateMessage({
      type: "cf_agent_use_chat_response",
      id: sentFrame.id,
      body: '{"type":"text-delta","id":"a","delta":"Paris"}',
      done: false,
    });
    expect(result.turns.value[1]).toMatchObject({
      content: "Paris",
      status: "streaming",
    });

    socket.simulateMessage({
      type: "cf_agent_use_chat_response",
      id: sentFrame.id,
      body: '{"type":"text-end","id":"a"}{"type":"finish-step"}{"type":"finish"}',
      done: true,
    });
    expect(result.turns.value[1]).toMatchObject({
      content: "Paris",
      status: "done",
    });
    expect(result.isStreaming.value).toBe(false);
  });

  it("attaches a file to the turn once a writeMarkdown tool call's output-available part reports success (US-8)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    result.send("Save this as a file");
    const sentFrame = JSON.parse(socket.sent[0] ?? "{}") as { id: string };

    socket.simulateMessage({
      type: "cf_agent_use_chat_response",
      id: sentFrame.id,
      body: JSON.stringify({
        type: "tool-input-available",
        toolCallId: "call-1",
        toolName: "writeMarkdown",
        input: { filename: "notes", content: "hello" },
      }),
      done: false,
    });
    socket.simulateMessage({
      type: "cf_agent_use_chat_response",
      id: sentFrame.id,
      body: JSON.stringify({
        type: "tool-output-available",
        toolCallId: "call-1",
        output: { success: true, fileId: "file-1", filename: "notes.md" },
      }),
      done: true,
    });

    expect(result.turns.value[1]?.attachments).toEqual([
      { fileId: "file-1", filename: "notes.md" },
    ]);
  });

  it("does not attach a file for a tool-output-available part belonging to a tool other than writeMarkdown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    result.send("Look this up");
    const sentFrame = JSON.parse(socket.sent[0] ?? "{}") as { id: string };

    socket.simulateMessage({
      type: "cf_agent_use_chat_response",
      id: sentFrame.id,
      body: JSON.stringify({
        type: "tool-input-available",
        toolCallId: "call-1",
        toolName: "getUrl",
        input: { url: "https://example.com" },
      }),
      done: false,
    });
    socket.simulateMessage({
      type: "cf_agent_use_chat_response",
      id: sentFrame.id,
      body: JSON.stringify({
        type: "tool-output-available",
        toolCallId: "call-1",
        output: { success: true, fileId: "file-1", filename: "notes.md" },
      }),
      done: true,
    });

    expect(result.turns.value[1]?.attachments).toEqual([]);
  });

  it("does not attach a file for a tool-output-available part whose output is not an object", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    result.send("Save this as a file");
    const sentFrame = JSON.parse(socket.sent[0] ?? "{}") as { id: string };

    socket.simulateMessage({
      type: "cf_agent_use_chat_response",
      id: sentFrame.id,
      body: JSON.stringify({
        type: "tool-input-available",
        toolCallId: "call-1",
        toolName: "writeMarkdown",
        input: { filename: "notes", content: "hello" },
      }),
      done: false,
    });
    socket.simulateMessage({
      type: "cf_agent_use_chat_response",
      id: sentFrame.id,
      body: JSON.stringify({
        type: "tool-output-available",
        toolCallId: "call-1",
        output: "not an object",
      }),
      done: true,
    });

    expect(result.turns.value[1]?.attachments).toEqual([]);
  });

  it("restores a turn's attachments from a persisted tool-writeMarkdown part on history reload (US-8)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
            {
              id: "a1",
              role: "assistant",
              parts: [
                { type: "text", text: "Saved it." },
                {
                  type: "tool-writeMarkdown",
                  state: "output-available",
                  output: {
                    success: true,
                    fileId: "file-1",
                    filename: "notes.md",
                  },
                },
              ],
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");

    await vi.waitFor(() => expect(result.turns.value).toHaveLength(2));
    expect(result.turns.value[1]?.attachments).toEqual([
      { fileId: "file-1", filename: "notes.md" },
    ]);
  });

  it("restores no attachment from a persisted tool-writeMarkdown part whose own result reported failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
            {
              id: "a1",
              role: "assistant",
              parts: [
                { type: "text", text: "I could not save that." },
                {
                  type: "tool-writeMarkdown",
                  state: "output-available",
                  output: {
                    success: false,
                    error: "content must not be empty.",
                  },
                },
              ],
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");

    await vi.waitFor(() => expect(result.turns.value).toHaveLength(2));
    expect(result.turns.value[1]?.attachments).toEqual([]);
  });

  it("does not attach a file for a tool-output-available part whose own result reported failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    result.send("Save this as a file");
    const sentFrame = JSON.parse(socket.sent[0] ?? "{}") as { id: string };

    socket.simulateMessage({
      type: "cf_agent_use_chat_response",
      id: sentFrame.id,
      body: JSON.stringify({
        type: "tool-input-available",
        toolCallId: "call-1",
        toolName: "writeMarkdown",
        input: { filename: "notes", content: "" },
      }),
      done: false,
    });
    socket.simulateMessage({
      type: "cf_agent_use_chat_response",
      id: sentFrame.id,
      body: JSON.stringify({
        type: "tool-output-available",
        toolCallId: "call-1",
        output: { success: false, error: "content must not be empty." },
      }),
      done: true,
    });

    expect(result.turns.value[1]?.attachments).toEqual([]);
  });

  it("marks the assistant turn as errored on an in-band error part", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    result.send("hi");
    const sentFrame = JSON.parse(socket.sent[0] ?? "{}") as { id: string };

    socket.simulateMessage({
      type: "cf_agent_use_chat_response",
      id: sentFrame.id,
      body: '{"type":"error","errorText":"model temporarily unavailable"}',
      done: true,
    });

    expect(result.turns.value[1]).toMatchObject({
      status: "error",
      errorDetail: "model temporarily unavailable",
    });
  });

  it("does not submit an empty prompt or a second prompt while one is streaming", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    result.send("   ");
    expect(result.turns.value).toHaveLength(0);

    result.send("first");
    expect(result.turns.value).toHaveLength(2);

    result.send("second");
    expect(result.turns.value).toHaveLength(2);
    expect(socket.sent).toHaveLength(1);
  });

  it("reports an error status when initial history loading fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );

    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");

    await vi.waitFor(() => expect(result.connectionStatus.value).toBe("error"));
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("reports connecting again after an unexpected server-initiated close", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();
    expect(result.connectionStatus.value).toBe("connected");

    socket.simulateServerClose();
    expect(result.connectionStatus.value).toBe("connecting");
  });

  it("marks the chat removed and does not reconnect on a chat_removed frame", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    socket.simulateMessage({ type: "chat_removed" });

    expect(result.connectionStatus.value).toBe("removed");
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    // The server also closes with CHAT_REMOVED_CLOSE_CODE right after this frame in production;
    // simulating that here must not un-set the already-"removed" status.
    socket.simulateServerClose(CHAT_REMOVED_CLOSE_CODE);
    expect(result.connectionStatus.value).toBe("removed");
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("marks the chat removed on the close-code path alone, when no chat_removed frame arrives first", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    socket.simulateServerClose(CHAT_REMOVED_CLOSE_CODE);

    expect(result.connectionStatus.value).toBe("removed");
    // Unlike an ordinary unexpected drop, a removed chat must not attempt to reconnect.
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("bumps metadataUpdatedAt on a chat_metadata_updated broadcast", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();
    expect(result.metadataUpdatedAt.value).toBe(0);

    socket.simulateMessage({ type: "chat_metadata_updated" });

    expect(result.metadataUpdatedAt.value).toBeGreaterThan(0);
  });

  it("tolerates repeated chat_metadata_updated broadcasts for the same turn", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    socket.simulateMessage({ type: "chat_metadata_updated" });
    socket.simulateMessage({ type: "chat_metadata_updated" });

    expect(result.metadataUpdatedAt.value).toBeGreaterThan(0);
  });

  it("starts with a zeroed usage summary and updates it from a cf_agent_state frame", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    expect(result.usage.value).toEqual({
      totalCostUsd: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      turnCount: 0,
      confirmedTurnCount: 0,
      lastUpdatedAt: null,
    });
    const socket = await latestSocket();
    socket.simulateOpen();

    socket.simulateMessage({
      type: "cf_agent_state",
      state: {
        usage: {
          totalCostUsd: 0.001,
          totalPromptTokens: 10,
          totalCompletionTokens: 20,
          turnCount: 1,
          confirmedTurnCount: 0,
          lastUpdatedAt: "2026-08-03T00:00:00.000Z",
        },
      },
    });

    expect(result.usage.value).toEqual({
      totalCostUsd: 0.001,
      totalPromptTokens: 10,
      totalCompletionTokens: 20,
      turnCount: 1,
      confirmedTurnCount: 0,
      lastUpdatedAt: "2026-08-03T00:00:00.000Z",
    });
  });

  it("captures a usage_reconciled broadcast into lastReconciliationEvent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();
    expect(result.lastReconciliationEvent.value).toBeNull();

    socket.simulateMessage({
      type: "usage_reconciled",
      chatUsageId: "usage-1",
      costSource: "gateway",
    });

    expect(result.lastReconciliationEvent.value).toMatchObject({
      type: "usage_reconciled",
      chatUsageId: "usage-1",
    });
    expect(result.lastReconciliationEvent.value?.receivedAt).toBeGreaterThan(0);
  });

  it("captures a usage_reconcile_exhausted broadcast into lastReconciliationEvent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    socket.simulateMessage({
      type: "usage_reconcile_exhausted",
      chatUsageId: "usage-2",
    });

    expect(result.lastReconciliationEvent.value).toMatchObject({
      type: "usage_reconcile_exhausted",
      chatUsageId: "usage-2",
    });
  });

  it("resets usage and lastReconciliationEvent when switching to a different chat", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(historyResponse([]))
        .mockResolvedValueOnce(historyResponse([])),
    );
    const chatId = ref("chat-1");
    const result = scope.run(() => useChatAgent(chatId));
    if (!result) throw new Error("effectScope did not run");
    const firstSocket = await latestSocket();
    firstSocket.simulateOpen();
    firstSocket.simulateMessage({
      type: "cf_agent_state",
      state: {
        usage: {
          totalCostUsd: 1,
          totalPromptTokens: 1,
          totalCompletionTokens: 1,
          turnCount: 1,
          confirmedTurnCount: 1,
          lastUpdatedAt: "2026-08-03T00:00:00.000Z",
        },
      },
    });
    firstSocket.simulateMessage({
      type: "usage_reconciled",
      chatUsageId: "usage-1",
      costSource: "gateway",
    });
    expect(result.usage.value.turnCount).toBe(1);
    expect(result.lastReconciliationEvent.value).not.toBeNull();

    chatId.value = "chat-2";
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));

    expect(result.usage.value).toEqual({
      totalCostUsd: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      turnCount: 0,
      confirmedTurnCount: 0,
      lastUpdatedAt: null,
    });
    expect(result.lastReconciliationEvent.value).toBeNull();
  });

  it("stays idle and opens no socket when chatId is null", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const result = scope.run(() => useChatAgent(ref(null)));
    if (!result) throw new Error("effectScope did not run");

    expect(result.connectionStatus.value).toBe("idle");
    expect(result.turns.value).toEqual([]);
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("closes the previous connection and reloads history when chatId changes", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          historyResponse([{ id: "m1", role: "user", text: "first chat" }]),
        )
        .mockResolvedValueOnce(
          historyResponse([{ id: "m2", role: "user", text: "second chat" }]),
        ),
    );
    const chatId = ref("chat-1");
    const result = scope.run(() => useChatAgent(chatId));
    if (!result) throw new Error("effectScope did not run");
    await vi.waitFor(() => expect(result.turns.value).toHaveLength(1));
    const firstSocket = await latestSocket();
    firstSocket.simulateOpen();

    chatId.value = "chat-2";
    await vi.waitFor(() =>
      expect(result.turns.value).toEqual([
        {
          id: "m2",
          role: "user",
          content: "second chat",
          status: "done",
          errorDetail: null,
          attachments: [],
        },
      ]),
    );

    expect(firstSocket.readyState).toBe(MockWebSocket.CLOSED);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("settles a turn that reaches done:true with no explicit finish part", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    result.send("hi");
    const sentFrame = JSON.parse(socket.sent[0] ?? "{}") as { id: string };

    socket.simulateMessage({
      type: "cf_agent_use_chat_response",
      id: sentFrame.id,
      body: '{"type":"text-delta","id":"a","delta":"partial"}',
      done: true,
    });

    expect(result.turns.value[1]).toMatchObject({
      content: "partial",
      status: "done",
    });
  });

  it("ignores a frame type it does not act on, such as the identity frame AgentClient consumes itself", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    socket.simulateMessage({
      type: "cf_agent_identity",
      agent: "chat-agent",
      name: "chat-1",
    });

    expect(result.turns.value).toEqual([]);
  });

  it("discards a rejected history load that settles after chatId has already moved on", async () => {
    let rejectFirstHistory: ((reason: unknown) => void) | undefined;
    const firstHistory = new Promise<Response>((_resolve, reject) => {
      rejectFirstHistory = reject;
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockReturnValueOnce(firstHistory)
        .mockResolvedValueOnce(
          historyResponse([{ id: "m2", role: "user", text: "second" }]),
        ),
    );
    const chatId = ref("chat-1");
    const result = scope.run(() => useChatAgent(chatId));
    if (!result) throw new Error("effectScope did not run");

    chatId.value = "chat-2";
    await vi.waitFor(() => expect(result.turns.value).toHaveLength(1));

    rejectFirstHistory?.(new Error("network error"));
    await Promise.resolve();
    await Promise.resolve();

    // The abandoned first chat's failure must not overwrite the second chat's already-loaded,
    // healthy state with "error".
    expect(result.turns.value).toEqual([
      {
        id: "m2",
        role: "user",
        content: "second",
        status: "done",
        errorDetail: null,
        attachments: [],
      },
    ]);
    expect(result.connectionStatus.value).not.toBe("error");
  });

  it("ignores a cf_agent_use_chat_response frame for a request it never sent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    socket.simulateMessage({
      type: "cf_agent_use_chat_response",
      id: "some-other-tabs-request",
      body: '{"type":"text-delta","id":"a","delta":"stray"}',
      done: true,
    });

    expect(result.turns.value).toEqual([]);
  });

  it("marks the assistant turn errored when the outer response frame itself reports error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    result.send("hi");
    const sentFrame = JSON.parse(socket.sent[0] ?? "{}") as { id: string };

    socket.simulateMessage({
      type: "cf_agent_use_chat_response",
      id: sentFrame.id,
      body: "",
      done: true,
      error: true,
    });

    expect(result.turns.value[1]).toMatchObject({
      status: "error",
      errorDetail: "The agent reported an error.",
    });
  });

  it("ignores a non-string message frame and a malformed JSON frame without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    socket.dispatchEvent(new MessageEvent("message", { data: new Blob() }));
    socket.dispatchEvent(new MessageEvent("message", { data: "not json{" }));

    expect(result.turns.value).toEqual([]);
    expect(result.connectionStatus.value).toBe("connected");
  });

  it("replaces the whole transcript on a cf_agent_chat_messages broadcast", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    socket.simulateMessage({
      type: "cf_agent_chat_messages",
      messages: [
        { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ],
    });

    expect(result.turns.value).toEqual([
      {
        id: "m1",
        role: "user",
        content: "hi",
        status: "done",
        errorDetail: null,
        attachments: [],
      },
    ]);
  });

  it("reports an error status on a raw socket error event", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const result = scope.run(() => useChatAgent(ref("chat-1")));
    if (!result) throw new Error("effectScope did not run");
    const socket = await latestSocket();
    socket.simulateOpen();

    socket.dispatchEvent(new Event("error"));

    expect(result.connectionStatus.value).toBe("error");
  });

  it("discards a history load that resolves after chatId has already moved on", async () => {
    let resolveFirstHistory: ((response: Response) => void) | undefined;
    const firstHistory = new Promise<Response>((resolve) => {
      resolveFirstHistory = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockReturnValueOnce(firstHistory)
        .mockResolvedValueOnce(
          historyResponse([{ id: "m2", role: "user", text: "second" }]),
        ),
    );
    const chatId = ref("chat-1");
    const result = scope.run(() => useChatAgent(chatId));
    if (!result) throw new Error("effectScope did not run");

    // Move on to a second chat before the first chat's history request ever resolves.
    chatId.value = "chat-2";
    await vi.waitFor(() => expect(result.turns.value).toHaveLength(1));

    // The stale first request finally resolves -- it must not clobber the second chat's state
    // or open a socket for the abandoned first chat.
    resolveFirstHistory?.(
      historyResponse([{ id: "m1", role: "user", text: "first" }]),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(result.turns.value).toEqual([
      {
        id: "m2",
        role: "user",
        content: "second",
        status: "done",
        errorDetail: null,
        attachments: [],
      },
    ]);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("closes the connection when the owning effect scope is disposed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    scope.run(() => useChatAgent(ref("chat-1")));
    const socket = await latestSocket();
    socket.simulateOpen();

    scope.stop();

    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  });
});
