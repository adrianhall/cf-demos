<script setup lang="ts">
/**
 * Route composition for the phase-twelve Classify Text panel.
 *
 * The panel exists to teach the **fixed-label contract**: a classifier sorts text into categories
 * it was trained on, and the caller cannot invent them. So the complete label set is published
 * _before_ any run — a visitor can see every answer the model is capable of giving without
 * submitting anything, which is the clearest possible demonstration of what "fixed label" means and
 * the thing a text generator cannot offer.
 *
 * That is also what separates this panel from Evaluate Choices, where the questions _are_ the
 * caller's. The two are cross-linked here but share no API: the request type has no field for a
 * label, and the server refuses a body that adds one.
 *
 * The two reviewed models return genuinely different kinds of answer — one a scored ranking, one a
 * verdict with no score for anything — so the result area switches renderer on the outcome's
 * discriminant rather than assuming a shape.
 */
import { computed, onMounted, ref } from 'vue';
import { MAX_CLASSIFICATION_TEXT_CHARACTERS } from '../../shared/classify-text';
import { findTask } from '../../shared/tasks';
import InfoButton from '../components/InfoButton.vue';
import InfoDialog from '../components/InfoDialog.vue';
import ModelSettingsPanel from '../components/ModelSettingsPanel.vue';
import PanelPage from '../components/PanelPage.vue';
import PanelWorkspace from '../components/PanelWorkspace.vue';
import ClassificationVerdictView from '../components/results/ClassificationVerdictView.vue';
import { describeVisibleLabels } from '../components/results/ranked-labels';
import RankedLabels from '../components/results/RankedLabels.vue';
import RunDetails from '../components/runs/RunDetails.vue';
import {
  CLASSIFICATION_EXAMPLES,
  type ClassificationExample
} from '../features/classify-text/examples';
import { useClassifyText } from '../features/classify-text/useClassifyText';
import { useCatalogueStore } from '../stores/catalogue';

const task = computed(() => findTask('classify-text'));
const catalogue = useCatalogueStore();

/**
 * Reviewed models for this panel, as the server reported them.
 */
const models = computed(() => catalogue.modelsForTask('classify-text'));

const {
  text,
  model,
  topK,
  minimumConfidence,
  selectedModel,
  scoresLabels,
  labelSetName,
  labelSet,
  classifying,
  error,
  outcome,
  receipt,
  metrics,
  costPending,
  applied,
  characterCount,
  canClassify,
  blockedReason,
  run,
  cancel
} = useClassifyText({ models });

/**
 * Whether the run-details modal is showing.
 */
const showRunDetails = ref(false);

/**
 * Whether the structured response disclosure is open.
 *
 * Closed by default. The rendered result is the answer; the raw JSON is reference material for
 * someone checking exact values, which is a different need.
 */
const showStructured = ref(false);

/**
 * The selected model's declared classification controls, or `undefined` before the catalogue loads.
 */
const controls = computed(() => selectedModel.value?.textClassificationControls);

/**
 * Whether the output column has anything to show.
 *
 * @returns `true` once an outcome exists.
 */
const hasOutput = computed(() => outcome.value !== undefined);

/**
 * The run's result as formatted JSON, for the structured disclosure.
 *
 * The outcome exactly as the server returned it, including full-precision scores. The rendered view
 * rounds for legibility, and this is where someone checks what the rounding hid.
 *
 * @returns Pretty-printed JSON, or an empty string before a run.
 */
const structuredResponse = computed(() =>
  outcome.value === undefined ? '' : JSON.stringify(outcome.value, null, 2)
);

/**
 * The sentence describing how much of a scored model's output is on screen.
 *
 * @returns The sentence, or an empty string when the outcome is not a ranking.
 */
const visibleLabelsSentence = computed(() =>
  outcome.value?.kind === 'scored-labels'
    ? describeVisibleLabels(outcome.value.labels.length, outcome.value.totalLabels)
    : ''
);

/**
 * Loads a prepared passage.
 *
 * @param example Example to load.
 * @returns Nothing; the text is set. The run is not started automatically — a prepared passage that
 *   spent credit the moment it was clicked would be a trap.
 */
function loadExample(example: ClassificationExample): void {
  text.value = example.text;
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
        text is logged too: treat this as you would any shared AI service and do not submit anything
        confidential.
      </p>
      <p class="attribution" role="note">
        This is <strong>fixed-label classification</strong>. The model sorts your text into
        categories it was trained on, and you cannot add to them or ask your own question — the full
        set of possible answers is listed below the model selector before you run anything. For
        caller-defined questions and criteria, use <strong>Evaluate Choices</strong>, which is a
        separate task with a separate API.
      </p>
      <p class="attribution" role="note">
        A score is the model's own output, not a probability that the label is correct. Two labels
        at 0.51 and 0.49 mean the model is close to undecided, not that the first is slightly true.
        One of the models here reports no score at all, and the panel shows its answer differently
        rather than inventing a number.
      </p>
    </template>

    <div class="classify-text">
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <PanelWorkspace :has-output="hasOutput">
        <template #input>
          <section class="composer" aria-labelledby="composer-heading">
            <h2 id="composer-heading" class="section-heading">Text</h2>

            <div class="field">
              <label class="field-label" for="classify-text-input">Text to classify</label>
              <textarea
                id="classify-text-input"
                v-model="text"
                class="textarea"
                rows="7"
                aria-describedby="classify-text-hint"
                placeholder="Type or paste the text to classify."
              ></textarea>
              <p id="classify-text-hint" class="hint">
                {{ characterCount.toLocaleString() }} of
                {{ MAX_CLASSIFICATION_TEXT_CHARACTERS.toLocaleString() }} characters.
              </p>
            </div>

            <div class="examples">
              <span class="field-label">Prepared passages</span>
              <div class="example-buttons">
                <button
                  v-for="example in CLASSIFICATION_EXAMPLES"
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
                class="classify-button"
                color="primary"
                :disabled="!canClassify"
                variant="flat"
                @click="run"
              >
                Classify
              </v-btn>
              <v-btn v-if="classifying" class="cancel-button" variant="outlined" @click="cancel">
                Stop waiting
              </v-btn>
            </div>

            <p v-if="blockedReason" class="blocked" role="status">{{ blockedReason }}</p>

            <!--
              Persistent so the text *changes* from the start phrase to the completion phrase.
              Screen readers announce that more reliably than a live region inserted already
              populated after the result arrives.
            -->
            <p class="status" role="status">
              <template v-if="classifying">
                Classifying. Stopping will not cancel the request already sent.
              </template>
              <template v-else-if="outcome">Classification ready.</template>
            </p>
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

            <!--
              The complete label set, published before any run. This is the panel's central
              teaching device: the answer is guaranteed to come from this list, and a visitor can
              check that for themselves rather than taking it on trust.
            -->
            <div v-if="labelSet.length > 0" class="label-set">
              <span class="field-label">{{ labelSetName }} — every possible answer</span>
              <ul class="label-list">
                <li v-for="entry in labelSet" :key="entry.code" class="label-entry">
                  <span class="label-code">{{ entry.code }}</span>
                  <span class="label-name">{{ entry.name }}</span>
                  <span v-if="entry.description" class="label-description">
                    {{ entry.description }}
                  </span>
                </li>
              </ul>
              <p class="settings-note">
                {{ labelSet.length }} {{ labelSet.length === 1 ? 'category' : 'categories' }}, and
                the model cannot return anything outside them.
              </p>
            </div>

            <!--
              Rendered only where the model has scores to rank. A verdict model has no such
              control, and the server refuses one rather than accepting and ignoring it.
            -->
            <template v-if="scoresLabels && controls?.topK">
              <div class="field">
                <label class="field-label" for="classify-top-k">
                  Labels to show ({{ topK }})
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
            </template>

            <template v-if="scoresLabels && controls?.minimumConfidence">
              <div class="field">
                <label class="field-label" for="classify-minimum-confidence">
                  Minimum score ({{ minimumConfidence }})
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
              </div>
            </template>

            <p v-if="scoresLabels" class="settings-note">
              This model's request schema has no ranking fields, so these controls are applied by
              this application to the response it received — the model was not asked to filter.
            </p>
            <p v-else class="settings-note">
              This model returns a verdict with no confidence score, so there is nothing to rank or
              filter and it offers no result controls.
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

            <!--
              Switched on the outcome's discriminant rather than on the model identifier, so adding
              a third outcome kind fails the build here until it is handled.
            -->
            <template v-if="outcome?.kind === 'scored-labels'">
              <p v-if="applied" class="result-note">
                Scored against the <strong>{{ applied.labelSetName }}</strong> label set.
              </p>
              <RankedLabels
                v-if="outcome.labels.length > 0"
                :labels="outcome.labels"
                caption="Labels this model scored, highest first"
              />
              <!--
                A real outcome of a successful run rather than a failure: every label scored below
                the floor the visitor set. Said plainly, with the remedy.
              -->
              <p v-else class="empty" role="status">
                No label reached the minimum score you set. Lower it to see what the model returned.
              </p>
              <p v-if="visibleLabelsSentence" class="result-note">{{ visibleLabelsSentence }}</p>
            </template>

            <ClassificationVerdictView
              v-else-if="outcome?.kind === 'verdict'"
              :verdict="outcome.verdict"
              :label-set-name="applied?.labelSetName ?? ''"
            />

            <!--
              Native `details`, matching the model-settings pattern used across the panels. The
              deliverable asks for the structured response to be available; it stays one
              disclosure away because the rendered result is the answer.
            -->
            <details v-if="outcome" class="structured" :open="showStructured">
              <summary>Structured response</summary>
              <pre class="structured-json">{{ structuredResponse }}</pre>
            </details>

            <!--
              The cross-link the phase brief asks for. Placed in the result area rather than the
              controls, because the moment someone wants their own criteria is the moment they see
              an answer drawn from a list they did not choose.
            -->
            <p v-if="outcome" class="cross-link">
              Need your own categories or questions instead of this model's?
              <router-link to="/evaluate-choices">Evaluate Choices</router-link> takes
              caller-defined criteria. It is a separate task with its own API; this panel's labels
              are fixed by the model.
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
.classify-text {
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

.range {
  width: 100%;
}

.label-set {
  border: 1px solid rgb(var(--v-theme-outline-variant));
  border-radius: 0.5rem;
  padding: 0.75rem;
}

.label-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  list-style: none;
  margin: 0 0 0.5rem;
  padding: 0;
  /* Bounded so a thirteen-category taxonomy does not push the controls off the screen. */
  max-height: 14rem;
  overflow-y: auto;
}

.label-entry {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: baseline;
}

.label-code {
  background-color: rgb(var(--v-theme-surface-variant));
  border-radius: 0.25rem;
  font-family: ui-monospace, monospace;
  font-size: 0.75rem;
  padding: 0.05rem 0.35rem;
}

.label-name {
  font-size: 0.875rem;
}

.label-description {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
  flex-basis: 100%;
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

.example:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
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
.blocked,
.result-note,
.empty,
.cross-link {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0;
}

.settings-note,
.hint,
.blocked,
.result-note,
.empty,
.cross-link {
  font-size: 0.875rem;
}

.cross-link {
  border-top: 1px solid rgb(var(--v-theme-outline-variant));
  padding-top: 0.75rem;
}

.error {
  color: rgb(var(--v-theme-error));
  margin: 0;
}

.structured summary {
  cursor: pointer;
  font-size: 0.875rem;
  min-height: 2.25rem;
  padding: 0.4rem 0;
}

.structured summary:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

/*
  Monospaced and scrollable: this view exists precisely for someone checking exact values, so the
  digits must line up and a long response must not stretch the column.
*/
.structured-json {
  background-color: rgb(var(--v-theme-surface-variant));
  border-radius: 0.375rem;
  font-family: ui-monospace, monospace;
  font-size: 0.8125rem;
  margin: 0;
  max-height: 20rem;
  overflow: auto;
  padding: 0.75rem;
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
