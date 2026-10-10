<script setup lang="ts">
import { computed, shallowRef } from "vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import FeatherIcon from "vue-feather";
import { useVoiceDictation } from "../composables/useVoiceDictation";

/** Properties supplied to the composer. */
interface Props {
  /** `true` while a turn is streaming -- disables the textarea and Send control. */
  isStreaming: boolean;
  /** `true` while there is no live connection to submit a turn over. */
  disabled: boolean;
}

/** Events emitted by the composer. */
interface Emits {
  /** Submit a trimmed, non-empty prompt as the next turn. */
  send: [content: string];
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();
const draft = shallowRef("");

/** Submit a non-empty draft and clear the composer. */
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

// docs/06-AGENTIC-CHAT.md Phase 5, US-4: voice-to-prompt dictation. `useVoiceDictation` is the
// one place this component speaks the `MediaRecorder`/`getUserMedia` browser APIs; this
// component only reacts to its reactive `state`/`errorMessage` and calls `start()`/`stop()`.
// Destructuring the returned refs into top-level `<script setup>` bindings (rather than keeping
// them nested under one object) is what lets the template reference them directly, unwrapped,
// the same way `draft` above already is.
const {
  state: dictationState,
  errorMessage: dictationError,
  start: startDictation,
  stop: stopDictation,
} = useVoiceDictation(onTranscribed);

/**
 * Populate (never submit) the composer with a successful transcription (US-4's acceptance
 * criterion). Appends to, rather than replaces, any text already drafted -- so dictating never
 * silently discards something the user had already typed -- separated by a single space when
 * the composer is non-empty.
 */
function onTranscribed(text: string): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return;
  }
  const existing = draft.value.trimEnd();
  draft.value = existing.length > 0 ? `${existing} ${trimmed}` : trimmed;
}

/** Start recording, or stop and transcribe if already recording. */
function toggleDictation(): void {
  if (dictationState.value === "recording") {
    stopDictation();
  } else {
    startDictation();
  }
}

/** `true` while the dictation control cannot currently be interacted with -- either because the
 * composer itself is disabled/streaming, or because a permission request/transcription is
 * already in flight (there is nothing to toggle mid-flight; `recording` itself stays
 * interactive so the user can press it again to stop). */
const dictationButtonDisabled = computed(
  () =>
    props.isStreaming ||
    props.disabled ||
    dictationState.value === "requesting-permission" ||
    dictationState.value === "transcribing",
);

/** Accessible label for the mic control, reflecting its current lifecycle state. */
const dictationButtonLabel = computed(() => {
  switch (dictationState.value) {
    case "recording":
      return "Stop recording and transcribe";
    case "requesting-permission":
      return "Requesting microphone access…";
    case "transcribing":
      return "Transcribing your recording…";
    default:
      return "Start voice dictation";
  }
});
</script>

<template>
  <form class="chat-composer" @submit.prevent="submit">
    <div class="composer-row">
      <label class="composer-label" for="composer-input">Message</label>
      <textarea
        id="composer-input"
        v-model="draft"
        :disabled="isStreaming || disabled"
        placeholder="Ask the agent something…"
        rows="3"
        @keydown="onKeydown"
      />
      <div class="composer-actions">
        <button
          :aria-label="dictationButtonLabel"
          :aria-pressed="dictationState === 'recording'"
          class="dictate-button"
          :class="{ recording: dictationState === 'recording' }"
          :disabled="dictationButtonDisabled"
          type="button"
          @click="toggleDictation"
        >
          <FeatherIcon
            v-if="dictationState === 'requesting-permission' || dictationState === 'transcribing'"
            animation="spin"
            aria-hidden="true"
            size="18"
            type="loader"
          />
          <FeatherIcon
            v-else
            aria-hidden="true"
            size="18"
            :type="dictationState === 'recording' ? 'mic-off' : 'mic'"
          />
        </button>
        <button
          class="send-button"
          :disabled="isStreaming || disabled || draft.trim().length === 0"
          type="submit"
        >
          <FeatherIcon aria-hidden="true" size="18" type="send" />
          <span class="ml-2">Send</span>
        </button>
      </div>
    </div>
    <p v-if="dictationError" class="dictation-error" role="alert">
      {{ dictationError }}
    </p>
  </form>
</template>

<style scoped>
.chat-composer {
  border-top: 1px solid rgb(var(--v-theme-outline-variant));
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1rem;
}

.composer-row {
  align-items: end;
  display: flex;
  gap: 0.75rem;
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
  display: flex;
  flex: 0 0 auto;
  gap: 0.5rem;
}

.dictate-button {
  align-items: center;
  background: transparent;
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.375rem;
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  display: inline-flex;
  justify-content: center;
  min-height: 2.75rem;
  min-width: 2.75rem;
}

.dictate-button.recording {
  background: rgba(179, 38, 30, 0.12);
  border-color: #b3261e;
  color: #b3261e;
}

.dictate-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.dictation-error {
  color: #b3261e;
  font-weight: 600;
  margin: 0;
}

.send-button {
  align-items: center;
  background: rgb(var(--v-theme-primary));
  border: none;
  border-radius: 0.375rem;
  color: rgb(var(--v-theme-on-primary));
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  font-weight: 600;
  min-height: 2.75rem;
  padding: 0 1rem;
}

.send-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
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
