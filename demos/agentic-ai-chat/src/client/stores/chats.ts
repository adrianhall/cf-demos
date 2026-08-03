import { defineStore } from "pinia";
import { shallowRef } from "vue";

/** A chat directory entry, from `GET /api/chats`/`POST /api/chats` (docs/06-AGENTIC-CHAT.md
 * Section 6.4's `chats` table). Conversation content itself is never part of this shape -- it
 * lives entirely in the chat's own `ChatAgent` Durable Object, fetched separately by
 * `useChatAgent` once a chat is selected. */
export interface Chat {
  /** Server-generated identifier, also the owning `ChatAgent` Durable Object's instance name. */
  id: string;
  /** Verified Cloudflare Access identity that created and exclusively owns this chat. */
  ownerEmail: string;
  /** Short generated title, or `null` until the chat's first turn completes. */
  title: string | null;
  /** Selected AI Gateway dynamic route name, or `null` until Phase 4 exists. */
  route: string | null;
  /** ISO 8601 timestamp of chat creation. */
  createdAt: string;
  /** ISO 8601 timestamp of the chat's most recent activity. */
  updatedAt: string;
}

/** RFC 9457 error response shape used for safe client error messages. */
interface ProblemDetails {
  /** Human-readable explanation of the failed request. */
  detail?: string;
}

/** Read a safe error message from a failed API response. */
async function responseMessage(response: Response): Promise<string> {
  const body = (await response
    .json()
    .catch(() => null)) as ProblemDetails | null;
  return body?.detail ?? `Request failed with status ${response.status}.`;
}

/**
 * The signed-in user's own chat directory and current selection (docs/06-AGENTIC-CHAT.md
 * Phase 3, US-2) -- the sidebar's data source. Every mutation reloads the directory from the
 * Worker afterward rather than optimistically guessing the server's resulting order, mirroring
 * `demos/chat`'s own `useChannelsStore` convention.
 *
 * This store, not `useChatStore`, owns which chat is "open": `useChatStore` (the live
 * `useChatAgent` connection) reads {@link selectedChatId} reactively, so changing it here is
 * the single action that both switches the sidebar's highlighted entry and reconnects the live
 * conversation view.
 */
export const useChatsStore = defineStore("chats", () => {
  const chats = shallowRef<Chat[]>([]);
  const selectedChatId = shallowRef<string | null>(null);
  const loading = shallowRef(false);
  const error = shallowRef<string | null>(null);

  /**
   * Fetch the signed-in identity's own chat directory. If nothing is currently selected, or the
   * previous selection's chat no longer exists in the freshly loaded list (deleted from another
   * tab, for example), selects the most recently updated chat instead -- mirroring
   * `demos/chat`'s "pick a default channel, or none" pattern, applied to recency instead of a
   * fixed default name.
   */
  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response = await fetch("/api/chats");
      if (!response.ok) {
        throw new Error(await responseMessage(response));
      }
      const body = (await response.json()) as { chats: Chat[] };
      chats.value = body.chats;
      const stillExists = chats.value.some(
        (chat) => chat.id === selectedChatId.value,
      );
      if (!stillExists) {
        selectedChatId.value = chats.value[0]?.id ?? null;
      }
    } catch (cause) {
      error.value =
        cause instanceof Error ? cause.message : "Could not load chats.";
    } finally {
      loading.value = false;
    }
  }

  /**
   * Create a new, empty chat and select it immediately (US-2's "'+ New Chat' starts an empty
   * chat and adds it to the sidebar immediately" acceptance criterion), then reload the
   * directory so the list reflects the server's own ordering.
   */
  async function create(): Promise<void> {
    error.value = null;
    try {
      const response = await fetch("/api/chats", { method: "POST" });
      if (!response.ok) {
        throw new Error(await responseMessage(response));
      }
      const body = (await response.json()) as { chat: Chat };
      await load();
      selectedChatId.value = body.chat.id;
    } catch (cause) {
      error.value =
        cause instanceof Error ? cause.message : "Could not start a new chat.";
    }
  }

  /**
   * Delete a chat and reload the directory. If the deleted chat was the current selection,
   * {@link load}'s own fallback logic moves the selection to a remaining chat, or to `null` if
   * none remain (US-2's "deleting the currently open chat returns the user to a remaining chat
   * or an empty state" acceptance criterion) -- no separate bookkeeping is needed here.
   *
   * @param id Chat id to delete.
   */
  async function remove(id: string): Promise<void> {
    error.value = null;
    try {
      const response = await fetch(`/api/chats/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok && response.status !== 204) {
        throw new Error(await responseMessage(response));
      }
      await load();
    } catch (cause) {
      error.value =
        cause instanceof Error ? cause.message : "Could not delete the chat.";
    }
  }

  /**
   * Select a different chat from the sidebar. `useChatStore` reacts to this reactively --
   * calling this is the only step needed to switch the open conversation.
   *
   * @param id Chat id to select.
   */
  function select(id: string): void {
    selectedChatId.value = id;
  }

  return {
    chats,
    create,
    error,
    load,
    loading,
    remove,
    select,
    selectedChatId,
  };
});
