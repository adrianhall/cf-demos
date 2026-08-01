<script setup lang="ts">
/**
 * A collapsed-by-default panel showing one turn's reasoning text as it streams in, separate from
 * its answer (see docs/05-AI-CHAT.md, Behavior). Only rendered by the parent transcript when a
 * turn actually produced reasoning text — a model declared `reasoning: "none"` never has any, so
 * this component itself does not decide visibility.
 *
 * Native `<details>`/`<summary>` is used rather than a custom widget: it is keyboard-operable and
 * exposes the expanded/collapsed state to assistive technology with no additional ARIA wiring.
 */
interface Props {
  /** Accumulated reasoning text streamed so far for this turn. */
  text: string;
}

defineProps<Props>();
</script>

<template>
  <details class="thinking-panel">
    <summary>Thinking</summary>
    <p class="thinking-text">{{ text }}</p>
  </details>
</template>

<style scoped>
.thinking-panel {
  background: rgb(var(--v-theme-surface-variant));
  border-radius: 0.5rem;
  margin-bottom: 0.5rem;
  padding: 0.5rem 0.75rem;
}

.thinking-panel summary {
  color: rgb(var(--v-theme-on-surface-variant));
  cursor: pointer;
  font-size: 0.8125rem;
  font-weight: 700;
  min-height: 1.75rem;
}

.thinking-text {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin: 0.5rem 0 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
</style>
