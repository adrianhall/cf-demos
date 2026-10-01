<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { MAX_MESSAGE_CHARACTERS, MAX_TEMPERATURE, MIN_TEMPERATURE } from '../../chat';
import { findTask } from '../../tasks';
import PanelPage from '../components/PanelPage.vue';
import RunDetails from '../components/runs/RunDetails.vue';
import ChatTranscript from '../features/chat/ChatTranscript.vue';
import { CHAT_EXAMPLES, type ChatExample } from '../features/chat/examples';
import { useChat } from '../features/chat/useChat';
import { useCatalogueStore } from '../stores/catalogue';

const task = computed(() => findTask('chat'));
const catalogue = useCatalogueStore();

const {
  turns,
  draft,
  model,
  temperature,
  streaming,
  error,
  receipt,
  metrics,
  costPending,
  canSend,
  send,
  cancel,
  reset
} = useChat({ initialModel: '' });

/**
 * Whether the advanced controls are shown.
 *
 * Collapsed by default: temperature is meaningful to someone who already knows what it does, and
 * putting it in front of everyone else is noise above the thing they came to use.
 */
const showOptions = ref(false);

/**
 * Reviewed models available for this panel, as the server reported them.
 *
 * Read from the catalogue endpoint rather than hard-coded, because the server is what decides which
 * models it will accept. A browser-side list could offer a model the API then rejects.
 */
const models = computed(() => catalogue.modelsForTask('chat'));

/**
 * The descriptor for the selected model, used for its documentation link and context window.
 */
const selectedModel = computed(() => models.value.find((entry) => entry.id === model.value));

onMounted(async () => {
  await catalogue.load();
  // The first reviewed model becomes the default, so the catalogue's order is the preference order
  // and there is no second list to keep in step with it.
  const first = models.value[0];
  if (model.value === '' && first !== undefined) {
    model.value = first.id;
  }
});

/**
 * Loads a prepared example into the editor.
 *
 * @param example Example to load.
 * @returns Nothing; the draft is replaced. It is not sent automatically — a prepared prompt that
 *   spent money the moment it was clicked would be a trap in a panel that bills per request.
 */
function loadExample(example: ChatExample): void {
  draft.value = example.prompt;
}

/**
 * Sends the draft from a keyboard shortcut.
 *
 * @param event The keydown event.
 * @returns Nothing; the run starts when Enter is pressed without Shift.
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
}
</script>

<template>
  <PanelPage v-if="task" :task="task">
    <div class="chat">
      <!--
        Stated before the first request rather than in a footnote afterwards. The demo records the
        visitor's verified email in AI Gateway metadata, and they are entitled to know that before
        they send anything rather than after.
      -->
      <p class="attribution" role="note">
        This panel calls a real model and spends real inference credit. Your verified email is
        recorded in the AI Gateway log for each request so spending can be attributed; your prompt
        and the answer are not stored.
      </p>

      <ChatTranscript :turns="turns" />

      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <section class="composer" aria-labelledby="composer-heading">
        <h2 id="composer-heading" class="section-heading">Your message</h2>

        <label class="field-label" for="chat-input">Message</label>
        <textarea
          id="chat-input"
          v-model="draft"
          class="chat-input"
          rows="4"
          :maxlength="MAX_MESSAGE_CHARACTERS"
          placeholder="Ask anything. Enter sends, Shift+Enter adds a line."
          @keydown="onKeydown"
        ></textarea>

        <div class="composer-actions">
          <v-btn
            class="send-button"
            color="primary"
            :disabled="!canSend"
            variant="flat"
            @click="send"
          >
            Send
          </v-btn>
          <!--
            Cancel is rendered only while streaming rather than disabled, so the control a visitor
            needs mid-answer is the one in that position.
          -->
          <v-btn v-if="streaming" class="cancel-button" variant="outlined" @click="cancel">
            Cancel
          </v-btn>
          <v-btn
            v-if="turns.length > 0 && !streaming"
            class="reset-button"
            variant="text"
            @click="reset"
          >
            New conversation
          </v-btn>
          <span class="counter" aria-live="polite">
            {{ [...draft].length.toLocaleString() }} /
            {{ MAX_MESSAGE_CHARACTERS.toLocaleString() }}
          </span>
        </div>

        <div class="example-group" role="group" aria-labelledby="examples-heading">
          <h3 id="examples-heading" class="field-label">Or try an example</h3>
          <div class="examples">
            <button
              v-for="example in CHAT_EXAMPLES"
              :key="example.id"
              type="button"
              class="example-button"
              :data-example="example.id"
              :title="example.teaches"
              @click="loadExample(example)"
            >
              {{ example.label }}
            </button>
          </div>
        </div>

        <div class="options">
          <div class="option">
            <label class="field-label" for="model-select">Model</label>
            <select id="model-select" v-model="model" class="model-select">
              <option v-for="candidate in models" :key="candidate.id" :value="candidate.id">
                {{ candidate.name }}
              </option>
            </select>
          </div>

          <label class="checkbox">
            <input v-model="showOptions" type="checkbox" />
            <span>Show sampling options</span>
          </label>
        </div>

        <div v-if="showOptions" class="advanced">
          <label class="field-label" for="temperature-input">
            Temperature ({{ temperature ?? 'model default' }})
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
          <p class="hint">
            Higher values produce more varied wording. It does not make an answer more accurate.
          </p>
        </div>
      </section>

      <RunDetails
        v-if="receipt"
        :receipt="receipt"
        :metrics="metrics"
        :cost-pending="costPending"
      />

      <section class="handoff" aria-labelledby="handoff-heading">
        <h2 id="handoff-heading" class="section-heading">See what you are paying for</h2>
        <p>
          A model bills by the token, not by the word.
          <router-link to="/view-tokens">View Tokens</router-link>
          shows how your message is split up, in your browser and at no cost.
          <span v-if="selectedModel?.contextWindowTokens">
            {{ selectedModel.name }} has a
            {{ selectedModel.contextWindowTokens.toLocaleString() }}-token context window.
          </span>
        </p>
        <p v-if="selectedModel">
          <a :href="selectedModel.documentationUrl" rel="noreferrer" target="_blank">
            {{ selectedModel.name }} in the model catalog
          </a>
        </p>
      </section>
    </div>
  </PanelPage>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.section-heading {
  font-size: 1.125rem;
  margin: 0 0 0.75rem;
}

.attribution {
  background-color: rgb(var(--v-theme-surface-variant));
  border-radius: 0.5rem;
  margin: 0;
  max-width: 48rem;
  padding: 0.75rem 1rem;
}

.field-label {
  color: rgb(var(--v-theme-on-surface-variant));
  display: block;
  font-size: 0.8125rem;
  margin-bottom: 0.25rem;
}

.chat-input {
  background-color: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.5rem;
  color: rgb(var(--v-theme-on-surface));
  font-size: 0.9375rem;
  padding: 0.75rem;
  resize: vertical;
  width: 100%;
}

.chat-input:focus-visible {
  border-color: rgb(var(--v-theme-primary));
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 1px;
}

.composer-actions {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 0.75rem;
}

.counter {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
  margin-left: auto;
}

.example-group {
  margin-top: 1.25rem;
}

.examples {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.example-button {
  background-color: rgb(var(--v-theme-surface-variant));
  border: 1px solid rgb(var(--v-theme-outline-variant));
  border-radius: 999px;
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  /* Comfortably above the minimum target size for a pointer or a touch. */
  min-height: 2.25rem;
  padding: 0.375rem 0.875rem;
}

.example-button:hover,
.example-button:focus-visible {
  border-color: rgb(var(--v-theme-primary));
}

.options {
  align-items: flex-end;
  display: flex;
  flex-wrap: wrap;
  gap: 1.25rem;
  margin-top: 1.25rem;
}

.model-select {
  background-color: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.375rem;
  color: rgb(var(--v-theme-on-surface));
  min-height: 2.25rem;
  padding: 0.375rem 0.5rem;
}

.checkbox {
  align-items: center;
  cursor: pointer;
  display: flex;
  gap: 0.5rem;
  min-height: 2.25rem;
}

.advanced {
  margin-top: 1rem;
  max-width: 24rem;
}

.temperature-input {
  width: 100%;
}

.hint {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
  margin: 0.25rem 0 0;
}

.error {
  color: rgb(var(--v-theme-error));
  margin: 0;
}

.handoff {
  border-top: 1px solid rgb(var(--v-theme-outline-variant));
  max-width: 44rem;
  padding-top: 1.25rem;
}

.handoff p {
  margin: 0 0 0.5rem;
}

.handoff p:last-child {
  margin-bottom: 0;
}
</style>
