<script setup lang="ts">
/**
 * Route composition for the phase-nine Read Text panel.
 *
 * The first panel whose models disagree _completely_ rather than partially, and the form carries
 * that difference. Earlier panels showed a control whose range changed with the model; here the
 * controls themselves appear and disappear: Aura has forty named voices and no language, MeloTTS
 * has a language and no voice at all. The settings section therefore states which family the
 * selected model belongs to, so an absent voice selector reads as a fact about the model rather
 * than a gap in the page.
 *
 * It is also the first panel that can quote a cost _before_ the request — the character-priced
 * models bill on text the visitor has already typed — and the first where that estimate is
 * sometimes impossible. MeloTTS bills per minute of audio that does not exist yet, so the panel
 * says so instead of showing a zero.
 */
import { computed, onMounted, ref } from 'vue';
import { MAX_SPEECH_CHARACTERS } from '../../shared/read-text';
import { findTask } from '../../shared/tasks';
import InfoButton from '../components/InfoButton.vue';
import InfoDialog from '../components/InfoDialog.vue';
import AudioPlayer from '../components/media/AudioPlayer.vue';
import ModelSettingsPanel from '../components/ModelSettingsPanel.vue';
import PanelPage from '../components/PanelPage.vue';
import PanelWorkspace from '../components/PanelWorkspace.vue';
import RunDetails from '../components/runs/RunDetails.vue';
import { SPEECH_EXAMPLES, type SpeechExample } from '../features/read-text/examples';
import { useReadText } from '../features/read-text/useReadText';
import { useCatalogueStore } from '../stores/catalogue';
import { useHandoffStore } from '../stores/handoff';

const task = computed(() => findTask('read-text'));
const catalogue = useCatalogueStore();
const handoff = useHandoffStore();

/**
 * Reviewed models for this panel, as the server reported them.
 */
const models = computed(() => catalogue.modelsForTask('read-text'));

const {
  text,
  model,
  voice,
  language,
  format,
  selectedModel,
  speaking,
  error,
  notice,
  speech,
  receipt,
  metrics,
  costPending,
  applied,
  characterCount,
  estimatedCostUsd,
  audioUri,
  canSpeak,
  acceptHandoff,
  speak,
  cancel
} = useReadText({ models });

/**
 * Whether the run-details modal is showing.
 */
const showRunDetails = ref(false);

/**
 * The selected model's declared speech controls, or `undefined` before the catalogue loads.
 */
const controls = computed(() => selectedModel.value?.speechControls);

/**
 * Whether the output column has anything to show.
 *
 * Only once audio exists, unlike the image panels. There is no input preview to place beside the
 * form — the input is the text, which is already in the editor — so splitting the layout earlier
 * would open an empty column.
 *
 * @returns `true` when a run has produced audio.
 */
const hasOutput = computed(() => speech.value !== undefined);

/**
 * Whether the passage is over the panel's limit.
 *
 * @returns `true` when the text is too long to submit.
 */
const overLimit = computed(() => characterCount.value > MAX_SPEECH_CHARACTERS);

/**
 * A sentence explaining how the selected model's voice controls work.
 *
 * The honest version of a missing control. A visitor who selects MeloTTS and finds no voice
 * selector should learn that the model has no voice parameter, rather than wondering whether the
 * page failed to load one.
 *
 * @returns The sentence, or an empty string before a model has been selected.
 */
const voiceExplanation = computed(() => {
  const support = controls.value;
  const name = selectedModel.value?.name;
  if (support === undefined || name === undefined) {
    return '';
  }

  if (support.voices !== undefined) {
    return (
      `${name} publishes ${support.voices.length} named voices and takes no language parameter: `
      + 'the voice determines the accent and the language together.'
    );
  }

  if (support.languageSelectsVoice === true) {
    return (
      `${name} has no voice parameter at all. It chooses a speaker from the language you pick, `
      + 'which is why this model offers a language where the others offer a voice.'
    );
  }

  return `${name} exposes no voice or language control.`;
});

/**
 * A sentence stating what the run is expected to cost, or why that cannot be said.
 *
 * This is the panel's most useful single line. A character-priced model can be quoted exactly
 * before the request, which no earlier synchronous panel could do; a minute-priced one cannot be
 * quoted at all, and saying that plainly is better than implying a run is free.
 *
 * @returns The sentence, or an empty string before a model has been selected.
 */
const costSentence = computed(() => {
  const support = controls.value;
  const name = selectedModel.value?.name;
  if (support === undefined || name === undefined) {
    return '';
  }

  if (support.pricePerThousandCharactersUsd === undefined) {
    return (
      `${name} is billed per minute of generated audio, so the cost cannot be worked out until the `
      + 'audio exists. The run details will show what AI Gateway reported.'
    );
  }

  if (characterCount.value === 0) {
    return (
      `${name} is billed at $${support.pricePerThousandCharactersUsd.toFixed(3)} per 1,000 `
      + 'characters. Type something to see an estimate.'
    );
  }

  const estimate = estimatedCostUsd.value ?? 0;
  // Four decimal places, because a short passage genuinely costs a fraction of a cent and rounding
  // to two would display `$0.00` — a figure that reads as free.
  return (
    `Estimated cost for ${characterCount.value.toLocaleString()} characters: `
    + `$${estimate.toFixed(4)}. This is an estimate from the published rate; the figure in the run `
    + 'details comes from the AI Gateway log.'
  );
});

onMounted(() => {
  void catalogue.load();

  // Collected once, on mount. The store clears it on read, so returning to this panel later does
  // not silently reload a passage the visitor has moved on from. Translate Text in phase 11 is the
  // panel that will offer one; the receiving half is built and tested now.
  const pending = handoff.takeText();
  if (pending !== undefined) {
    acceptHandoff(pending);
  }
});

/**
 * Loads a prepared passage.
 *
 * @param example Example to load.
 * @returns Nothing; the text is set. The run is not started automatically — a prepared passage that
 *   spent credit the moment it was clicked would be a trap.
 */
function loadExample(example: SpeechExample): void {
  text.value = example.text;
}
</script>

<template>
  <PanelPage v-if="task" :task="task">
    <template #description>
      <p class="attribution" role="note">
        This panel calls a real model and spends real inference credit. Your verified email is
        recorded in the AI Gateway log for each request so spending can be attributed. Assume your
        text is logged too: treat this as you would any shared AI service and do not submit anything
        confidential.
      </p>
      <p class="attribution" role="note">
        Every voice here runs on Cloudflare, so this panel needs no prepaid AI Gateway credit. The
        reviewed models disagree about almost everything — what the text field is called, whether
        they offer voices or languages, and whether they bill per character or per minute of audio —
        so the controls below change with the model rather than staying fixed.
      </p>
    </template>

    <div class="read-text">
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>

      <PanelWorkspace :has-output="hasOutput">
        <template #input>
          <section class="composer" aria-labelledby="composer-heading">
            <h2 id="composer-heading" class="section-heading">Text to read aloud</h2>

            <div class="field">
              <label class="field-label" for="speech-text">Text</label>
              <textarea
                id="speech-text"
                v-model="text"
                class="textarea"
                rows="6"
                :aria-describedby="'speech-text-count'"
                placeholder="Type or paste the text you want spoken."
              ></textarea>
              <!--
                A live region so the count is announced as it changes, and `aria-describedby` on the
                textarea so it is also read when the field receives focus. The limit is stated
                rather than only enforced, because discovering a limit by being refused is a worse
                experience than being told.
              -->
              <p
                id="speech-text-count"
                class="hint"
                :class="{ 'hint--error': overLimit }"
                role="status"
              >
                {{ characterCount.toLocaleString() }} of
                {{ MAX_SPEECH_CHARACTERS.toLocaleString() }} characters
                <template v-if="overLimit">— shorten the text to continue.</template>
              </p>
            </div>

            <div class="actions">
              <v-btn
                class="speak-button"
                color="primary"
                :disabled="!canSpeak"
                variant="flat"
                @click="speak"
              >
                Read aloud
              </v-btn>
              <v-btn v-if="speaking" class="cancel-button" variant="outlined" @click="cancel">
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
              <template v-if="speaking"
                >Generating audio. This usually takes a few seconds.</template
              >
              <template v-else-if="speech">Audio ready.</template>
            </p>

            <div class="example-group" role="group" aria-labelledby="examples-heading">
              <h3 id="examples-heading" class="field-label">Or try a prepared passage</h3>
              <div class="examples">
                <button
                  v-for="example in SPEECH_EXAMPLES"
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
          </section>

          <ModelSettingsPanel :model-name="selectedModel?.name" :model-id="selectedModel?.id">
            <div class="field">
              <label class="field-label" for="speech-model">Model</label>
              <select id="speech-model" v-model="model" class="select">
                <option v-for="candidate in models" :key="candidate.id" :value="candidate.id">
                  {{ candidate.name }}
                </option>
              </select>
            </div>

            <p class="settings-note">
              <span v-if="voiceExplanation">{{ voiceExplanation }}</span>
            </p>

            <!--
              Rendered only when the selected model publishes voices. Not disabled, and not shown
              empty: a control the provider would reject has no honest disabled state, and an empty
              selector looks like a loading failure.
            -->
            <div v-if="controls?.voices" class="field">
              <label class="field-label" for="speech-voice">
                Voice ({{ voice ?? `model default: ${controls.defaultVoice}` }})
              </label>
              <select id="speech-voice" v-model="voice" class="select">
                <option :value="undefined">Model default ({{ controls.defaultVoice }})</option>
                <option v-for="name in controls.voices" :key="name" :value="name">
                  {{ name }}
                </option>
              </select>
            </div>

            <div v-if="controls?.languages" class="field">
              <label class="field-label" for="speech-language">
                Language ({{ language ?? `model default: ${controls.defaultLanguage}` }})
              </label>
              <select id="speech-language" v-model="language" class="select">
                <option :value="undefined">Model default ({{ controls.defaultLanguage }})</option>
                <option v-for="code in controls.languages" :key="code" :value="code">
                  {{ code }}
                </option>
              </select>
            </div>

            <div v-if="controls?.formats" class="field">
              <label class="field-label" for="speech-format">
                Output format ({{ format ?? `model default: ${controls.defaultFormat}` }})
              </label>
              <select id="speech-format" v-model="format" class="select">
                <option :value="undefined">Model default ({{ controls.defaultFormat }})</option>
                <option v-for="name in controls.formats" :key="name" :value="name">
                  {{ name }}
                </option>
              </select>
              <p class="hint">
                WAV is uncompressed, so it is roughly ten times larger than the MP3 of the same
                speech for no audible gain in a browser.
              </p>
            </div>

            <!--
              Stated rather than omitted. The phase brief asks for rate and pitch controls "when
              supported", and the reviewed answer is that none of the hosted speech models support
              either. Saying so is the finding; silently offering nothing would leave a reader
              wondering whether the panel simply forgot.
            -->
            <p v-if="controls && !controls.rate && !controls.pitch" class="hint">
              None of the reviewed models expose a speaking rate or pitch control, so this panel
              offers neither. A request carrying one is rejected rather than quietly ignored.
            </p>

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

            <AudioPlayer
              v-if="speech && audioUri && receipt"
              :speech="speech"
              :src="audioUri"
              :text="text.trim()"
              :run-id="receipt.runId"
            />

            <dl v-if="applied" class="applied-facts">
              <div v-if="applied.voice !== undefined" class="fact">
                <dt>Voice</dt>
                <dd>{{ applied.voice }}</dd>
              </div>
              <div v-if="applied.language !== undefined" class="fact">
                <dt>Language</dt>
                <dd>{{ applied.language }}</dd>
              </div>
              <div class="fact">
                <dt>Characters</dt>
                <dd>{{ applied.characterCount.toLocaleString() }}</dd>
              </div>
              <!--
                Shown only when the model's billing allows an estimate. A minute-priced model gets
                no figure here rather than a zero, because a zero would read as free.
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
.read-text {
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

.textarea,
.select {
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

.actions {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.status {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0;
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
  min-height: 2.25rem;
  padding: 0.375rem 0.875rem;
}

.example-button:hover,
.example-button:focus-visible {
  border-color: rgb(var(--v-theme-primary));
}

.example-button:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.settings-note,
.hint {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin: 0;
}

.hint--error {
  color: rgb(var(--v-theme-error));
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
