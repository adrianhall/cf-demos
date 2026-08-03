import { defineStore } from "pinia";
import { shallowRef } from "vue";
import { useChatAgent } from "../composables/useChatAgent";

/**
 * `localStorage` key remembering the single chat this Phase 2 UI creates, so reloading the page
 * reconnects to the same chat rather than creating a new one every visit (US-1's acceptance
 * criterion). This is a deliberate, temporary bridge: Phase 3 (US-2, chat sidebar) replaces it
 * with a real D1-backed chat list (`GET /api/chats`) and a "+ New Chat" control, at which point
 * the actual conversation content still comes from durable storage either way -- only the
 * mechanism for choosing *which* chat to open changes.
 */
const CHAT_ID_STORAGE_KEY = "agentic-chat:current-chat-id";

/** Response body from `POST /api/chats`. */
interface CreateChatResponse {
  chat: { id: string };
}

/**
 * Owns the signed-in user's single active chat for this phase: creating it on first visit (or
 * recalling it from `localStorage` on a later visit), and re-exposing `useChatAgent`'s reactive
 * conversation surface (docs/06-AGENTIC-CHAT.md Section 6.2a) -- this store never speaks the
 * Agent WebSocket protocol itself.
 */
export const useChatStore = defineStore("chat", () => {
  const chatId = shallowRef<string | null>(null);
  const initializing = shallowRef(false);
  const initError = shallowRef<string | null>(null);

  const agent = useChatAgent(chatId);

  /**
   * Ensure {@link chatId} is set, creating a new chat via `POST /api/chats` only when neither a
   * `chatId` nor a remembered `localStorage` id already exists. Safe to call multiple times
   * (for example from multiple mounted components) -- a call that finds `chatId` already set or
   * an initialization already in flight is a no-op.
   */
  async function ensureChat(): Promise<void> {
    if (chatId.value !== null || initializing.value) {
      return;
    }
    initializing.value = true;
    initError.value = null;
    try {
      const remembered = window.localStorage.getItem(CHAT_ID_STORAGE_KEY);
      if (remembered !== null) {
        chatId.value = remembered;
        return;
      }
      const response = await fetch("/api/chats", { method: "POST" });
      if (!response.ok) {
        throw new Error(`Failed to create a chat (status ${response.status}).`);
      }
      const body = (await response.json()) as CreateChatResponse;
      window.localStorage.setItem(CHAT_ID_STORAGE_KEY, body.chat.id);
      chatId.value = body.chat.id;
    } catch (cause) {
      initError.value =
        cause instanceof Error ? cause.message : "Could not start a chat.";
    } finally {
      initializing.value = false;
    }
  }

  return {
    chatId,
    connectionStatus: agent.connectionStatus,
    ensureChat,
    initError,
    initializing,
    isStreaming: agent.isStreaming,
    send: agent.send,
    turns: agent.turns,
  };
});
