<script setup lang="ts">
/**
 * Route composition for the phase-eleven Translate Text panel.
 *
 * The first panel whose models disagree about **how many times a single click is billed**. One
 * reviewed model accepts an array of lines and translates a passage in one request; the other takes
 * a single string, so the same passage is one request per line. That is stated before the run
 * rather than discovered afterwards, and it is the reason the panel's limit is on lines rather than
 * on length.
 *
 * It is also the first panel where a control genuinely cannot exist for one model. IndicTrans2
 * translates from English only and declares no source-language field, so the source selector and
 * the swap action are absent for it and the panel says why — a swap button that silently did
 * nothing would be worse than no swap button.
 *
 * This panel completes the Read Text handoff contract that phase 9 built in advance: the offering
 * half is one call into the shared store, with the target language travelling alongside the text so
 * the receiving panel can pick a matching voice.
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { findTask } from '../../shared/tasks';
import { MAX_TRANSLATION_CHARACTERS, MAX_TRANSLATION_SEGMENTS } from '../../shared/translate-text';
import InfoButton from '../components/InfoButton.vue';
import InfoDialog from '../components/InfoDialog.vue';
import ModelSettingsPanel from '../components/ModelSettingsPanel.vue';
import PanelPage from '../components/PanelPage.vue';
import PanelWorkspace from '../components/PanelWorkspace.vue';
import TranslationView from '../components/results/TranslationView.vue';
import RunDetails from '../components/runs/RunDetails.vue';
import { TRANSLATION_EXAMPLES, type TranslationExample } from '../features/translate-text/examples';
import { useTranslateText } from '../features/translate-text/useTranslateText';
import { useCatalogueStore } from '../stores/catalogue';
import { useHandoffStore } from '../stores/handoff';

const task = computed(() => findTask('translate-text'));
const catalogue = useCatalogueStore();
const handoff = useHandoffStore();
const router = useRouter();

/**
 * Reviewed models for this panel, as the server reported them.
 */
const models = computed(() => catalogue.modelsForTask('translate-text'));

const {
  text,
  model,
  sourceLanguage,
  targetLanguage,
  selectedModel,
  sourceLanguages,
  targetLanguages,
  fixedSourceLanguage,
  canSwap,
  translatableLineCount,
  predictedCallCount,
  translating,
  error,
  translation,
  receipt,
  metrics,
  costPending,
  applied,
  canTranslate,
  blockedReason,
  swap,
  run,
  cancel
} = useTranslateText({ models });

/**
 * Whether the run-details modal is showing.
 */
const showRunDetails = ref(false);

/**
 * The selected model's declared translation controls, or `undefined` before the catalogue loads.
 */
const controls = computed(() => selectedModel.value?.translationControls);

/**
 * Whether the output column has anything to show.
 *
 * @returns `true` once a translation exists.
 */
const hasOutput = computed(() => translation.value !== undefined);

/**
 * How many characters the source text currently holds.
 *
 * @returns The count, in code points, matching the server's own limit.
 */
const characterCount = computed(() => [...text.value].length);

/**
 * Display name for a language code the selected model declares.
 *
 * @param code Language code to name.
 * @returns The model's own display name for it, or the code itself when it is not declared — which
 *   can only happen for a fixed source, whose name comes from a different field.
 */
function languageName(code: string | undefined): string {
  if (code === undefined) {
    return 'Unknown';
  }
  if (fixedSourceLanguage.value?.code === code) {
    return fixedSourceLanguage.value.name;
  }

  const match =
    sourceLanguages.value.find((language) => language.code === code)
    ?? targetLanguages.value.find((language) => language.code === code);
  return match?.name ?? code;
}

/**
 * The source language in force, including a fixed-source model's own.
 *
 * @returns The code the translation was or will be made from.
 */
const effectiveSourceLanguage = computed(
  () =>
    sourceLanguage.value ?? controls.value?.defaultSourceLanguage ?? fixedSourceLanguage.value?.code
);

/**
 * A sentence stating how many paid requests the current text will make, and why.
 *
 * The panel's central disclosure. Both reviewed models bill per token, which cannot be known before
 * the model tokenises the text — so no currency figure would be honest here. The number of billed
 * requests is known exactly, and it is the figure that surprises people: the same passage is one
 * charge on one model and a dozen on another.
 *
 * @returns The sentence, or an empty string when there is nothing to translate yet.
 */
const callCountSentence = computed(() => {
  const support = controls.value;
  const name = selectedModel.value?.name;
  if (support === undefined || name === undefined || predictedCallCount.value === 0) {
    return '';
  }

  const calls = predictedCallCount.value;
  const lines = translatableLineCount.value;

  if (support.batchesSegments) {
    return (
      `${name} accepts every line in one request, so this will be a single billed call for `
      + `${lines} ${lines === 1 ? 'line' : 'lines'}.`
    );
  }

  return (
    `${name} translates one line per request, so this will be ${calls} billed `
    + `${calls === 1 ? 'call' : 'calls'}. A model that accepts a whole passage at once would make `
    + 'one.'
  );
});

/**
 * A sentence explaining the source-language situation for the selected model.
 *
 * Stated because an absent selector otherwise reads as a gap in the page rather than as a fact
 * about the model.
 *
 * @returns The sentence, or an empty string for a model with a normal source selector.
 */
const fixedSourceSentence = computed(() => {
  const fixed = fixedSourceLanguage.value;
  const name = selectedModel.value?.name;
  if (fixed === undefined || name === undefined) {
    return '';
  }

  return (
    `${name} translates from ${fixed.name} only. Its contract has no source-language field at all, `
    + 'so there is nothing to choose and nothing to swap.'
  );
});

/**
 * Loads a prepared passage.
 *
 * @param example Example to load.
 * @returns Nothing; the text is set. The run is not started automatically — a prepared passage that
 *   spent credit the moment it was clicked would be a trap, and this panel's per-line billing makes
 *   that sharper than elsewhere.
 */
function loadExample(example: TranslationExample): void {
  text.value = example.text;
}

/**
 * Sends the translation to Read Text.
 *
 * The phase-9 handoff contract's first real producer. The target language travels with the text so
 * the receiving panel can preselect a matching voice when its model has a language control — a
 * French translation read aloud by an English voice would be a worse result than no handoff.
 *
 * The store truncates to what Read Text accepts and reports whether it did, so the receiving panel
 * can say some of the translation was left behind rather than appearing to have mis-read it.
 *
 * @returns A promise fulfilled after navigation begins.
 */
async function readTranslationAloud(): Promise<void> {
  const produced = translation.value;
  if (produced === undefined) {
    return;
  }

  handoff.offerText({
    text: produced.text,
    origin: `Translated into ${languageName(targetLanguage.value)}`,
    // The code as the *translating* model spells it. Read Text re-checks it against its own
    // selected model's published list rather than trusting it, which matters here because the two
    // panels' models use different standards — `hin_Deva` means nothing to a speech model.
    language: targetLanguage.value
  });
  await router.push('/read-text');
}

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
        text and its translation are logged too: treat this as you would any shared AI service and
        do not submit anything confidential.
      </p>
      <p class="attribution" role="note">
        Both models here run on Cloudflare, so this panel needs no prepaid AI Gateway credit. They
        differ in a way no earlier panel did: one accepts a whole passage in a single request, and
        the other translates one line per request. The same text can therefore be one billed call or
        a dozen, which is why the limit below is on lines rather than on length.
      </p>
      <p class="attribution" role="note">
        Line breaks are preserved by translating each line separately and reassembling them. Blank
        lines are kept in place and are never sent to a model, so they cost nothing.
      </p>
    </template>

    <div class="translate-text">
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <PanelWorkspace :has-output="hasOutput">
        <template #input>
          <section class="composer" aria-labelledby="composer-heading">
            <h2 id="composer-heading" class="section-heading">Text</h2>

            <div class="field">
              <label class="field-label" for="translate-source-text">Text to translate</label>
              <textarea
                id="translate-source-text"
                v-model="text"
                class="textarea"
                rows="8"
                aria-describedby="translate-source-hint"
                :lang="effectiveSourceLanguage"
                placeholder="Type or paste the text to translate. Line breaks are preserved."
              ></textarea>
              <p id="translate-source-hint" class="hint">
                {{ characterCount.toLocaleString() }} of
                {{ MAX_TRANSLATION_CHARACTERS.toLocaleString() }} characters,
                {{ translatableLineCount }} of {{ MAX_TRANSLATION_SEGMENTS }} lines.
              </p>
            </div>

            <!--
              The language pair, kept together as a group so the relationship between the two
              selectors is announced rather than left to their visual adjacency.
            -->
            <div class="pair" role="group" aria-label="Languages">
              <div class="field pair-field">
                <label
                  v-if="sourceLanguages.length > 0"
                  class="field-label"
                  for="translate-source-language"
                  >From</label
                >
                <select
                  v-if="sourceLanguages.length > 0"
                  id="translate-source-language"
                  v-model="sourceLanguage"
                  class="select"
                >
                  <option
                    v-for="language in sourceLanguages"
                    :key="language.code"
                    :value="language.code"
                  >
                    {{ language.name }}
                  </option>
                </select>

                <!--
                  A fixed source is stated as text rather than as a disabled selector. A disabled
                  control implies a choice that is temporarily unavailable, when the truth is that
                  this model has no such field.
                -->
                <template v-else-if="fixedSourceLanguage">
                  <span class="field-label">From</span>
                  <p class="fixed-language">{{ fixedSourceLanguage.name }}</p>
                </template>
              </div>

              <!--
                Rendered only when both directions are legal. For the fixed-source model there is
                nothing to exchange, and an inert button would be a worse answer than its absence —
                the sentence below the selector explains why it is not there.
              -->
              <button
                v-if="canSwap"
                type="button"
                class="swap"
                :disabled="translating"
                @click="swap"
              >
                <span aria-hidden="true">⇄</span>
                <span class="visually-hidden">
                  Swap the source and target languages, and move the translation into the text box
                </span>
              </button>

              <div class="field pair-field">
                <label class="field-label" for="translate-target-language">Into</label>
                <select id="translate-target-language" v-model="targetLanguage" class="select">
                  <option
                    v-for="language in targetLanguages"
                    :key="language.code"
                    :value="language.code"
                  >
                    {{ language.name }}
                  </option>
                </select>
              </div>
            </div>

            <p v-if="fixedSourceSentence" class="settings-note">{{ fixedSourceSentence }}</p>

            <div class="examples">
              <span class="field-label">Prepared passages</span>
              <div class="example-buttons">
                <button
                  v-for="example in TRANSLATION_EXAMPLES"
                  :key="example.label"
                  type="button"
                  class="example"
                  :title="example.note"
                  @click="loadExample(example)"
                >
                  {{ example.label }}
                  <span class="visually-hidden">. {{ example.note }}</span>
                </button>
              </div>
            </div>

            <div class="actions">
              <v-btn
                class="translate-button"
                color="primary"
                :disabled="!canTranslate"
                variant="flat"
                @click="run"
              >
                Translate
              </v-btn>
              <v-btn v-if="translating" class="cancel-button" variant="outlined" @click="cancel">
                Stop waiting
              </v-btn>
            </div>

            <!--
              Said rather than left to a disabled button: two of the three reasons a run is blocked
              — too many lines, and identical languages — are not obvious from the form.
            -->
            <p v-if="blockedReason" class="blocked" role="status">{{ blockedReason }}</p>

            <p v-if="callCountSentence" class="cost-estimate">{{ callCountSentence }}</p>

            <!--
              Persistent so the text *changes* from the start phrase to the completion phrase.
              Screen readers announce that more reliably than a live region inserted already
              populated after the result arrives.
            -->
            <p class="status" role="status">
              <template v-if="translating">
                Translating{{
                  predictedCallCount > 1 ? ` ${predictedCallCount} lines, one request each` : ''
                }}. Stopping will not cancel requests already sent.
              </template>
              <template v-else-if="translation">Translation ready.</template>
            </p>
          </section>

          <ModelSettingsPanel :model-name="selectedModel?.name" :model-id="selectedModel?.id">
            <div class="field">
              <label class="field-label" for="translate-model">Model</label>
              <select id="translate-model" v-model="model" class="select">
                <option v-for="candidate in models" :key="candidate.id" :value="candidate.id">
                  {{ candidate.name }}
                </option>
              </select>
            </div>

            <p v-if="controls" class="settings-note">
              {{
                controls.batchesSegments
                  ? 'Accepts a whole passage in one request, so a multi-line translation is a '
                    + 'single billed call.'
                  : 'Takes one line per request, so a multi-line translation is one billed call '
                    + 'per line.'
              }}
            </p>

            <p class="settings-note">
              Language codes are this model's own. The models here use different standards for the
              same languages, so a code valid for one is rejected by the other.
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

            <TranslationView
              v-if="translation && receipt && applied"
              :translation="translation"
              :source-language="applied.sourceLanguage"
              :target-language="applied.targetLanguage"
              :source-language-name="languageName(applied.sourceLanguage)"
              :target-language-name="languageName(applied.targetLanguage)"
              :run-id="receipt.runId"
            />

            <!--
              Secondary by design: the specification is explicit that the Read Text handoff is
              optional functionality rather than part of the primary run path, so it sits below the
              result rather than beside the Translate button.
            -->
            <div v-if="translation" class="handoff">
              <v-btn variant="outlined" @click="readTranslationAloud">Read this aloud</v-btn>
              <p class="hint">
                Sends the translation to Read Text. Long translations are shortened to what that
                panel accepts, and it will say so.
              </p>
            </div>
          </section>
        </template>
      </PanelWorkspace>

      <InfoDialog :open="showRunDetails" title="Run details" @close="showRunDetails = false">
        <!--
          This is the first panel whose run details routinely list several gateway requests, because
          a non-batching model makes one per line. The cost stays pending until every one of them
          has reported.
        -->
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
.translate-text {
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
  max-width: 36rem;
  resize: vertical;
}

/*
  `align-items: end` so the swap button lines up with the two selectors rather than with their
  labels, which sit above them and have different heights when one side is plain text.
*/
.pair {
  align-items: end;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  max-width: 36rem;
}

.pair-field {
  flex: 1 1 10rem;
}

.swap {
  background: transparent;
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.35rem;
  color: inherit;
  cursor: pointer;
  font: inherit;
  /* 2.75rem square: a comfortable target for an icon-only control. */
  min-height: 2.75rem;
  min-width: 2.75rem;
}

.swap:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.swap:focus-visible,
.example:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.fixed-language {
  margin: 0;
  min-height: 2.25rem;
  padding: 0.375rem 0;
}

.examples {
  min-width: 0;
}

.example-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.example {
  background: transparent;
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 999px;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-size: 0.875rem;
  min-height: 2.25rem;
  padding: 0.25rem 0.75rem;
}

.actions {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.status,
.settings-note,
.hint,
.blocked {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0;
}

.settings-note,
.hint,
.blocked {
  font-size: 0.875rem;
}

.cost-estimate {
  background-color: rgb(var(--v-theme-surface-variant));
  border-radius: 0.5rem;
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin: 0;
  padding: 0.75rem;
}

.handoff {
  border-top: 1px solid rgb(var(--v-theme-outline-variant));
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-top: 1rem;
}

.error {
  color: rgb(var(--v-theme-error));
  margin: 0;
}

.docs-link {
  margin: 0.5rem 0 0;
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
</style>
