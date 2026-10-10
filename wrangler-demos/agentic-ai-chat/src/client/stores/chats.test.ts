import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyUsageSummary } from "../composables/useChatAgent";
import { type Chat, useChatsStore } from "./chats";

/** A stable chat fixture returned by mocked API responses. */
function chat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    ownerEmail: "alice@example.com",
    title: null,
    route: "basic",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    usage: emptyUsageSummary(),
    ...overrides,
  };
}

/** Build a JSON response with the requested HTTP status. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("useChatsStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the chat directory", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ chats: [chat()] }));
    vi.stubGlobal("fetch", fetch);
    const store = useChatsStore();

    await store.load();

    expect(fetch).toHaveBeenCalledWith("/api/chats");
    expect(store.chats).toEqual([chat()]);
    expect(store.loading).toBe(false);
  });

  it("selects the most recently updated chat when nothing was selected yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          chats: [chat({ id: "newest" }), chat({ id: "older" })],
        }),
      ),
    );
    const store = useChatsStore();

    await store.load();

    expect(store.selectedChatId).toBe("newest");
  });

  it("leaves selection null when the directory is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ chats: [] })),
    );
    const store = useChatsStore();

    await store.load();

    expect(store.selectedChatId).toBeNull();
  });

  it("keeps an existing selection that is still present after reloading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          chats: [chat({ id: "newest" }), chat({ id: "already-selected" })],
        }),
      ),
    );
    const store = useChatsStore();
    store.select("already-selected");

    await store.load();

    expect(store.selectedChatId).toBe("already-selected");
  });

  it("falls back to the newest chat when the current selection no longer exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ chats: [chat({ id: "newest" })] })),
    );
    const store = useChatsStore();
    store.select("deleted-elsewhere");

    await store.load();

    expect(store.selectedChatId).toBe("newest");
  });

  it("stores a problem-detail message when loading fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ detail: "Access expired." }, 401)),
    );
    const store = useChatsStore();

    await store.load();

    expect(store.error).toBe("Access expired.");
  });

  it("uses a safe message when loading rejects a non-Error value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
    const store = useChatsStore();

    await store.load();

    expect(store.error).toBe("Could not load chats.");
  });

  it("creates a chat, selects it, and reloads the directory from the server", async () => {
    const created = chat({ id: "new-chat" });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ chat: created }, 201))
      .mockResolvedValueOnce(
        jsonResponse({ chats: [created, chat({ id: "older" })] }),
      );
    vi.stubGlobal("fetch", fetch);
    const store = useChatsStore();

    await store.create();

    expect(fetch).toHaveBeenNthCalledWith(1, "/api/chats", { method: "POST" });
    expect(store.chats).toEqual([created, chat({ id: "older" })]);
    expect(store.selectedChatId).toBe("new-chat");
  });

  it("falls back to a generic message when creation rejects with a non-Error value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("network exploded"));
    const store = useChatsStore();

    await store.create();

    expect(store.error).toBe("Could not start a new chat.");
  });

  it("stores an error without touching the selection when creation fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 500 })),
    );
    const store = useChatsStore();

    await store.create();

    expect(store.error).toMatch(/500/);
    expect(store.selectedChatId).toBeNull();
  });

  it("deletes a chat and reloads the directory from the server", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ chats: [chat({ id: "older" })] }));
    vi.stubGlobal("fetch", fetch);
    const store = useChatsStore();

    await store.remove("chat-1");

    expect(fetch).toHaveBeenNthCalledWith(1, "/api/chats/chat-1", {
      method: "DELETE",
    });
    expect(store.chats).toEqual([chat({ id: "older" })]);
  });

  it("moves the selection to a remaining chat after deleting the currently selected one", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        jsonResponse({ chats: [chat({ id: "remaining" })] }),
      );
    vi.stubGlobal("fetch", fetch);
    const store = useChatsStore();
    store.select("chat-1");

    await store.remove("chat-1");

    expect(store.selectedChatId).toBe("remaining");
  });

  it("leaves the selection null after deleting the only chat", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ chats: [] }));
    vi.stubGlobal("fetch", fetch);
    const store = useChatsStore();
    store.select("chat-1");

    await store.remove("chat-1");

    expect(store.selectedChatId).toBeNull();
  });

  it("falls back to a generic message when deletion rejects with a non-Error value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("network exploded"));
    const store = useChatsStore();

    await store.remove("chat-1");

    expect(store.error).toBe("Could not delete the chat.");
  });

  it("stores an error and does not reload when deletion fails", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ detail: "Not found." }, 404));
    vi.stubGlobal("fetch", fetch);
    const store = useChatsStore();

    await store.remove("missing");

    expect(store.error).toBe("Not found.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("updates the selection directly via select()", () => {
    const store = useChatsStore();

    store.select("chat-2");

    expect(store.selectedChatId).toBe("chat-2");
  });

  it("changes a chat's route with a PATCH request and reloads the directory from the server", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ chat: chat({ route: "reasoning" }) }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ chats: [chat({ route: "reasoning" })] }),
      );
    vi.stubGlobal("fetch", fetch);
    const store = useChatsStore();

    await store.setRoute("chat-1", "reasoning");

    expect(fetch).toHaveBeenNthCalledWith(1, "/api/chats/chat-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ route: "reasoning" }),
    });
    expect(store.chats).toEqual([chat({ route: "reasoning" })]);
  });

  it("stores a problem-detail message when changing the route is rejected (already started)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            detail:
              "This chat's route can only be changed before its first turn completes.",
          },
          422,
        ),
      ),
    );
    const store = useChatsStore();

    await store.setRoute("chat-1", "reasoning");

    expect(store.error).toBe(
      "This chat's route can only be changed before its first turn completes.",
    );
  });

  it("falls back to a generic message when changing the route rejects with a non-Error value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("network exploded"));
    const store = useChatsStore();

    await store.setRoute("chat-1", "reasoning");

    expect(store.error).toBe("Could not change the chat's mode.");
  });
});
