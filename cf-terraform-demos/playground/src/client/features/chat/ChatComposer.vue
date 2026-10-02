<script setup lang="ts">
/**
 * ChatGPT-style composer shared by the welcome and conversation states.
 *
 * The textarea is the visual centre of one rounded surface. Secondary controls live in its footer:
 * model selection and sampling on the left, run details/new conversation when applicable, and the
 * send or stop control on the right. Keeping the model in the composer makes it clear which model
 * the next message will use without introducing a separate settings section above the chat.
 */
import { nextTick, useTemplateRef, watch } from 'vue';
import { MAX_MESSAGE_CHARACTERS, MAX_TEMPERATURE, MIN_TEMPERATURE } from '../../../chat';
import InfoButton from '../../components/InfoButton.vue';
import type { CatalogueModel } from '../../stores/catalogue';

const props = defineProps<{
  /**
   * Reviewed models available for Chat.
   */
  models: CatalogueModel[];
  /**
   * Whether the current draft can be sent.
   */
  canSend: boolean;
  /**
   * Whether an answer is currently streaming.
   */
  streaming: boolean;
  /**
   * Whether there is a conversation that can be cleared.
   */
  hasConversation: boolean;
  /**
   * Whether a completed receipt exists for the run-details modal.
   */
  hasRunDetails: boolean;
  /**
   * Whether the sampling control is expanded.
   */
  showSampling: boolean;
}>();

const emit = defineEmits<{
  /**
   * Submit the current draft.
   */
  submit: [];
  /**
   * Cancel the stream in flight.
   */
  cancel: [];
  /**
   * Start a fresh conversation.
   */
  reset: [];
  /**
   * Open details for the most recent completed run.
   */
  showRunDetails: [];
  /**
   * Toggle the sampling control.
   */
  toggleSampling: [];
}>();

/**
 * Editable message text.
 */
const draft = defineModel<string>('draft', { required: true });

/**
 * Model the next message will use.
 */
const model = defineModel<string>('model', { required: true });

/**
 * Optional sampling temperature.
 */
const temperature = defineModel<number | undefined>('temperature', { required: true });

const input = useTemplateRef<HTMLTextAreaElement>('input');

/**
 * Fits the editor to its text up to the CSS maximum.
 *
 * @returns Nothing; the textarea height is updated in place.
 */
function resizeInput(): void {
  const element = input.value;
  if (element === null) {
    return;
  }

  element.style.height = 'auto';
  element.style.height = `${Math.min(element.scrollHeight, 192)}px`;
}

/**
 * Moves keyboard focus to the message editor.
 *
 * Exposed narrowly so the parent can restore focus when welcome and conversation layouts replace
 * one another. The parent does not need access to any other composer internals.
 *
 * @returns Nothing.
 */
function focus(): void {
  input.value?.focus();
}

defineExpose({ focus });

watch(
  draft,
  async () => {
    await nextTick();
    resizeInput();
  },
  { immediate: true }
);

/**
 * Sends on Enter and inserts a line break on Shift+Enter.
 *
 * @param event The textarea keydown.
 * @returns Nothing; submit is emitted only for an unmodified, non-composition Enter.
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (props.canSend) {
      emit('submit');
    }
  }
}
</script>

<template>
  <form class="composer" aria-label="Send a message" @submit.prevent="emit('submit')">
    <label class="visually-hidden" for="chat-input">Message</label>
    <p id="chat-input-hint" class="visually-hidden">
      Up to {{ MAX_MESSAGE_CHARACTERS.toLocaleString() }} characters. Enter sends; Shift+Enter adds
      a line.
    </p>
    <textarea
      id="chat-input"
      ref="input"
      v-model="draft"
      class="chat-input"
      rows="1"
      :maxlength="MAX_MESSAGE_CHARACTERS"
      aria-describedby="chat-input-hint"
      placeholder="Message Playground"
      @keydown="onKeydown"
    ></textarea>

    <div v-show="props.showSampling" id="sampling-options" class="sampling">
      <label class="sampling-label" for="temperature-input">
        Temperature: {{ temperature ?? 'model default' }}
      </label>
      <input
        id="temperature-input"
        v-model.number="temperature"
        class="temperature-input"
        type="range"
        :min="MIN_TEMPERATURE"
        :max="MAX_TEMPERATURE"
        step="0.1"
      />
      <p class="sampling-hint">Higher values vary the wording; they do not improve accuracy.</p>
    </div>

    <div class="composer-footer">
      <div class="composer-tools">
        <label class="visually-hidden" for="model-select">Model</label>
        <select id="model-select" v-model="model" class="model-select">
          <option v-for="candidate in props.models" :key="candidate.id" :value="candidate.id">
            {{ candidate.name }}
          </option>
        </select>

        <button
          type="button"
          class="tool-button"
          :class="{ 'tool-button--active': props.showSampling }"
          :aria-expanded="props.showSampling"
          aria-controls="sampling-options"
          title="Temperature options"
          @click="emit('toggleSampling')"
        >
          <span>Temperature</span>
          <span class="visually-hidden"> options</span>
        </button>

        <InfoButton
          v-if="props.hasRunDetails"
          class="run-details-button"
          label="Run details for the most recent answer, including reported cost"
          @activate="emit('showRunDetails')"
        />

        <button
          v-if="props.hasConversation && !props.streaming"
          type="button"
          class="new-chat-button"
          title="Start a new conversation"
          @click="emit('reset')"
        >
          New chat
        </button>
      </div>

      <span class="counter" aria-hidden="true">
        {{ [...draft].length.toLocaleString() }} / {{ MAX_MESSAGE_CHARACTERS.toLocaleString() }}
      </span>

      <!--
        One stable button rather than swapping Send and Stop elements. Keyboard focus stays on the
        control while its purpose changes during a stream instead of being lost when the focused
        Send node is unmounted.
      -->
      <button
        :type="props.streaming ? 'button' : 'submit'"
        class="send-control"
        :class="{ 'stop-control': props.streaming }"
        :disabled="!props.streaming && !props.canSend"
        :aria-label="props.streaming ? 'Stop generating' : 'Send message'"
        :title="props.streaming ? 'Stop generating' : 'Send message'"
        @click="props.streaming ? emit('cancel') : undefined"
      >
        <span v-if="props.streaming" class="stop-icon" aria-hidden="true"></span>
        <span v-else class="send-icon" aria-hidden="true">↑</span>
      </button>
    </div>
  </form>
</template>

<style scoped>
.composer {
  background-color: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-outline-variant));
  border-radius: 1.25rem;
  box-shadow: 0 0.5rem 1.5rem rgb(0 0 0 / 18%);
  box-sizing: border-box;
  padding: 0.75rem;
  width: 100%;
}

.composer:focus-within {
  border-color: rgb(var(--v-theme-primary));
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.chat-input {
  background: transparent;
  border: none;
  box-sizing: border-box;
  color: rgb(var(--v-theme-on-surface));
  display: block;
  font: inherit;
  line-height: 1.5;
  max-height: 12rem;
  min-height: 2rem;
  outline: none;
  overflow-y: auto;
  padding: 0.25rem 0.375rem 0.5rem;
  resize: none;
  width: 100%;
}

.chat-input::placeholder {
  color: rgb(var(--v-theme-on-surface-variant));
}

.composer-footer,
.composer-tools {
  align-items: center;
  display: flex;
  gap: 0.5rem;
  min-width: 0;
}

.composer-footer {
  justify-content: space-between;
}

.composer-tools {
  flex: 1 1 auto;
  flex-wrap: wrap;
}

.model-select,
.tool-button,
.new-chat-button {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 999px;
  color: rgb(var(--v-theme-on-surface-variant));
  font: inherit;
  font-size: 0.8125rem;
  min-height: 2rem;
  padding: 0.25rem 0.625rem;
}

.model-select:hover,
.model-select:focus-visible,
.tool-button:hover,
.tool-button:focus-visible,
.new-chat-button:hover,
.new-chat-button:focus-visible,
.tool-button--active {
  background-color: rgb(var(--v-theme-surface-variant));
  border-color: rgb(var(--v-theme-outline-variant));
  color: rgb(var(--v-theme-on-surface));
}

.model-select:focus-visible,
.tool-button:focus-visible,
.new-chat-button:focus-visible,
.send-control:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.tool-button,
.new-chat-button {
  cursor: pointer;
}

.counter {
  color: rgb(var(--v-theme-on-surface-variant));
  flex: 0 0 auto;
  font-size: 0.7rem;
}

.send-control {
  align-items: center;
  background-color: rgb(var(--v-theme-on-surface));
  border: none;
  border-radius: 50%;
  color: rgb(var(--v-theme-background));
  cursor: pointer;
  display: inline-flex;
  flex: 0 0 auto;
  height: 2.25rem;
  justify-content: center;
  padding: 0;
  width: 2.25rem;
}

.send-control:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}

.stop-control {
  background-color: rgb(var(--v-theme-on-surface));
}

.send-icon {
  font-size: 1.35rem;
  line-height: 1;
  transform: translateY(-0.05rem);
}

.stop-icon {
  background-color: currentcolor;
  border-radius: 0.1rem;
  height: 0.7rem;
  width: 0.7rem;
}

.sampling {
  border-top: 1px solid rgb(var(--v-theme-outline-variant));
  margin: 0.25rem 0 0.75rem;
  padding: 0.75rem 0.375rem 0;
}

.sampling-label {
  color: rgb(var(--v-theme-on-surface-variant));
  display: block;
  font-size: 0.75rem;
  margin-bottom: 0.25rem;
}

.temperature-input {
  min-height: 1.5rem;
  width: min(100%, 20rem);
}

.sampling-hint {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
  margin: 0.25rem 0 0;
}

.visually-hidden {
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  height: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
  width: 1px;
}

@media (max-width: 38rem) {
  .composer-footer {
    align-items: flex-end;
  }

  .counter {
    display: none;
  }

  .model-select {
    max-width: 12rem;
  }
}
</style>
