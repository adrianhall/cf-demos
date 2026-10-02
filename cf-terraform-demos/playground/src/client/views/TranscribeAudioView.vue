<script setup lang="ts">
/**
 * Route composition for the phase-ten Transcribe Audio panel.
 *
 * The inverse of Read Text in every direction: the request carries megabytes and the answer is
 * text, and where that panel's models disagreed about controls, these disagree about the _payload_
 * — the same bytes in three different encodings, the transcript in three different envelopes, and
 * two incompatible meanings for the word "confidence".
 *
 * The consequence a visitor actually notices is that **the file size limit changes with the
 * model**. No earlier panel had that, and it is the reason the picker takes its ceiling from the
 * catalogue rather than from a constant. The settings section states the limit and, when a model's
 * limit is lower than the others, says why — otherwise a file that worked a moment ago being
 * refused reads as a bug rather than as a contract.
 */
import { computed, onMounted, ref } from 'vue';
import { findTask } from '../../shared/tasks';
import {
  MAX_CONTEXT_PROMPT_CHARACTERS,
  MAX_INPUT_AUDIO_BYTES
} from '../../shared/transcribe-audio';
import InfoButton from '../components/InfoButton.vue';
import InfoDialog from '../components/InfoDialog.vue';
import { formatAudioBytes } from '../components/media/audio-input';
import SourceAudioPicker from '../components/media/SourceAudioPicker.vue';
import ModelSettingsPanel from '../components/ModelSettingsPanel.vue';
import PanelPage from '../components/PanelPage.vue';
import PanelWorkspace from '../components/PanelWorkspace.vue';
import TranscriptView from '../components/results/TranscriptView.vue';
import RunDetails from '../components/runs/RunDetails.vue';
import { useTranscribeAudio } from '../features/transcribe-audio/useTranscribeAudio';
import { useCatalogueStore } from '../stores/catalogue';

const task = computed(() => findTask('transcribe-audio'));
const catalogue = useCatalogueStore();

/**
 * Reviewed models for this panel, as the server reported them.
 */
const models = computed(() => catalogue.modelsForTask('transcribe-audio'));

const {
  audio,
  model,
  language,
  detectLanguage,
  diarize,
  punctuate,
  contextPrompt,
  selectedModel,
  maxAudioBytes,
  transcribing,
  error,
  notice,
  recordingState,
  recordingSeconds,
  transcript,
  verifiedAudio,
  receipt,
  metrics,
  costPending,
  applied,
  canTranscribe,
  selectFile,
  clearAudio,
  startRecording,
  stopRecording,
  run,
  cancel
} = useTranscribeAudio({ models });

/**
 * Whether the run-details modal is showing.
 */
const showRunDetails = ref(false);

/**
 * The selected model's declared transcription controls, or `undefined` before the catalogue loads.
 */
const controls = computed(() => selectedModel.value?.transcriptionControls);

/**
 * Whether the output column has anything to show.
 *
 * As soon as audio is chosen, not only once a transcript exists. The preview player is itself worth
 * placing beside the form, and splitting the layout at that point means the result appears where
 * the visitor is already looking.
 *
 * @returns `true` when there is audio or a transcript.
 */
const hasOutput = computed(() => audio.value !== undefined || transcript.value !== undefined);

/**
 * A sentence explaining this model's file size limit.
 *
 * The limit is a property of the model's contract rather than of the panel, and the reason is
 * concrete enough to state: one reviewed model's schema demands the audio as a JSON array of byte
 * values, which costs far more memory than the file itself.
 *
 * @returns The sentence, or an empty string before a model has been selected.
 */
const limitSentence = computed(() => {
  const support = controls.value;
  const name = selectedModel.value?.name;
  if (support === undefined || name === undefined) {
    return '';
  }

  const base = `${name} accepts files up to ${formatAudioBytes(support.maxAudioBytes)}.`;

  return support.maxAudioBytes < MAX_INPUT_AUDIO_BYTES
    ? `${base} That is lower than the other models here because its contract requires the audio `
        + 'as a JSON array of byte values, which costs far more memory than the file itself.'
    : base;
});

/**
 * A sentence stating what this model charges and why the cost cannot be quoted in advance.
 *
 * Every reviewed model bills per audio minute, and a compressed file's duration is not readable in
 * the browser — so unlike Read Text, this panel usually cannot estimate before the run. Saying so
 * is better than leaving a visitor to wonder why the figure is missing.
 *
 * @returns The sentence, or an empty string before a model has been selected.
 */
const costSentence = computed(() => {
  const support = controls.value;
  const name = selectedModel.value?.name;
  if (support === undefined || name === undefined) {
    return '';
  }

  return (
    `${name} is billed at $${support.pricePerAudioMinuteUsd.toFixed(4)} per audio minute. The `
    + 'exact cost depends on the length of the recording, which this panel can only measure for '
    + 'WAV files before sending \u2014 the run details show what AI Gateway reported.'
  );
});

/**
 * A sentence describing which quality figures this model returns.
 *
 * The most important disclosure on the panel. "Confidence" means a probability for one model and an
 * average log probability for another, and the two are not comparable; a visitor switching models
 * should learn that from the settings rather than inferring it from a column that silently changes
 * meaning.
 *
 * @returns The sentence, or an empty string before a model has been selected.
 */
const confidenceSentence = computed(() => {
  const support = controls.value;
  if (support === undefined) {
    return '';
  }

  switch (support.confidenceScale) {
    case 'probability': {
      return 'Returns a confidence score between 0 and 1 for each word.';
    }
    case 'log-probability': {
      return (
        'Returns an average log probability per phrase rather than a confidence. It is negative '
        + 'and has no lower bound, so it cannot be read as a percentage.'
      );
    }
    default: {
      return 'Returns no confidence or quality figures.';
    }
  }
});

/**
 * How many characters the context prompt currently holds.
 *
 * @returns The count, in code points, matching the server's own limit.
 */
const contextPromptCharacters = computed(() => [...contextPrompt.value.trim()].length);

onMounted(() => {
  void catalogue.load();
});
</script>

<template>
  <PanelPage v-if="task" :task="task">
    <template #description>
      <p class="attribution" role="note">
        This panel calls a real model and spends real inference credit. Your verified email is
        recorded in the AI Gateway log for each request so spending can be attributed. Assume your
        recording and its transcript are logged too: treat this as you would any shared AI service
        and do not submit anything confidential.
      </p>
      <p class="attribution" role="note">
        Recording from your microphone is optional. The panel works entirely by file upload, and
        nothing here depends on granting microphone permission.
      </p>
      <p class="attribution" role="note">
        Every model here runs on Cloudflare, so this panel needs no prepaid AI Gateway credit. The
        three disagree more than any other set in this demo: they want the same bytes in three
        different encodings, return the transcript in three different shapes, and two of them mean
        different things by a confidence score. The controls and the file size limit below change
        with the model for exactly that reason.
      </p>
    </template>

    <div class="transcribe-audio">
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>

      <PanelWorkspace :has-output="hasOutput">
        <template #input>
          <section class="composer" aria-labelledby="composer-heading">
            <h2 id="composer-heading" class="section-heading">Recording</h2>

            <SourceAudioPicker
              :audio="audio"
              :busy="transcribing"
              :recording-state="recordingState"
              :recording-seconds="recordingSeconds"
              :max-bytes="maxAudioBytes"
              @selected="selectFile"
              @cleared="clearAudio"
              @record="startRecording"
              @stop="stopRecording"
            />

            <div class="actions">
              <v-btn
                class="transcribe-button"
                color="primary"
                :disabled="!canTranscribe"
                variant="flat"
                @click="run"
              >
                Transcribe
              </v-btn>
              <v-btn v-if="transcribing" class="cancel-button" variant="outlined" @click="cancel">
                Stop waiting
              </v-btn>
            </div>

            <p v-if="costSentence" class="cost-estimate">{{ costSentence }}</p>

            <!--
              Persistent so the text *changes* from the start phrase to the completion phrase.
              Screen readers announce that more reliably than a live region inserted already
              populated after the result arrives.
            -->
            <p class="status" role="status">
              <template v-if="transcribing">
                Transcribing. A few minutes of audio usually takes several seconds.
              </template>
              <template v-else-if="transcript">Transcript ready.</template>
            </p>
          </section>

          <ModelSettingsPanel :model-name="selectedModel?.name">
            <div class="field">
              <label class="field-label" for="transcribe-model">Model</label>
              <select id="transcribe-model" v-model="model" class="select">
                <option v-for="candidate in models" :key="candidate.id" :value="candidate.id">
                  {{ candidate.name }}
                </option>
              </select>
            </div>

            <p v-if="limitSentence" class="settings-note">{{ limitSentence }}</p>
            <p v-if="confidenceSentence" class="settings-note">{{ confidenceSentence }}</p>

            <!--
              Rendered only when the selected model publishes a language list. The two that do use
              different standards — ISO 639-1 against BCP-47 — so the options are the model's own
              rather than a merged list this demo invented.
            -->
            <div v-if="controls?.languages" class="field">
              <label class="field-label" for="transcribe-language"
                >Spoken language (optional)</label
              >
              <select
                id="transcribe-language"
                v-model="language"
                class="select"
                :disabled="detectLanguage"
              >
                <option :value="undefined">Let the model decide</option>
                <option v-for="code in controls.languages" :key="code" :value="code">
                  {{ code }}
                </option>
              </select>
              <p class="hint">
                These are this model's own codes. The models here do not use the same style, so a
                code valid for one may be rejected by another.
              </p>
            </div>

            <div v-if="controls?.supportsLanguageDetection" class="field">
              <label class="checkbox">
                <input v-model="detectLanguage" type="checkbox" />
                Detect the spoken language
              </label>
              <!--
                Disabling the hint rather than letting both be set. The server refuses the
                combination, and discovering that by being refused is worse than the control
                making the conflict visible.
              -->
              <p class="hint">
                Detection ignores the language hint, so the hint is disabled while this is on.
              </p>
            </div>

            <div v-if="controls?.supportsDiarization" class="field">
              <label class="checkbox">
                <input v-model="diarize" type="checkbox" />
                Label who is speaking
              </label>
            </div>

            <div v-if="controls?.supportsPunctuation" class="field">
              <label class="checkbox">
                <input v-model="punctuate" type="checkbox" />
                Add punctuation and capitalisation
              </label>
            </div>

            <div v-if="controls?.supportsContextPrompt" class="field">
              <label class="field-label" for="transcribe-context">
                Context vocabulary (optional)
              </label>
              <textarea
                id="transcribe-context"
                v-model="contextPrompt"
                class="textarea"
                rows="2"
                aria-describedby="transcribe-context-hint"
                placeholder="Names, jargon, or spellings the model should expect."
              ></textarea>
              <p id="transcribe-context-hint" class="hint">
                {{ contextPromptCharacters }} of
                {{ MAX_CONTEXT_PROMPT_CHARACTERS.toLocaleString() }} characters. Use it for
                vocabulary rather than instructions — a long prompt biases the transcript towards
                its own wording.
              </p>
            </div>

            <p v-if="selectedModel" class="docs-link">
              <a :href="selectedModel.documentationUrl" rel="noreferrer" target="_blank">
                {{ selectedModel.name }} in the model catalog
              </a>
            </p>
          </ModelSettingsPanel>
        </template>

        <template #output>
          <section class="result" aria-labelledby="result-heading">
            <div class="result-header">
              <h2 id="result-heading" class="section-heading">Run output</h2>
              <InfoButton
                v-if="receipt"
                class="run-details-button"
                label="Run details, including reported cost"
                @activate="showRunDetails = true"
              />
            </div>

            <TranscriptView
              v-if="transcript && verifiedAudio && receipt"
              :transcript="transcript"
              :audio="verifiedAudio"
              :run-id="receipt.runId"
            />

            <p v-else class="placeholder">
              The transcript will appear here. Choose or record some audio, then select
              <strong>Transcribe</strong>.
            </p>

            <dl v-if="applied" class="applied-facts">
              <div v-if="applied.language !== undefined" class="fact">
                <dt>Language hint</dt>
                <dd>{{ applied.language }}</dd>
              </div>
              <div v-if="applied.diarize" class="fact">
                <dt>Speakers</dt>
                <dd>Labelled</dd>
              </div>
              <div v-if="applied.contextPromptUsed" class="fact">
                <dt>Context</dt>
                <dd>Vocabulary supplied</dd>
              </div>
              <!--
                Shown only when the duration was knowable. A model billed per minute cannot be
                estimated from a compressed file, and a zero would read as free.
              -->
              <div v-if="applied.estimatedCostUsd !== undefined" class="fact">
                <dt>Estimated</dt>
                <dd>${{ applied.estimatedCostUsd.toFixed(4) }}</dd>
              </div>
            </dl>
          </section>
        </template>
      </PanelWorkspace>

      <InfoDialog :open="showRunDetails" title="Run details" @close="showRunDetails = false">
        <RunDetails
          v-if="receipt"
          embedded
          :receipt="receipt"
          :metrics="metrics"
          :cost-pending="costPending"
        />
      </InfoDialog>
    </div>
  </PanelPage>
</template>

<style scoped>
.transcribe-audio {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  min-width: 0;
}

.composer,
.result {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

.section-heading {
  font-size: 1.125rem;
  margin: 0;
}

.attribution {
  margin: 1rem 0 0;
}

.result-header {
  align-items: center;
  display: flex;
  gap: 0.5rem;
}

.field {
  margin-bottom: 1rem;
  max-width: 28rem;
  min-width: 0;
}

.field-label {
  color: rgb(var(--v-theme-on-surface-variant));
  display: block;
  font-size: 0.8125rem;
  margin-bottom: 0.25rem;
}

.select,
.textarea {
  background-color: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.375rem;
  box-sizing: border-box;
  color: rgb(var(--v-theme-on-surface));
  min-height: 2.25rem;
  padding: 0.375rem 0.5rem;
  width: 100%;
}

.textarea {
  font: inherit;
  resize: vertical;
}

.select:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.checkbox {
  align-items: center;
  cursor: pointer;
  display: flex;
  gap: 0.5rem;
  min-height: 2.25rem;
}

.actions {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.status,
.placeholder {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0;
}

.settings-note,
.hint {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin: 0 0 0.5rem;
}

.cost-estimate {
  background-color: rgb(var(--v-theme-surface-variant));
  border-radius: 0.5rem;
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin: 0;
  padding: 0.75rem;
}

.notice {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0;
}

.applied-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 1.5rem;
  margin: 0;
}

.fact dt {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
}

.fact dd {
  margin: 0;
}

.error {
  color: rgb(var(--v-theme-error));
  margin: 0;
}

.docs-link {
  margin: 0.5rem 0 0;
}
</style>
