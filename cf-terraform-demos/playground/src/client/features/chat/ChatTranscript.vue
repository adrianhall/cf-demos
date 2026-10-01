<script setup lang="ts">
import type { ConversationTurn } from './conversation';

defineProps<{
  /**
   * Conversation turns, oldest first.
   */
  turns: ConversationTurn[];
}>();
</script>

<template>
  <!--
    `aria-live="polite"` on the transcript rather than on each turn, so a screen reader announces
    new text as it streams instead of staying silent until the visitor goes looking for it.
    `polite` because an assertive region would interrupt on every delta, which is unusable.
    `aria-atomic="false"` so only the added text is announced rather than the whole conversation
    being re-read on every increment.
  -->
  <ol
    v-if="turns.length > 0"
    class="transcript"
    aria-label="Conversation"
    aria-live="polite"
    aria-atomic="false"
  >
    <li v-for="turn in turns" :key="turn.id" class="turn" :class="`turn--${turn.role}`">
      <!--
        The speaker is a real text label, not a colour or an alignment. A transcript that
        distinguishes speakers only by which side of the screen they sit on conveys nothing to a
        screen reader and nothing on a narrow viewport.
      -->
      <p class="turn-role">{{ turn.role === 'user' ? 'You' : 'Assistant' }}</p>
      <div class="turn-content">
        <!--
          `white-space: pre-wrap` via the stylesheet rather than rendering Markdown. The panel is
          about tokens and cost, and passing model output through a Markdown renderer would be an
          HTML-injection surface added for presentation alone.
        -->
        <p class="turn-text">{{ turn.content }}</p>
        <span v-if="turn.streaming" class="cursor" aria-hidden="true"></span>
      </div>
      <p v-if="turn.streaming" class="turn-status">Generating…</p>
      <p v-else-if="turn.role === 'assistant' && turn.content === ''" class="turn-status">
        No answer was generated.
      </p>
    </li>
  </ol>
</template>

<style scoped>
.transcript {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.turn {
  border-radius: 0.75rem;
  padding: 0.875rem 1rem;
}

.turn--user {
  background-color: rgb(var(--v-theme-surface-variant));
}

.turn--assistant {
  border: 1px solid rgb(var(--v-theme-outline-variant));
}

.turn-role {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  margin: 0 0 0.375rem;
  text-transform: uppercase;
}

.turn-content {
  display: flex;
  gap: 0.125rem;
}

.turn-text {
  margin: 0;
  /* Preserves the paragraph breaks and indentation a model puts in its answer. */
  white-space: pre-wrap;
}

/*
  A thin block that marks where text is still arriving. Hidden from assistive technology, which
  gets the "Generating…" status instead, and it does not blink: a blinking element is both a
  distraction and a motion-sensitivity problem for a decoration this small.
*/
.cursor {
  align-self: flex-end;
  background-color: rgb(var(--v-theme-primary));
  display: inline-block;
  height: 1.05em;
  width: 0.5ch;
}

.turn-status {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
  margin: 0.375rem 0 0;
}
</style>
