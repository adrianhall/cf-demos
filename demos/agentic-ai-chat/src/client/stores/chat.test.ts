import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "./chat";

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
}

describe("useChatStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a new chat and remembers it in localStorage when none exists yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/chats" && init?.method === "POST") {
          return Promise.resolve(
            new Response(JSON.stringify({ chat: { id: "chat-new" } }), {
              status: 201,
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify([]), { status: 200 }),
        );
      }),
    );

    const store = useChatStore();
    await store.ensureChat();

    expect(store.chatId).toBe("chat-new");
    expect(store.initError).toBeNull();
    expect(window.localStorage.getItem("agentic-chat:current-chat-id")).toBe(
      "chat-new",
    );
  });

  it("reuses a chat id already remembered in localStorage without creating a new one", async () => {
    window.localStorage.setItem(
      "agentic-chat:current-chat-id",
      "chat-remembered",
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const store = useChatStore();
    await store.ensureChat();

    expect(store.chatId).toBe("chat-remembered");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/chats")).toBe(
      false,
    );
  });

  it("records an error and leaves chatId unset when chat creation fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 500 })),
    );

    const store = useChatStore();
    await store.ensureChat();

    expect(store.chatId).toBeNull();
    expect(store.initError).toMatch(/500/);
  });

  it("falls back to a generic message when chat creation rejects with a non-Error value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("network exploded"));

    const store = useChatStore();
    await store.ensureChat();

    expect(store.chatId).toBeNull();
    expect(store.initError).toBe("Could not start a chat.");
  });

  it("is a no-op when called again while a chat id is already set", async () => {
    window.localStorage.setItem("agentic-chat:current-chat-id", "chat-1");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const store = useChatStore();
    await store.ensureChat();
    const callCountAfterFirst = fetchMock.mock.calls.length;
    await store.ensureChat();

    expect(fetchMock.mock.calls.length).toBe(callCountAfterFirst);
  });
});
