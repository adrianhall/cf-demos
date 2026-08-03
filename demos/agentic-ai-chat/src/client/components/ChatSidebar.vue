<script setup lang="ts">
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import FeatherIcon from "vue-feather";
import type { Chat } from "../stores/chats";

/** Properties supplied to the chat sidebar (docs/06-AGENTIC-CHAT.md Phase 3, US-2). */
interface Props {
  /** The signed-in identity's own chat directory, most recently updated first. */
  chats: readonly Chat[];
  /** The currently open chat's id, or `null` before any chat is selected. */
  selectedId: string | null;
  /** `true` while the directory itself is loading (its very first load only -- a mutation's own
   * reload does not need to blank the list while it is in flight). */
  loading: boolean;
}

/** Events emitted by the chat sidebar. */
interface Emits {
  /** Request that the browser open a different chat. */
  select: [id: string];
  /** Request a new, empty chat. */
  create: [];
  /** Request removal of an existing chat. */
  remove: [id: string];
}

defineProps<Props>();
const emit = defineEmits<Emits>();

/** A chat's rendered label: its generated title, or a placeholder until one exists. */
function chatLabel(chat: Chat): string {
  return chat.title ?? "New chat";
}
</script>

<template>
  <nav class="chat-sidebar" aria-label="Chats">
    <button
      class="new-chat-button"
      type="button"
      @click="emit('create')"
    >
      <FeatherIcon aria-hidden="true" size="16" type="plus" />
      <span class="ml-2">New Chat</span>
    </button>

    <p v-if="loading && chats.length === 0" class="empty-state">Loading chats…</p>
    <p v-else-if="chats.length === 0" class="empty-state">
      No chats yet. Start one above.
    </p>
    <ul v-else class="chat-list" aria-label="Chat list">
      <li v-for="item in chats" :key="item.id" class="chat-item">
        <button
          class="chat-item-button"
          :class="{ selected: item.id === selectedId }"
          :aria-current="item.id === selectedId ? 'true' : undefined"
          type="button"
          @click="emit('select', item.id)"
        >
          <FeatherIcon aria-hidden="true" size="16" type="message-square" />
          <span class="chat-title">{{ chatLabel(item) }}</span>
        </button>
        <button
          class="remove-button"
          :aria-label="`Delete chat: ${chatLabel(item)}`"
          type="button"
          @click="emit('remove', item.id)"
        >
          <FeatherIcon aria-hidden="true" size="14" type="x" />
        </button>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.chat-sidebar {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  height: 100%;
  padding: 1rem;
}

.new-chat-button {
  align-items: center;
  background: rgb(var(--v-theme-primary));
  border: none;
  border-radius: 0.375rem;
  color: rgb(var(--v-theme-on-primary));
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  font-weight: 600;
  justify-content: center;
  min-height: 2.5rem;
  padding: 0.5rem 1rem;
}

.ml-2 {
  margin-left: 0.5rem;
}

.chat-list {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 0.125rem;
  list-style: none;
  margin: 0;
  overflow-y: auto;
  padding: 0;
}

.chat-item {
  align-items: stretch;
  display: flex;
  gap: 0.25rem;
}

.chat-item-button {
  align-items: center;
  background: transparent;
  border: none;
  border-radius: 0.375rem;
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  display: flex;
  flex: 1 1 auto;
  font: inherit;
  gap: 0.5rem;
  min-height: 2.5rem;
  min-width: 0;
  overflow: hidden;
  padding: 0.375rem 0.5rem;
  text-align: start;
}

.chat-item-button:hover,
.chat-item-button:focus-visible {
  background: rgb(var(--v-theme-surface-variant));
}

.chat-item-button.selected {
  background: rgb(var(--v-theme-surface-variant));
  font-weight: 600;
}

.chat-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remove-button {
  align-items: center;
  background: transparent;
  border: none;
  border-radius: 0.375rem;
  color: rgb(var(--v-theme-on-surface-variant));
  cursor: pointer;
  display: flex;
  flex: 0 0 auto;
  justify-content: center;
  min-height: 2.5rem;
  min-width: 2.5rem;
  opacity: 0.7;
}

.remove-button:hover,
.remove-button:focus-visible {
  opacity: 1;
}

.empty-state {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
}
</style>
