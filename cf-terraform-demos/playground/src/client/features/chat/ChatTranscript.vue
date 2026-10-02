<script setup lang="ts">
/**
 * Conversation transcript in the familiar assistant-chat pattern: full-width assistant answers and
 * compact user bubbles aligned to the right.
 *
 * Assistant content is rendered through {@link MarkdownContent}; user content remains escaped text.
 * That distinction is deliberate: models use Markdown as an output format, while a visitor's own
 * message should never become active HTML merely because it contains Markdown syntax.
 */
import type { ConversationTurn } from './conversation';
import MarkdownContent from './MarkdownContent.vue';

defineProps<{
  /**
   * Conversation turns, oldest first.
   */
  turns: ConversationTurn[];
}>();
</script>

<template>
  <!--
    The transcript itself is intentionally quiet while tokens stream. Making the growing answer a
    live region re-announces the whole accumulated response for every delta and floods the speech
    queue; one persistent status below reports the lifecycle instead.
  -->
  <ol v-if="turns.length > 0" class="transcript" aria-label="Conversation">
    <li v-for="turn in turns" :key="turn.id" class="turn" :class="`turn--${turn.role}`">
      <div class="turn-inner">
        <!--
          A visually compact avatar still carries a text alternative through the speaker label.
          Alignment and colour are not the only way the speakers are distinguished.
        -->
        <span v-if="turn.role === 'assistant'" class="assistant-avatar" aria-hidden="true">P</span>

        <div class="turn-body">
          <p class="turn-role">{{ turn.role === 'user' ? 'You' : 'Playground' }}</p>

          <div class="turn-content">
            <MarkdownContent v-if="turn.role === 'assistant'" :source="turn.content" />
            <p v-else class="turn-text">{{ turn.content }}</p>
            <span v-if="turn.streaming" class="cursor" aria-hidden="true"></span>
          </div>

          <p v-if="turn.role === 'assistant'" class="turn-status" role="status">
            <template v-if="turn.streaming">Generating…</template>
            <template v-else-if="turn.content === ''">No answer was generated.</template>
            <template v-else>Answer complete.</template>
          </p>
        </div>
      </div>
    </li>
  </ol>
</template>

<style scoped>
.transcript {
  display: flex;
  flex-direction: column;
  gap: 1.75rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.turn {
  display: flex;
  width: 100%;
}

.turn-inner {
  display: flex;
  gap: 0.75rem;
  min-width: 0;
}

.turn--assistant .turn-inner {
  width: 100%;
}

.turn--user {
  justify-content: flex-end;
}

.turn--user .turn-inner {
  background-color: rgb(var(--v-theme-surface-variant));
  border-radius: 1.25rem;
  max-width: min(80%, 38rem);
  padding: 0.75rem 1rem;
}

.assistant-avatar {
  align-items: center;
  background: linear-gradient(145deg, rgb(var(--v-theme-primary)), #b58cff);
  border-radius: 50%;
  color: #081020;
  display: inline-flex;
  flex: 0 0 auto;
  font-size: 0.75rem;
  font-weight: 800;
  height: 1.75rem;
  justify-content: center;
  margin-top: 0.1rem;
  width: 1.75rem;
}

.turn-body {
  min-width: 0;
}

.turn--assistant .turn-body {
  flex: 1 1 auto;
}

.turn-role {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
  font-weight: 600;
  margin: 0 0 0.375rem;
}

.turn--user .turn-role {
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  height: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
  width: 1px;
}

.turn-content {
  min-width: 0;
}

.turn-text {
  margin: 0;
  white-space: pre-wrap;
}

/*
  A thin block marks where text is still arriving. Hidden from assistive technology, which gets the
  status text instead, and deliberately does not blink for motion-sensitive visitors.
*/
.cursor {
  background-color: rgb(var(--v-theme-primary));
  display: inline-block;
  height: 1.05em;
  margin-left: 0.15rem;
  vertical-align: text-bottom;
  width: 0.45ch;
}

.turn-status {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
  margin: 0.375rem 0 0;
}

@media (max-width: 40rem) {
  .turn--user .turn-inner {
    max-width: 92%;
  }
}
</style>
