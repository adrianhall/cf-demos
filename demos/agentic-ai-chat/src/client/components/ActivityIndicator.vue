<script setup lang="ts">
/**
 * Animated "thinking" dots shown from submit until the first token arrives, so a model's cold
 * start and prefill time is visible instead of looking like a hang (mirrors
 * `demos/ai-chat/src/client/components/ActivityIndicator.vue`). The dots stop animating under
 * `prefers-reduced-motion: reduce` (handled entirely in this component's scoped CSS media
 * query); the text label still conveys the state either way.
 */
</script>

<template>
  <p class="activity-indicator" role="status">
    <span class="dots" aria-hidden="true">
      <span class="dot" />
      <span class="dot" />
      <span class="dot" />
    </span>
    <span class="label">Waiting for the agent to respond…</span>
  </p>
</template>

<style scoped>
.activity-indicator {
  align-items: center;
  color: rgb(var(--v-theme-on-surface-variant));
  display: flex;
  font-size: 0.875rem;
  gap: 0.5rem;
  margin: 0;
}

.dots {
  display: inline-flex;
  gap: 0.25rem;
}

.dot {
  animation: activity-bounce 1.2s infinite ease-in-out;
  background: rgb(var(--v-theme-primary));
  border-radius: 50%;
  display: inline-block;
  height: 0.5rem;
  width: 0.5rem;
}

.dot:nth-child(2) {
  animation-delay: 0.15s;
}

.dot:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes activity-bounce {
  0%,
  80%,
  100% {
    opacity: 0.3;
    transform: translateY(0);
  }
  40% {
    opacity: 1;
    transform: translateY(-0.25rem);
  }
}

@media (prefers-reduced-motion: reduce) {
  .dot {
    animation: none;
    opacity: 1;
  }
}
</style>
