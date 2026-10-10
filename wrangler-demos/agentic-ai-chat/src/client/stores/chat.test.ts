import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "./chat";
import { useChatsStore } from "./chats";

/** A deterministic WebSocket test double, matching `../composables/useChatAgent.test.ts`'s. */
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

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
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

describe("useChatStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify([]), { status: 200 })),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("is idle with no turns when the chats store has nothing selected", () => {
    const store = useChatStore();

    expect(store.connectionStatus).toBe("idle");
    expect(store.turns).toEqual([]);
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("connects to whichever chat the chats store currently has selected", async () => {
    const store = useChatStore();
    const chatsStore = useChatsStore();

    chatsStore.select("chat-1");

    const socket = await latestSocket();
    expect(socket.url).toContain("chat-1");
    expect(store.connectionStatus).toBe("connecting");

    socket.simulateOpen();
    await vi.waitFor(() => expect(store.connectionStatus).toBe("connected"));
  });

  it("reconnects to the new chat when the chats store's selection changes", async () => {
    const store = useChatStore();
    const chatsStore = useChatsStore();

    chatsStore.select("chat-1");
    const firstSocket = await latestSocket();
    firstSocket.simulateOpen();
    await vi.waitFor(() => expect(store.connectionStatus).toBe("connected"));

    chatsStore.select("chat-2");

    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const secondSocket = await latestSocket();
    expect(secondSocket.url).toContain("chat-2");
    expect(firstSocket.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("exposes usage and lastReconciliationEvent, defaulting to zeroed/null", () => {
    const store = useChatStore();

    expect(store.usage).toEqual({
      totalCostUsd: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      turnCount: 0,
      confirmedTurnCount: 0,
      lastUpdatedAt: null,
    });
    expect(store.lastReconciliationEvent).toBeNull();
  });

  it("goes idle again when the chats store clears its selection", async () => {
    const store = useChatStore();
    const chatsStore = useChatsStore();
    chatsStore.select("chat-1");
    await latestSocket();

    chatsStore.selectedChatId = null;
    await vi.waitFor(() => expect(store.connectionStatus).toBe("idle"));

    expect(store.turns).toEqual([]);
  });
});
