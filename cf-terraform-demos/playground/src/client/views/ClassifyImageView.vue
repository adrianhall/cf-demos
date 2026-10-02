<script setup lang="ts">
/**
 * Route composition for the phase-seven Classify Image panel.
 *
 * The first panel whose model is not generative, and the copy carries most of that difference. A
 * confidence bar is very good at implying that a score is a probability of being right, so the
 * panel states what the scores are in three places: beside the controls, above the result, and in
 * the About dialog. The structured response stays one disclosure away, because the ranked table is
 * the result and the JSON is reference material.
 */
import { computed, onMounted, ref } from 'vue';
import { findTask } from '../../shared/tasks';
import InfoButton from '../components/InfoButton.vue';
import InfoDialog from '../components/InfoDialog.vue';
import { formatBytes } from '../components/media/image-input';
import SourceImagePicker from '../components/media/SourceImagePicker.vue';
import ModelSettingsPanel from '../components/ModelSettingsPanel.vue';
import PanelPage from '../components/PanelPage.vue';
import PanelWorkspace from '../components/PanelWorkspace.vue';
import { describeVisibleLabels } from '../components/results/ranked-labels';
import RankedLabels from '../components/results/RankedLabels.vue';
import RunDetails from '../components/runs/RunDetails.vue';
import {
  CLASSIFICATION_EXAMPLES,
  type ClassificationExample
} from '../features/classify-image/examples';
import { useClassifyImage } from '../features/classify-image/useClassifyImage';
import { useCatalogueStore } from '../stores/catalogue';
import { useHandoffStore } from '../stores/handoff';

const task = computed(() => findTask('classify-image'));
const catalogue = useCatalogueStore();
const handoff = useHandoffStore();

/**
 * Reviewed models for this panel, as the server reported them.
 */
const models = computed(() => catalogue.modelsForTask('classify-image'));

const {
  image,
  model,
  topK,
  minimumConfidence,
  selectedModel,
  classifying,
  error,
  labels,
  totalLabels,
  verified,
  receipt,
  metrics,
  costPending,
  applied,
  canClassify,
  selectFile,
  acceptHandoff,
  clearImage,
  classify,
  cancel
} = useClassifyImage({ models });

/**
 * Whether the run-details modal is showing.
 */
const showRunDetails = ref(false);

/**
 * Whether the structured response disclosure is open.
 *
 * Closed by default. The ranked table is the result; the raw JSON is reference material for someone
 * checking what the model actually returned, and making it the dominant content would teach that
 * reading JSON is the normal way to use a classifier.
 */
const showStructured = ref(false);

/**
 * The selected model's declared result controls, or `undefined` before the catalogue loads.
 */
const controls = computed(() => selectedModel.value?.classificationControls);

/**
 * Whether the output column has anything to show.
 *
 * True as soon as a picture is chosen, matching Describe Image: the picture belongs beside its
 * ranking, and switching the layout only on completion would move the input mid-run.
 *
 * @returns `true` when a picture has been chosen or a ranking exists.
 */
const hasOutput = computed(() => image.value !== undefined || labels.value !== undefined);

/**
 * A sentence explaining where this model's result controls are applied.
 *
 * The honest version of a slider. The reviewed classifier's request schema accepts the picture and
 * nothing else, so a visitor moving the top-k slider is changing what the panel shows, not what the
 * model does — and a control that silently implied otherwise would misteach the one thing this
 * panel exists to demonstrate.
 *
 * @returns The sentence, or an empty string before a model has been selected.
 */
const controlExplanation = computed(() => {
  const support = controls.value;
  if (support === undefined || selectedModel.value === undefined) {
    return '';
  }

  return support.appliedBy === 'model'
    ? `${selectedModel.value.name} applies these controls itself, as request parameters.`
    : `${selectedModel.value.name} takes no ranking parameters: it scores the picture against `
        + 'every category it knows, and these controls decide how much of that answer is shown.';
});

/**
 * The sentence describing how much of the model's output is on screen.
 *
 * @returns The sentence, or an empty string before a run.
 */
const visibleLabelsSentence = computed(() =>
  labels.value === undefined || totalLabels.value === undefined
    ? ''
    : describeVisibleLabels(labels.value.length, totalLabels.value)
);

/**
 * The run's result as formatted JSON, for the structured disclosure.
 *
 * Built from the full-precision scores rather than the displayed percentages, so the disclosure
 * shows the model's actual output and the table is the only thing rounding anything.
 *
 * @returns Pretty-printed JSON, or an empty string before a run.
 */
const structuredResponse = computed(() =>
  labels.value === undefined
    ? ''
    : JSON.stringify({ labels: labels.value, totalLabels: totalLabels.value }, null, 2)
);

onMounted(() => {
  void catalogue.load();

  // Collected once, on mount. The store clears it on read, so returning to this panel later does
  // not silently reload a picture the visitor has moved on from.
  const pending = handoff.take();
  if (pending !== undefined) {
    acceptHandoff(pending);
  }
});

/**
 * Loads a prepared combination of result controls.
 *
 * @param example Example to load.
 * @returns Nothing; the controls are set. The run is not started automatically — a prepared setting
 *   that spent credit the moment it was clicked would be a trap.
 */
function loadExample(example: ClassificationExample): void {
  topK.value = example.topK;
  minimumConfidence.value = example.minimumConfidence;
}
</script>

<template>
  <PanelPage v-if="task" :task="task">
    <!--
      The credit-and-logging disclosure, plus the one thing this panel has to say that no earlier
      panel did: what a confidence score is and is not. It is placed here, in the always-reachable
      About dialog, as well as above the result, because a visitor who reads only one of the two
      should still get it.
    -->
    <template #description>
      <p class="attribution" role="note">
        This panel calls a real model and spends real inference credit. Your verified email is
        recorded in the AI Gateway log for each request so spending can be attributed. Assume your
        picture is logged too: treat this as you would any shared AI service and do not upload
        anything confidential.
      </p>
      <p class="attribution" role="note">
        A classifier does not look things up or reason about your picture. It scores it against a
        fixed list of categories it was trained on, and the score is the model's own output — not a
        probability that the label is correct, and not a measure of whether the right category
        exists in its list at all. A picture of something it was never trained on still produces a
        confident-looking ranking.
      </p>
    </template>

    <div class="classify-image">
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <PanelWorkspace :has-output="hasOutput">
        <template #input>
          <section class="composer" aria-labelledby="composer-heading">
            <h2 id="composer-heading" class="section-heading">Classify a picture</h2>

            <SourceImagePicker
              label="Picture to classify"
              :image="image"
              :busy="classifying"
              @selected="selectFile"
              @cleared="clearImage"
            />

            <div class="actions">
              <v-btn
                class="classify-button"
                color="primary"
                :disabled="!canClassify"
                variant="flat"
                @click="classify"
              >
                Classify
              </v-btn>
              <v-btn v-if="classifying" class="cancel-button" variant="outlined" @click="cancel">
                Stop waiting
              </v-btn>
            </div>

            <p v-if="image === undefined" class="hint">Choose a picture to classify.</p>

            <!--
              Persistent so the text *changes* from the start phrase to the completion phrase.
              Screen readers announce that more reliably than a live region inserted already
              populated after the result arrives.
            -->
            <p class="status" role="status">
              <template v-if="classifying">Classifying. This usually takes a moment.</template>
              <template v-else-if="labels">Labels ready.</template>
            </p>

            <div class="example-group" role="group" aria-labelledby="examples-heading">
              <h3 id="examples-heading" class="field-label">Or try a view of the result</h3>
              <div class="examples">
                <button
                  v-for="example in CLASSIFICATION_EXAMPLES"
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

          <ModelSettingsPanel :model-name="selectedModel?.name">
            <div class="field">
              <label class="field-label" for="classify-model">Model</label>
              <select id="classify-model" v-model="model" class="select">
                <option v-for="candidate in models" :key="candidate.id" :value="candidate.id">
                  {{ candidate.name }}
                </option>
              </select>
            </div>

            <p class="settings-note">
              <span v-if="controlExplanation">{{ controlExplanation }}</span>
            </p>

            <div v-if="controls?.topK" class="field">
              <label class="field-label" for="classify-top-k">
                Labels to show ({{ topK ?? `model default: ${controls.topK.default}` }})
              </label>
              <input
                id="classify-top-k"
                v-model.number="topK"
                class="range"
                type="range"
                :min="controls.topK.min"
                :max="controls.topK.max"
                :step="controls.topK.step"
              />
            </div>

            <div v-if="controls?.minimumConfidence" class="field">
              <label class="field-label" for="classify-minimum-confidence">
                Minimum score
                {{
                  minimumConfidence === undefined
                    ? `(model default: ${controls.minimumConfidence.default})`
                    : `(${(minimumConfidence * 100).toFixed(0)}%)`
                }}
              </label>
              <input
                id="classify-minimum-confidence"
                v-model.number="minimumConfidence"
                class="range"
                type="range"
                :min="controls.minimumConfidence.min"
                :max="controls.minimumConfidence.max"
                :step="controls.minimumConfidence.step"
              />
              <p class="hint">
                Hides labels the model scored below this. It does not make the remaining labels any
                more likely to be right.
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

            <!--
              No second copy of the picture here. The workspace puts the picker's own preview in
              the column immediately beside this one, so the original is already next to its
              ranking; repeating it would use the output column's width to show something the
              visitor can already see.
            -->
            <p v-if="!labels && !classifying" class="awaiting">
              The labels this model recognises will appear here.
            </p>

            <!--
              An empty ranking is a real outcome of a successful run, not an absence of one. Saying
              so — and naming the floor as the reason — is the difference between "the model found
              nothing" and "you hid everything it found".
            -->
            <p v-else-if="labels && labels.length === 0" class="empty-result">
              This model returned {{ totalLabels }} {{ totalLabels === 1 ? 'label' : 'labels' }},
              and none of them scored above your minimum. Lower the minimum score to see what it
              suggested.
            </p>

            <template v-else-if="labels && labels.length > 0">
              <p class="score-caveat">
                These scores are the model's own output. A high score means the picture resembles
                that category's training data, not that the label is correct.
              </p>

              <RankedLabels :labels="labels" :caption="visibleLabelsSentence" />

              <!--
                Native `details`, matching the model-settings pattern used across the panels: open
                and close without JavaScript, announced as a disclosure, and keyboard-operable
                because it is a real summary rather than a styled div.
              -->
              <details class="structured" :open="showStructured">
                <summary @click="showStructured = !showStructured">Structured response</summary>
                <pre class="structured-json">{{ structuredResponse }}</pre>
              </details>
            </template>

            <dl v-if="verified" class="verified-facts">
              <div class="fact">
                <dt>Format</dt>
                <dd>{{ verified.mediaType }}</dd>
              </div>
              <div class="fact">
                <dt>Dimensions</dt>
                <dd>{{ verified.width }} × {{ verified.height }}</dd>
              </div>
              <div class="fact">
                <dt>Size</dt>
                <dd>{{ formatBytes(verified.byteLength) }}</dd>
              </div>
              <div v-if="applied?.topK !== undefined" class="fact">
                <dt>Labels shown</dt>
                <dd>{{ applied.topK }}</dd>
              </div>
              <div v-if="applied?.minimumConfidence !== undefined" class="fact">
                <dt>Minimum score</dt>
                <dd>{{ (applied.minimumConfidence * 100).toFixed(0) }}%</dd>
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
.classify-image {
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

.range {
  min-height: 1.5rem;
  width: 100%;
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
.hint,
.awaiting,
.score-caveat,
.empty-result {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin: 0;
}

.score-caveat {
  background-color: rgb(var(--v-theme-surface-variant));
  border-radius: 0.5rem;
  padding: 0.75rem;
}

.structured summary {
  cursor: pointer;
  font-size: 0.875rem;
  min-height: 2.25rem;
  padding-block: 0.4rem;
}

.structured summary:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

/*
  `overflow-x: auto` rather than wrapping: a wrapped JSON line is harder to read than a scrolled
  one, and the structured view exists precisely for someone checking exact values.
*/
.structured-json {
  background-color: rgb(var(--v-theme-surface-variant));
  border-radius: 0.5rem;
  font-size: 0.8125rem;
  margin: 0.5rem 0 0;
  overflow-x: auto;
  padding: 0.75rem;
}

.verified-facts {
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
