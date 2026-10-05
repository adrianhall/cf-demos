<script setup lang="ts">
/**
 * Route composition for the phase-fifteen Generate Music panel.
 *
 * This is the panel the session cost meter was built for. Every earlier panel put a figure in that
 * meter; this one puts a figure in it that **is not a token count and cannot be compared to one** —
 * and then does it twice, in two different units, from the same selector. One model charges per
 * second of output audio; the other charges a flat price per track and a separate price for writing
 * lyrics. Run one of each beside a Chat run and the meter shows per-token, per-second, and
 * per-track charges side by side, which is the single clearest demonstration in the application
 * that "what did that cost" is a question with more than one shape.
 *
 * Three things in this view's copy are honesty obligations rather than presentation choices.
 *
 * **The cost is quoted before the request, with its unit named.** Every music model here is
 * third-party and spends prepaid AI Gateway credit, so a visitor who learns the price afterwards
 * learns it too late. The estimate sits next to the button that spends it, carries the sentence
 * explaining how it was reached, and is labelled an estimate everywhere — the authoritative figure
 * still comes from the AI Gateway log.
 *
 * **The controls change with the model because the contracts do.** A length control exists for one
 * model and genuinely cannot exist for the other, which the panel states rather than leaving as a
 * gap. The same is true of lyrics: one model accepts them and will not sing without words, the
 * other has no lyrics field at all.
 *
 * **The original asset is the provider's and may expire.** The model returns a short-lived URL on
 * its own CDN. This demo fetches it once, server-side, from an allowlisted host, verifies the
 * bytes, and hands the audio to the page — so what is on screen will keep working, and the link it
 * came from may not. Nothing is stored, and the panel makes no retention promise it would have to
 * keep.
 */
import { computed, onMounted, ref } from 'vue';
import {
  MAX_MUSIC_LYRICS_CHARACTERS,
  MAX_MUSIC_PROMPT_CHARACTERS
} from '../../shared/generate-music';
import { findTask } from '../../shared/tasks';
import InfoButton from '../components/InfoButton.vue';
import InfoDialog from '../components/InfoDialog.vue';
import TrackPlayer from '../components/media/TrackPlayer.vue';
import ModelSettingsPanel from '../components/ModelSettingsPanel.vue';
import PanelPage from '../components/PanelPage.vue';
import PanelWorkspace from '../components/PanelWorkspace.vue';
import RunDetails from '../components/runs/RunDetails.vue';
import { MUSIC_EXAMPLES, type MusicExample } from '../features/generate-music/examples';
import { useGenerateMusic } from '../features/generate-music/useGenerateMusic';
import { useCatalogueStore } from '../stores/catalogue';

const task = computed(() => findTask('generate-music'));
const catalogue = useCatalogueStore();

/**
 * Reviewed models for this panel, as the server reported them.
 */
const models = computed(() => catalogue.modelsForTask('generate-music'));

const {
  prompt,
  model,
  instrumental,
  lyrics,
  generateLyrics,
  lengthSeconds,
  format,
  seed,
  selectedModel,
  estimatedCostUsd,
  costBasis,
  pricingUnit,
  generating,
  error,
  failureReason,
  track,
  audioUri,
  renderedLyrics,
  receipt,
  metrics,
  costPending,
  applied,
  promptCharacterCount,
  lyricsCharacterCount,
  blockedReason,
  canGenerate,
  generate,
  cancel
} = useGenerateMusic({ models });

/**
 * Whether the run-details modal is showing.
 */
const showRunDetails = ref(false);

/**
 * The selected model's declared music controls, or `undefined` before the catalogue loads.
 */
const controls = computed(() => selectedModel.value?.musicControls);

/**
 * Whether the output column has anything to show.
 *
 * Only once a track exists. There is no input preview to place beside the form — the input is the
 * prompt, which is already in the editor — so splitting the layout earlier would open an empty
 * column that reads as something failing to load.
 *
 * @returns `true` when a run has produced a track.
 */
const hasOutput = computed(() => track.value !== undefined);

/**
 * The lengths the selected model accepts, as a list the UI can render.
 *
 * A short list of round values rather than every integer in the range. The range is 3–120 seconds,
 * and a 118-option selector would be unusable while the difference between 118 and 120 seconds is
 * not a choice anybody is making. The model's own declared minimum and default are both included,
 * so the list cannot offer something validation would refuse or omit the value the server would
 * fill in.
 *
 * @returns The offered lengths in seconds, ascending, or an empty list for a model with no length
 *   control.
 */
const lengthOptions = computed<number[]>(() => {
  const range = controls.value?.lengthSeconds;
  if (range === undefined) {
    return [];
  }

  const candidates = [range.min, 10, 15, 20, 30, 45, 60, 90, 120, range.default];
  const offered = new Set(candidates.filter((value) => value >= range.min && value <= range.max));
  return [...offered].sort((first, second) => first - second);
});

/**
 * The estimate rendered as currency.
 *
 * Four decimal places below a dollar: the cheapest run on the per-second model is three quarters of
 * a cent, and rounding that to `$0.01` would lose the comparison with the fifteen-cent per-track
 * model that is the point of showing both.
 *
 * @returns The formatted estimate, or an empty string before a model is selected.
 */
const estimateLabel = computed(() => {
  const estimate = estimatedCostUsd.value;
  if (estimate === undefined) {
    return '';
  }
  return `$${estimate.toFixed(estimate < 1 ? 4 : 2)}`;
});

/**
 * A short human label for the selected model's billing unit.
 *
 * Spelled out rather than shown as the raw slug, because this is the phrase the panel's whole
 * lesson rests on and `audio-second` is not a phrase anybody says.
 *
 * @returns The label, or an empty string before a model is selected.
 */
const pricingUnitLabel = computed(() => {
  switch (pricingUnit.value) {
    case 'audio-second':
      return 'per second of output audio';
    case 'track':
      return 'per track';
    default:
      return '';
  }
});

/**
 * A sentence explaining how the selected model handles track length.
 *
 * The honest version of a missing control. A visitor who selects the per-track model and finds no
 * length selector should learn that the model has no length parameter — and that the price is the
 * same however long the track turns out to be — rather than wondering whether the page failed to
 * load one.
 *
 * @returns The sentence, or an empty string before a model is selected.
 */
const lengthExplanation = computed(() => {
  const support = controls.value;
  const name = selectedModel.value?.name;
  if (support === undefined || name === undefined) {
    return '';
  }

  if (support.lengthSeconds !== undefined) {
    return (
      `${name} takes a requested length and bills by the second, so the length control below is `
      + 'also the price control.'
    );
  }

  return (
    `${name} has no length parameter at all — it decides how long the track is — and charges the `
    + 'same price whatever it decides. A request that tried to set a length would be rejected, so '
    + 'this panel offers no length control for it.'
  );
});

/**
 * A sentence explaining how the selected model handles lyrics.
 *
 * @returns The sentence, or an empty string before a model is selected.
 */
const lyricsExplanation = computed(() => {
  const support = controls.value;
  const name = selectedModel.value?.name;
  if (support === undefined || name === undefined) {
    return '';
  }

  if (support.lyrics !== 'optional') {
    return (
      `${name} has no lyrics parameter. Describe the vocals you want in the prompt instead; a `
      + 'request carrying lyrics is rejected rather than quietly ignored.'
    );
  }

  return (
    `${name} accepts lyrics you write, or will write its own from the prompt — which is charged `
    + 'for separately. It will not sing without words, so a vocal track needs one or the other.'
  );
});

onMounted(() => {
  void catalogue.load();
});

/**
 * Loads a prepared prompt and its settings.
 *
 * @param example Example to load.
 * @returns Nothing; the form is populated. The run is deliberately not started — a prepared prompt
 *   that spent prepaid credit the moment it was clicked would be a trap, and on the per-track model
 *   that click is fifteen cents.
 */
function loadExample(example: MusicExample): void {
  prompt.value = example.prompt;
  instrumental.value = example.instrumental;
  generateLyrics.value = false;
  lyrics.value = controls.value?.lyrics === 'optional' ? (example.lyrics ?? '') : '';

  const range = controls.value?.lengthSeconds;
  lengthSeconds.value =
    range !== undefined && example.lengthSeconds >= range.min && example.lengthSeconds <= range.max
      ? example.lengthSeconds
      : undefined;
}
</script>

<template>
  <PanelPage v-if="task" :task="task">
    <template #description>
      <p class="attribution" role="note">
        This panel calls a real model and spends real inference credit. Every music model here is
        third-party — the Workers AI catalogue has no music model at all — so it bills against
        prepaid AI Gateway credits. Your verified email is recorded in the AI Gateway log for each
        request so spending can be attributed. Assume your prompt and any lyrics are logged too, and
        do not submit anything confidential.
      </p>
      <p class="attribution" role="note">
        This is the panel where the session cost meter earns its keep. One of these models is billed
        per second of output audio; the other is billed a flat price per track, plus a separate
        charge if you ask it to write the lyrics. Neither is billed per token, and neither figure
        can be compared with a Chat run's. Generate a track, then look at the meter: per-token,
        per-second, and per-track charges sit side by side there, and the demo never turns one into
        another.
      </p>
      <p class="attribution" role="note">
        The models disagree about almost everything else as well. One accepts a track length and the
        other has no length parameter at all; one accepts lyrics and the other has no lyrics field;
        their output format lists have no value in common. The controls below therefore change with
        the model rather than staying fixed, and a control that is missing is a fact about that
        model rather than a gap in this page.
      </p>
      <p class="attribution" role="note">
        Both models answer with a link to a file on their own servers rather than with audio. That
        link is short-lived and belongs to the provider, so this demo fetches it once from an
        approved host, checks that what came back really is audio, and sends you the track itself —
        your browser never talks to the provider. The player above is therefore reliable; the
        provider's original may expire at any time. Nothing is kept here after you leave the page.
      </p>
    </template>

    <div class="generate-music">
      <!--
        The billing failure gets its own treatment rather than sharing the generic error box, exactly
        as in Create Video. It is the only failure in this panel a visitor can resolve, and it needs
        a different verb from every other error: top up an account, not try again. Rendering it as
        one more red box — with the usual implicit "retry" — would be telling someone to repeat an
        action that fails identically every time.
      -->
      <section
        v-if="failureReason === 'insufficient-credit'"
        class="credit-notice"
        role="alert"
        aria-labelledby="music-credit-heading"
      >
        <h2 id="music-credit-heading" class="credit-heading">AI Gateway credit is required</h2>
        <p class="credit-detail">{{ error }}</p>
        <p class="credit-actions">
          <a
            href="https://developers.cloudflare.com/ai-gateway/features/unified-billing/"
            rel="noreferrer"
            target="_blank"
          >
            How prepaid AI Gateway credits work
          </a>
        </p>
      </section>

      <p v-else-if="error" class="error" role="alert">{{ error }}</p>

      <PanelWorkspace :has-output="hasOutput">
        <template #input>
          <section class="composer" aria-labelledby="music-composer-heading">
            <h2 id="music-composer-heading" class="section-heading">Describe the music</h2>

            <div class="field">
              <label class="field-label" for="music-prompt">
                Style, mood, and instrumentation
              </label>
              <textarea
                id="music-prompt"
                v-model="prompt"
                class="textarea"
                rows="4"
                aria-describedby="music-prompt-count"
                placeholder="A warm cinematic ambient piece: soft sustained piano, distant strings, slow and hopeful"
                :disabled="generating"
              ></textarea>
              <!--
                A live region so the count is announced as it changes, and `aria-describedby` on the
                textarea so it is also read when the field receives focus.
              -->
              <p id="music-prompt-count" class="hint" role="status">
                {{ promptCharacterCount.toLocaleString() }} of
                {{ MAX_MUSIC_PROMPT_CHARACTERS.toLocaleString() }} characters. A specific prompt
                produces a far better result than a vague one — the prepared prompts below include a
                deliberately vague one for comparison.
              </p>
            </div>

            <div class="field checkbox-field">
              <input
                id="music-instrumental"
                v-model="instrumental"
                class="checkbox"
                type="checkbox"
                :disabled="generating"
              />
              <label class="field-label" for="music-instrumental">Instrumental (no vocals)</label>
            </div>

            <!--
              Rendered only when the selected model publishes a lyrics field. Not disabled, and not
              shown empty: a control the provider would reject has no honest disabled state.
            -->
            <template v-if="controls?.lyrics === 'optional'">
              <div v-if="controls.lyricsOptimizerParameterName" class="field checkbox-field">
                <input
                  id="music-generate-lyrics"
                  v-model="generateLyrics"
                  class="checkbox"
                  type="checkbox"
                  :disabled="generating || instrumental"
                />
                <label class="field-label" for="music-generate-lyrics">
                  Let the model write the lyrics
                </label>
                <p class="hint">
                  Charged separately from the track, and the model returns only the audio — the
                  words it wrote are in the recording and nowhere else.
                </p>
              </div>

              <div v-if="!instrumental && !generateLyrics" class="field">
                <label class="field-label" for="music-lyrics">Lyrics</label>
                <textarea
                  id="music-lyrics"
                  v-model="lyrics"
                  class="textarea"
                  rows="5"
                  aria-describedby="music-lyrics-count"
                  placeholder="One line per line of the song."
                  :disabled="generating"
                ></textarea>
                <p id="music-lyrics-count" class="hint" role="status">
                  {{ lyricsCharacterCount.toLocaleString() }} of
                  {{ MAX_MUSIC_LYRICS_CHARACTERS.toLocaleString() }} characters. Lines are sung in
                  the order you write them.
                </p>
              </div>
            </template>

            <!--
              The estimate sits next to the button that spends it, not in a disclosure. It is the one
              number a visitor most needs before clicking, and it carries its unit because the figure
              alone is ambiguous on this panel.
            -->
            <p v-if="estimateLabel" class="estimate">
              Estimated cost:
              <strong>{{ estimateLabel }}</strong>
              <span v-if="pricingUnitLabel"> — billed {{ pricingUnitLabel }}.</span>
              <span class="estimate-caveat">
                {{ costBasis }} This is an estimate from the published price. The figure in Run
                details comes from the AI Gateway log and is the authoritative one.
              </span>
            </p>

            <div class="actions">
              <v-btn
                class="generate-button"
                color="primary"
                :disabled="!canGenerate"
                variant="flat"
                @click="generate"
              >
                Generate track
              </v-btn>
              <v-btn v-if="generating" class="cancel-button" variant="outlined" @click="cancel">
                Stop waiting
              </v-btn>
            </div>

            <!--
              Says *why* the button is disabled. This panel has refusals a visitor would not
              otherwise understand — one model will not sing without words — so stating the reason is
              the difference between a form that teaches the contract and one that only enforces it.
            -->
            <p v-if="blockedReason" class="hint blocked">{{ blockedReason }}</p>

            <!--
              Persistent, so the text *changes* between states rather than appearing already
              populated. Screen readers announce a changed live region more reliably than one
              inserted with content.
            -->
            <p class="status" role="status">
              <template v-if="generating">
                Composing. Music takes noticeably longer than a text answer — usually tens of
                seconds. Stopping the wait does not stop the model: the track is already being
                generated and will still be charged for.
              </template>
              <template v-else-if="track">Track ready.</template>
            </p>

            <div class="example-group" role="group" aria-labelledby="music-examples-heading">
              <h3 id="music-examples-heading" class="field-label">Or try a prepared prompt</h3>
              <div class="examples">
                <button
                  v-for="example in MUSIC_EXAMPLES"
                  :key="example.id"
                  type="button"
                  class="example-button"
                  :data-example="example.id"
                  :title="example.teaches"
                  :disabled="generating"
                  @click="loadExample(example)"
                >
                  {{ example.label }}
                </button>
              </div>
              <p class="hint">
                Loading a prompt never starts a run, and each one picks a short length — every click
                here spends prepaid credit.
              </p>
            </div>
          </section>

          <ModelSettingsPanel :model-name="selectedModel?.name" :model-id="selectedModel?.id">
            <div class="field">
              <label class="field-label" for="music-model">Model</label>
              <select id="music-model" v-model="model" class="select" :disabled="generating">
                <option v-for="candidate in models" :key="candidate.id" :value="candidate.id">
                  {{ candidate.name }}
                </option>
              </select>
            </div>

            <p v-if="lengthExplanation" class="settings-note">{{ lengthExplanation }}</p>

            <div v-if="controls?.lengthSeconds" class="field">
              <label class="field-label" for="music-length">Track length</label>
              <select
                id="music-length"
                v-model.number="lengthSeconds"
                class="select"
                :disabled="generating"
              >
                <option :value="undefined">
                  Model default ({{ controls.lengthSeconds.default }} seconds)
                </option>
                <option v-for="option in lengthOptions" :key="option" :value="option">
                  {{ option }} seconds
                </option>
              </select>
              <p class="hint">
                Length is the whole price calculation for this model, which is why the estimate
                above moves when you change it.
              </p>
            </div>

            <p v-if="lyricsExplanation" class="settings-note">{{ lyricsExplanation }}</p>

            <div v-if="controls" class="field">
              <label class="field-label" for="music-format">Output format</label>
              <select id="music-format" v-model="format" class="select" :disabled="generating">
                <option :value="undefined">Model default ({{ controls.defaultFormat }})</option>
                <option v-for="option in controls.formats" :key="option" :value="option">
                  {{ option }}
                </option>
              </select>
              <p class="hint">
                These names are the model's own, and the two models here share none of them. Format
                does not change the price for either.
              </p>
            </div>

            <div v-if="controls?.seed" class="field">
              <label class="field-label" for="music-seed">Seed (optional)</label>
              <input
                id="music-seed"
                v-model.number="seed"
                class="select"
                type="number"
                min="0"
                max="4294967295"
                step="1"
                :disabled="generating"
              />
              <p class="hint">
                The same prompt and seed should produce the same track, which is the only way to
                compare two settings without a second variable.
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
          <section class="result" aria-labelledby="music-result-heading">
            <div class="result-header">
              <h2 id="music-result-heading" class="section-heading">Run output</h2>
              <InfoButton
                v-if="receipt"
                class="run-details-button"
                label="Run details, including reported cost"
                @activate="showRunDetails = true"
              />
            </div>

            <TrackPlayer
              v-if="track && audioUri && receipt && applied"
              :track="track"
              :src="audioUri"
              :prompt="applied.prompt"
              :run-id="receipt.runId"
              :lyrics-source="applied.lyricsSource"
              :lyrics="renderedLyrics"
            />

            <dl v-if="applied" class="applied-facts">
              <div v-if="applied.lengthSeconds !== undefined" class="fact">
                <dt>Requested length</dt>
                <dd>{{ applied.lengthSeconds }} seconds</dd>
              </div>
              <div class="fact">
                <dt>Vocals</dt>
                <dd>{{ applied.instrumental ? 'Instrumental' : 'With vocals' }}</dd>
              </div>
              <div class="fact">
                <dt>Format asked for</dt>
                <dd>{{ applied.format }}</dd>
              </div>
              <!--
                The unit is shown beside the estimate rather than only in the run-details modal,
                because the two figures in this panel are in different units and a visitor comparing
                them needs both labels in the same place.
              -->
              <div class="fact">
                <dt>Billed</dt>
                <dd>
                  {{ applied.pricingUnit === 'track' ? 'Per track' : 'Per second of audio' }}
                </dd>
              </div>
              <div class="fact">
                <dt>Estimated</dt>
                <dd>
                  ${{ applied.estimatedCostUsd.toFixed(applied.estimatedCostUsd < 1 ? 4 : 2) }}
                </dd>
              </div>
            </dl>

            <p v-if="applied" class="cost-basis">{{ applied.costBasis }}</p>

            <p v-if="track" class="expiry-note">
              The model produced this track as a link on
              <code>{{ track.sourceHost }}</code>
              — the provider's own servers. That link is short-lived, so the audio above was fetched
              and checked server-side and is being played from this site instead. It is held in this
              page only: reload and it is gone, and the provider's copy may already have expired.
            </p>
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
.generate-music {
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
  margin: 0 0 0.5rem;
}

.result-header {
  align-items: center;
  display: flex;
  gap: 0.5rem;
  justify-content: space-between;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}

.field-label {
  font-size: 0.8125rem;
  font-weight: 600;
}

.textarea,
.select {
  background-color: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.375rem;
  box-sizing: border-box;
  color: rgb(var(--v-theme-on-surface));
  font: inherit;
  min-height: 2.25rem;
  padding: 0.375rem 0.5rem;
  width: 100%;
}

.textarea {
  resize: vertical;
}

.checkbox-field {
  display: grid;
  gap: 0.25rem 0.5rem;
  grid-template-columns: auto 1fr;
}

.checkbox {
  align-self: center;
}

.checkbox-field .hint {
  grid-column: 1 / -1;
}

.hint,
.settings-note,
.estimate-caveat,
.cost-basis,
.expiry-note {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
  margin: 0;
}

.blocked {
  color: rgb(var(--v-theme-error));
}

.estimate {
  background-color: rgba(var(--v-theme-primary), 0.06);
  border-left: 3px solid rgb(var(--v-theme-primary));
  border-radius: 0.25rem;
  font-size: 0.875rem;
  margin: 0;
  padding: 0.625rem 0.75rem;
}

.estimate-caveat {
  display: block;
  margin-top: 0.25rem;
}

.actions {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.status {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin: 0;
  min-height: 1.25rem;
}

.credit-notice {
  background-color: rgba(var(--v-theme-warning), 0.1);
  border-left: 3px solid rgb(var(--v-theme-warning));
  border-radius: 0.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.75rem 0.875rem;
}

.credit-heading {
  font-size: 1rem;
  margin: 0;
}

.credit-detail,
.credit-actions {
  font-size: 0.875rem;
  margin: 0;
}

.error {
  background-color: rgba(var(--v-theme-error), 0.08);
  border-left: 3px solid rgb(var(--v-theme-error));
  border-radius: 0.25rem;
  margin: 0;
  padding: 0.625rem 0.75rem;
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

.example-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.example-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.applied-facts {
  display: grid;
  gap: 0.5rem 1rem;
  grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
  margin: 0;
}

.fact dt {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
  text-transform: uppercase;
}

.fact dd {
  font-size: 0.875rem;
  margin: 0;
}

.expiry-note code {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  overflow-wrap: anywhere;
}

.docs-link {
  font-size: 0.8125rem;
  margin: 0.5rem 0 0;
}
</style>
