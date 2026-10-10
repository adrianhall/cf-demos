<script setup lang="ts">
import { shallowRef } from "vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import FeatherIcon from "vue-feather";

/** Properties supplied to the composer. */
interface Props {
  /** `true` while a turn is streaming — disables the textarea and Send, and shows Stop. */
  isStreaming: boolean;
}

/** Events emitted by the composer. */
interface Emits {
  /** Submit a trimmed, non-empty prompt as the next turn. */
  send: [content: string];
  /** Cancel the in-flight turn. */
  stop: [];
}

defineProps<Props>();
const emit = defineEmits<Emits>();
const draft = shallowRef("");

/** Submit a non-empty draft and clear the composer, matching the scenario's "sends and clears". */
function submit(): void {
  const value = draft.value.trim();
  if (value.length === 0) {
    return;
  }
  emit("send", value);
  draft.value = "";
}

/** Submit on Enter, but allow Shift+Enter to insert a newline instead. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
}
</script>

<template>
  <form class="chat-composer" @submit.prevent="submit">
    <label class="composer-label" for="composer-input">Message</label>
    <textarea
      id="composer-input"
      v-model="draft"
      :disabled="isStreaming"
      placeholder="Ask the model something…"
      rows="3"
      @keydown="onKeydown"
    />
    <div class="composer-actions">
      <button
        v-if="isStreaming"
        class="stop-button"
        type="button"
        @click="emit('stop')"
      >
        <FeatherIcon aria-hidden="true" size="18" type="stop-circle" />
        <span class="ml-2">Stop</span>
      </button>
      <button
        v-else
        class="send-button"
        :disabled="draft.trim().length === 0"
        type="submit"
      >
        <FeatherIcon aria-hidden="true" size="18" type="send" />
        <span class="ml-2">Send</span>
      </button>
    </div>
  </form>
</template>

<style scoped>
.chat-composer {
  align-items: end;
  border-top: 1px solid rgb(var(--v-theme-outline-variant));
  display: flex;
  gap: 0.75rem;
  padding: 1rem;
}

.composer-label {
  height: 1px;
  margin: -1px;
  overflow: hidden;
  padding: 0;
  position: absolute;
  width: 1px;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}

textarea {
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.375rem;
  color: rgb(var(--v-theme-on-surface));
  flex: 1 1 auto;
  font: inherit;
  min-height: 2.75rem;
  padding: 0.625rem 0.75rem;
  resize: vertical;
}

.composer-actions {
  flex: 0 0 auto;
}

.send-button,
.stop-button {
  align-items: center;
  border: none;
  border-radius: 0.375rem;
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  font-weight: 600;
  min-height: 2.75rem;
  padding: 0 1rem;
}

.send-button {
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
}

.send-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.stop-button {
  background: rgb(var(--v-theme-secondary));
  color: #ffffff;
}

.ml-2 {
  margin-left: 0.5rem;
}

@media (max-width: 600px) {
  .chat-composer {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
