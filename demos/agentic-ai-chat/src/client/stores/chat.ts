import { defineStore } from "pinia";
import { computed } from "vue";
import { useChatAgent } from "../composables/useChatAgent";
import { useChatsStore } from "./chats";

/**
 * Re-exposes `useChatAgent`'s reactive conversation surface (docs/06-AGENTIC-CHAT.md Section
 * 6.2a) for whichever chat `useChatsStore` currently has selected -- this store never speaks
 * the Agent WebSocket protocol itself, and (since Phase 3) never decides *which* chat is open
 * either. `chatId` is a `computed`, not a store of its own: switching `chatsStore.selectedChatId`
 * (via `select()`/`create()`/`remove()`'s own fallback logic) is the single action that both
 * updates the sidebar's highlighted entry and reconnects this store's live conversation view --
 * there is nothing else to keep in sync.
 */
export const useChatStore = defineStore("chat", () => {
  const chatsStore = useChatsStore();
  const chatId = computed(() => chatsStore.selectedChatId);
  const agent = useChatAgent(chatId);

  return {
    connectionStatus: agent.connectionStatus,
    isStreaming: agent.isStreaming,
    metadataUpdatedAt: agent.metadataUpdatedAt,
    send: agent.send,
    turns: agent.turns,
  };
});
