<script setup lang="ts">
/**
 * Empty-state introduction for Chat.
 *
 * A first visit has no transcript to anchor the page, so the composer sits under one short prompt
 * and a set of prepared questions. The pills load text without sending it: spending credit must
 * remain an explicit second action, even when the starting question came from the application.
 */
import { CHAT_EXAMPLES, type ChatExample } from './examples';

const emit = defineEmits<{
  /**
   * A prepared question was chosen.
   */
  choose: [example: ChatExample];
}>();
</script>

<template>
  <section class="welcome" aria-labelledby="chat-welcome-heading">
    <h2 id="chat-welcome-heading" class="welcome-heading">What can I help you explore?</h2>
    <p class="welcome-subtitle">Choose a starting point or ask your own question.</p>

    <div class="examples" role="group" aria-label="Suggested questions">
      <button
        v-for="example in CHAT_EXAMPLES"
        :key="example.id"
        type="button"
        class="example-button"
        :data-example="example.id"
        :title="example.teaches"
        @click="emit('choose', example)"
      >
        {{ example.label }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.welcome {
  text-align: center;
}

.welcome-heading {
  font-size: clamp(1.6rem, 4vw, 2.25rem);
  font-weight: 600;
  letter-spacing: -0.025em;
  margin: 0;
}

.welcome-subtitle {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0.5rem 0 1.25rem;
}

.examples {
  display: flex;
  flex-wrap: wrap;
  gap: 0.625rem;
  justify-content: center;
}

.example-button {
  background-color: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-outline-variant));
  border-radius: 999px;
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  min-height: 2.5rem;
  padding: 0.5rem 1rem;
}

.example-button:hover,
.example-button:focus-visible {
  background-color: rgb(var(--v-theme-surface-variant));
  border-color: rgb(var(--v-theme-primary));
}

.example-button:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}
</style>
