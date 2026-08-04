<script setup lang="ts">
import { nextTick, useTemplateRef, watch } from "vue";
import type { ChatTurn } from "../composables/useChatAgent";
import { scrollToBottom } from "../lib/scroll";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ActivityIndicator from "./ActivityIndicator.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import FeatherIcon from "vue-feather";

/** Properties supplied to the conversation transcript. */
interface Props {
  /** The full conversation held in the browser tab, in chronological order. */
  turns: readonly ChatTurn[];
  /** The currently open chat's id, used to build each attachment chip's download link
   * (docs/06-AGENTIC-CHAT.md Phase 9, US-8). `null` renders no chips, since there is then no
   * chat to build a download link against. */
  chatId: string | null;
}

const props = defineProps<Props>();
const scrollRegion = useTemplateRef<HTMLDivElement>("scroll-region");

// Keep the newest content in view as turns are added or a turn's content streams in.
// `props.turns` is replaced wholesale on every delta (see `useChatAgent.ts`'s `appendToTurn`), so
// a shallow watch fires on every token without needing to watch each turn's `content`
// individually (mirrors `demos/ai-chat/src/client/components/ChatTranscript.vue`).
watch(
  () => props.turns,
  async () => {
    await nextTick();
    scrollToBottom(scrollRegion.value);
  },
);

/** Build the ownership-checked download URL for one attachment (docs/06-AGENTIC-CHAT.md Phase
 * 9, US-8, `../../worker/routes/chats.ts`'s `GET /:id/files/:fileId`). */
function fileUrl(fileId: string): string {
  return `/api/chats/${encodeURIComponent(props.chatId ?? "")}/files/${encodeURIComponent(fileId)}`;
}
</script>

<template>
  <div ref="scroll-region" class="chat-transcript" role="log">
    <p v-if="turns.length === 0" class="empty-state">
      No messages yet. Ask the agent something to get started.
    </p>

    <article v-for="turn in turns" :key="turn.id" class="turn">
      <div
        class="bubble"
        :class="turn.role === 'user' ? 'user-bubble' : 'assistant-bubble'"
      >
        <p class="bubble-label">{{ turn.role === "user" ? "You" : "Agent" }}</p>

        <ActivityIndicator
          v-if="turn.status === 'streaming' && turn.content.length === 0"
        />

        <p v-if="turn.content.length > 0" class="bubble-text">{{ turn.content }}</p>

        <p v-if="turn.status === 'error'" class="turn-error" role="alert">
          {{ turn.errorDetail ?? "The agent could not complete this turn." }}
        </p>

        <ul v-if="turn.attachments.length > 0" class="attachment-list" aria-label="Attached files">
          <li v-for="attachment in turn.attachments" :key="attachment.fileId">
            <a
              class="attachment-chip"
              :href="fileUrl(attachment.fileId)"
              :download="attachment.filename"
            >
              <FeatherIcon aria-hidden="true" size="14" type="file-text" />
              <span>{{ attachment.filename }}</span>
            </a>
          </li>
        </ul>
      </div>
    </article>
  </div>
</template>

<style scoped>
.chat-transcript {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 1rem;
  overflow-y: auto;
  padding: 1rem;
}

.empty-state {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
}

.turn {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.bubble {
  border-radius: 0.75rem;
  max-width: 42rem;
  padding: 0.75rem 1rem;
}

.bubble-label {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
  font-weight: 700;
  margin: 0 0 0.25rem;
  text-transform: uppercase;
}

.bubble-text {
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.user-bubble {
  align-self: flex-end;
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
}

.user-bubble .bubble-label {
  color: rgb(var(--v-theme-on-primary));
  opacity: 0.8;
}

.assistant-bubble {
  align-self: flex-start;
  background: rgb(var(--v-theme-surface-variant));
  color: rgb(var(--v-theme-on-surface));
}

.turn-error {
  color: #b3261e;
  font-size: 0.875rem;
  font-weight: 600;
  margin: 0.5rem 0 0;
}

.attachment-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  list-style: none;
  margin: 0.5rem 0 0;
  padding: 0;
}

.attachment-chip {
  align-items: center;
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-outline-variant));
  border-radius: 999px;
  color: inherit;
  display: inline-flex;
  font-size: 0.8125rem;
  gap: 0.375rem;
  padding: 0.25rem 0.75rem;
  text-decoration: none;
}

.attachment-chip:hover,
.attachment-chip:focus-visible {
  border-color: rgb(var(--v-theme-primary));
}
</style>
