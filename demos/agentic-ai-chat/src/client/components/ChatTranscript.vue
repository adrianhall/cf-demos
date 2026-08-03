<script setup lang="ts">
import { nextTick, useTemplateRef, watch } from "vue";
import type { ChatTurn } from "../composables/useChatAgent";
import { scrollToBottom } from "../lib/scroll";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ActivityIndicator from "./ActivityIndicator.vue";

/** Properties supplied to the conversation transcript. */
interface Props {
  /** The full conversation held in the browser tab, in chronological order. */
  turns: readonly ChatTurn[];
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
</style>
