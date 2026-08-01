<script setup lang="ts">
import { nextTick, useTemplateRef, watch } from "vue";
import type { ChatTurn } from "../stores/chat";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ActivityIndicator from "./ActivityIndicator.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ThinkingPanel from "./ThinkingPanel.vue";

/** Properties supplied to the conversation transcript. */
interface Props {
  /** The full conversation held in the browser tab, in chronological order. */
  turns: ChatTurn[];
}

const props = defineProps<Props>();
const scrollRegion = useTemplateRef<HTMLDivElement>("scroll-region");

/** `true` once a turn has received its first `thinking`/`answer` delta. */
function hasFirstToken(turn: ChatTurn): boolean {
  return turn.thinking.length > 0 || turn.answer.length > 0;
}

/** Format a millisecond duration for the per-turn latency footer. */
function formatMs(value: number): string {
  return `${Math.round(value).toLocaleString()} ms`;
}

// Keep the newest content in view as turns are added or a turn's answer streams in. `props.turns`
// is replaced wholesale on every delta (see `stores/chat.ts`'s `patchTurn`/`applyFrame`), so a
// shallow watch fires on every token without needing to watch each turn's `answer` individually.
watch(
  () => props.turns,
  async () => {
    await nextTick();
    const region = scrollRegion.value;
    if (region !== null) {
      region.scrollTop = region.scrollHeight;
    }
  },
);
</script>

<template>
  <div ref="scroll-region" class="chat-transcript" role="log">
    <p v-if="turns.length === 0" class="empty-state">
      No messages yet. Ask the model something to get started.
    </p>

    <article v-for="turn in turns" :key="turn.id" class="turn">
      <div class="bubble user-bubble">
        <p class="bubble-label">You</p>
        <p class="bubble-text">{{ turn.userContent }}</p>
      </div>

      <div class="bubble assistant-bubble">
        <p class="bubble-label">{{ turn.modelDisplayName }}</p>

        <ActivityIndicator
          v-if="turn.status === 'streaming' && !hasFirstToken(turn)"
        />

        <ThinkingPanel v-if="turn.thinking.length > 0" :text="turn.thinking" />

        <p v-if="turn.answer.length > 0" class="bubble-text">{{ turn.answer }}</p>

        <p v-if="turn.status === 'error'" class="turn-error" role="alert">
          {{ turn.errorDetail }}
        </p>
        <p v-else-if="turn.status === 'stopped'" class="turn-notice" role="status">
          Generation stopped.
        </p>

        <dl v-if="turn.status !== 'streaming'" class="turn-stats">
          <template v-if="turn.ttftMs !== null">
            <dt>First token</dt>
            <dd>{{ formatMs(turn.ttftMs) }}</dd>
          </template>
          <template v-if="turn.totalMs !== null">
            <dt>Total time</dt>
            <dd>{{ formatMs(turn.totalMs) }}</dd>
          </template>
          <template v-if="turn.usage !== null">
            <dt>Tokens</dt>
            <dd>
              {{ turn.usage.promptTokens }} prompt / {{ turn.usage.completionTokens }} completion
            </dd>
          </template>
        </dl>
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

.turn-notice {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin: 0.5rem 0 0;
}

.turn-stats {
  color: rgb(var(--v-theme-on-surface-variant));
  display: flex;
  flex-wrap: wrap;
  font-size: 0.75rem;
  gap: 0.25rem 1rem;
  margin: 0.5rem 0 0;
}

.turn-stats dt {
  font-weight: 700;
}

.turn-stats dt::after {
  content: ":";
}

.turn-stats dt,
.turn-stats dd {
  display: inline;
  margin: 0;
}
</style>
