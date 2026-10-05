<script setup lang="ts">
/**
 * Route composition for the phase-thirteen Semantic Search panel.
 *
 * The panel demonstrates retrieval rather than generation: an embedding model maps the query and
 * passages into a numerical space, then the Worker ranks locally with cosine similarity. The
 * cross-encoder option makes the production trade-off visible: it reads query/passage pairs again
 * on every search, so it cannot reuse the passage cache and its scores are not comparable with
 * cosine similarity.
 */
import { computed, onMounted, ref } from 'vue';
import {
  MAX_SEMANTIC_SEARCH_PASSAGE_CHARACTERS,
  MAX_SEMANTIC_SEARCH_PASSAGES,
  MAX_SEMANTIC_SEARCH_QUERY_CHARACTERS
} from '../../shared/semantic-search';
import { findTask } from '../../shared/tasks';
import InfoButton from '../components/InfoButton.vue';
import InfoDialog from '../components/InfoDialog.vue';
import ModelSettingsPanel from '../components/ModelSettingsPanel.vue';
import PanelPage from '../components/PanelPage.vue';
import PanelWorkspace from '../components/PanelWorkspace.vue';
import {
  describeScoreScale,
  describeSearchCost,
  describeVisiblePassages
} from '../components/results/ranked-passages';
import RankedPassages from '../components/results/RankedPassages.vue';
import RunDetails from '../components/runs/RunDetails.vue';
import {
  SEMANTIC_SEARCH_EXAMPLES,
  type SemanticSearchExample
} from '../features/semantic-search/examples';
import { useSemanticSearch } from '../features/semantic-search/useSemanticSearch';
import { useCatalogueStore } from '../stores/catalogue';

const task = computed(() => findTask('semantic-search'));
const catalogue = useCatalogueStore();
const models = computed(() => catalogue.modelsForTask('semantic-search'));

const {
  query,
  passages,
  model,
  topK,
  selectedModel,
  cacheable,
  searching,
  error,
  result,
  resultQuery,
  resultPassages,
  receipt,
  metrics,
  costPending,
  applied,
  queryCharacterCount,
  canSearch,
  blockedReason,
  canAddPassage,
  addPassage,
  removePassage,
  loadExample,
  run,
  cancel
} = useSemanticSearch({ models });

const showRunDetails = ref(false);
const showStructured = ref(false);
const controls = computed(() => selectedModel.value?.semanticSearchControls);
const hasOutput = computed(() => result.value !== undefined);
const resultDimensions = computed(() => controls.value?.dimensions);
const structuredResponse = computed(() =>
  result.value === undefined ? '' : JSON.stringify(result.value, null, 2)
);
const visiblePassagesSentence = computed(() =>
  result.value === undefined
    ? ''
    : describeVisiblePassages(result.value.rankings.length, result.value.totalRanked)
);
const scoreScaleSentence = computed(() =>
  result.value === undefined
    ? ''
    : describeScoreScale(
        result.value.strategy,
        resultDimensions.value,
        controls.value?.collapsesIrrelevantScores === true
      )
);
const costSentence = computed(() =>
  result.value === undefined
    ? ''
    : describeSearchCost(
        result.value.usage.inferenceCallCount,
        result.value.usage.embeddedPassageCount,
        result.value.usage.cachedPassageCount,
        result.value.usage.queryEmbedded
      )
);

/**
 * Loads a prepared collection without spending credit.
 */
function chooseExample(example: SemanticSearchExample): void {
  loadExample(example);
}

/**
 * Updates one editable passage and invalidates the current result.
 */
function setPassage(index: number, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement)) return;
  passages.value = passages.value.map((passage, position) =>
    position === index ? target.value : passage
  );
  // The composable discards results on structural edits; clearing here covers text edits too, whose
  // index is unchanged but whose embedding is no longer the vector that was ranked.
  result.value = undefined;
}

onMounted(() => {
  void catalogue.load();
});
</script>

<template>
  <PanelPage v-if="task" :task="task">
    <template #description>
      <p class="attribution" role="note">
        This panel calls real models and spends real inference credit. Your verified email is
        recorded in the AI Gateway log for each request so spending can be attributed. Assume your
        query and passages are logged too: do not submit anything confidential.
      </p>
      <p class="attribution" role="note">
        Semantic search ranks passages by meaning, not by matching words. A similarity score is not
        a probability, a factual-confidence measure, or a number you can compare between models.
      </p>
      <p class="attribution" role="note">
        Embedding models cache a passage vector for this Worker session: unchanged passages can be
        reused for free. The cross-encoder reads the query with every passage every time, so it has
        no reusable passage vector and its cost grows with the collection on every search.
      </p>
    </template>

    <div class="semantic-search">
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <PanelWorkspace :has-output="hasOutput">
        <template #input>
          <section class="composer" aria-labelledby="composer-heading">
            <h2 id="composer-heading" class="section-heading">Search collection</h2>
            <div class="field">
              <label class="field-label" for="semantic-query">Question</label>
              <textarea
                id="semantic-query"
                v-model="query"
                aria-label="Question to search for"
                class="textarea"
                rows="3"
                aria-describedby="semantic-query-hint"
                placeholder="Ask what you want to find."
              ></textarea>
              <p id="semantic-query-hint" class="hint">
                {{ queryCharacterCount.toLocaleString() }} of
                {{ MAX_SEMANTIC_SEARCH_QUERY_CHARACTERS.toLocaleString() }} characters.
              </p>
            </div>
            <div class="passages">
              <span class="field-label">Passages to search</span>
              <p class="hint">
                Each passage may have
                {{ MAX_SEMANTIC_SEARCH_PASSAGE_CHARACTERS.toLocaleString() }} characters. The first
                search embeds new passages; unchanged embedding-model passages may be reused later.
              </p>
              <div v-for="(_passage, index) in passages" :key="index" class="passage-row">
                <label class="visually-hidden" :for="`semantic-passage-${index}`"
                  >Passage {{ index + 1 }}</label
                >
                <textarea
                  :id="`semantic-passage-${index}`"
                  :value="passages[index]"
                  :aria-label="`Passage ${index + 1}`"
                  class="textarea passage-text"
                  rows="3"
                  :placeholder="`Passage ${index + 1}`"
                  @input="setPassage(index, $event)"
                ></textarea>
                <button
                  class="remove"
                  type="button"
                  :disabled="passages.length === 1"
                  :aria-label="`Remove passage ${index + 1}`"
                  @click="removePassage(index)"
                >
                  Remove
                </button>
              </div>
              <button class="add" type="button" :disabled="!canAddPassage" @click="addPassage">
                Add passage
              </button>
              <p class="hint">
                {{ passages.length }} of {{ MAX_SEMANTIC_SEARCH_PASSAGES }} passage slots.
              </p>
            </div>
            <div class="examples">
              <span class="field-label">Prepared collections</span>
              <div class="example-buttons">
                <button
                  v-for="example in SEMANTIC_SEARCH_EXAMPLES"
                  :key="example.label"
                  type="button"
                  class="example"
                  :title="example.note"
                  @click="chooseExample(example)"
                >
                  {{ example.label }}<span class="visually-hidden">. {{ example.note }}</span>
                </button>
              </div>
            </div>
            <div class="actions">
              <v-btn
                class="search-button"
                color="primary"
                :disabled="!canSearch"
                variant="flat"
                @click="run"
                >Search</v-btn
              >
              <v-btn v-if="searching" class="cancel-button" variant="outlined" @click="cancel"
                >Stop waiting</v-btn
              >
            </div>
            <p v-if="blockedReason" class="blocked" role="status">{{ blockedReason }}</p>
            <p class="status" role="status">
              <template v-if="searching"
                >Searching. Stopping will not cancel a model request already sent.</template
              ><template v-else-if="result">Search ready.</template>
            </p>
          </section>
          <ModelSettingsPanel :model-name="selectedModel?.name" :model-id="selectedModel?.id">
            <div class="field">
              <label class="field-label" for="semantic-model">Model</label>
              <select id="semantic-model" v-model="model" class="select">
                <option v-for="candidate in models" :key="candidate.id" :value="candidate.id">
                  {{ candidate.name }}
                </option>
              </select>
            </div>
            <div v-if="controls?.topK" class="field">
              <label class="field-label" for="semantic-top-k">Passages to show ({{ topK }})</label>
              <input
                id="semantic-top-k"
                v-model.number="topK"
                aria-label="Passages to show"
                class="range"
                type="range"
                :min="controls.topK.min"
                :max="controls.topK.max"
                :step="controls.topK.step"
              />
            </div>
            <p v-if="controls" class="settings-note">
              <template v-if="controls.strategy === 'embedding'">
                {{ controls.dimensions }}-dimension vectors; cosine similarity is calculated by this
                application after the model returns vectors.
                {{ cacheable ? 'Passage vectors are reusable in this session.' : '' }}
              </template>
              <template v-else>
                This cross-encoder reads the query with every passage and returns relevance
                directly. It has no reusable vectors, so every search makes a new model call for the
                collection.
              </template>
            </p>
            <p v-if="selectedModel" class="docs-link">
              <a :href="selectedModel.documentationUrl" rel="noreferrer" target="_blank"
                >{{ selectedModel.name }} in the model catalog</a
              >
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
            <p v-if="result" class="result-note">
              Results for: <strong>{{ resultQuery }}</strong>
            </p>
            <RankedPassages
              v-if="result && result.rankings.length > 0"
              :rankings="result.rankings"
              :passages="resultPassages"
              :caption="'Passages ranked by this model, highest first'"
              :show-cache-state="result.strategy === 'embedding'"
            />
            <p v-if="visiblePassagesSentence" class="result-note">{{ visiblePassagesSentence }}</p>
            <p v-if="scoreScaleSentence" class="result-note">{{ scoreScaleSentence }}</p>
            <p v-if="costSentence" class="cache-note" role="status">{{ costSentence }}</p>
            <details v-if="result?.queryVector" class="vector-summary">
              <summary>Vector summary</summary>
              <p>
                The query became a {{ result.queryVector.dimensions }}-number vector with magnitude
                {{ result.queryVector.norm.toFixed(6) }}. No component has an individual meaning;
                this is a deliberately small inspection window.
              </p>
              <pre>{{ JSON.stringify(result.queryVector, null, 2) }}</pre>
            </details>
            <details v-if="result" class="structured" :open="showStructured">
              <summary>Structured response</summary>
              <pre class="structured-json">{{ structuredResponse }}</pre>
            </details>
          </section>
        </template>
      </PanelWorkspace>
      <InfoDialog :open="showRunDetails" title="Run details" @close="showRunDetails = false"
        ><RunDetails
          v-if="receipt"
          embedded
          :receipt="receipt"
          :metrics="metrics"
          :cost-pending="costPending"
      /></InfoDialog>
    </div>
  </PanelPage>
</template>

<style scoped>
.semantic-search,
.composer,
.result {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}
.semantic-search {
  gap: 1.25rem;
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
.field,
.passages,
.examples {
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
.passage-row {
  align-items: flex-start;
  display: flex;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
.passage-text {
  max-width: 36rem;
}
.remove,
.add,
.example {
  background: transparent;
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.375rem;
  color: inherit;
  cursor: pointer;
  font: inherit;
  min-height: 2.25rem;
  padding: 0.25rem 0.75rem;
}
.example {
  border-radius: 999px;
  font-size: 0.875rem;
}
.add {
  margin-top: 0.5rem;
}
.remove:disabled,
.add:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.example-buttons,
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.actions {
  gap: 0.75rem;
}
.range {
  width: 100%;
}
.status,
.settings-note,
.hint,
.blocked,
.result-note,
.cache-note {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0;
}
.settings-note,
.hint,
.blocked,
.result-note,
.cache-note {
  font-size: 0.875rem;
}
.cache-note {
  border-left: 3px solid rgb(var(--v-theme-primary));
  padding-left: 0.75rem;
}
.error {
  color: rgb(var(--v-theme-error));
  margin: 0;
}
.vector-summary,
.structured {
  border-top: 1px solid rgb(var(--v-theme-outline-variant));
  padding-top: 0.5rem;
}
.vector-summary summary,
.structured summary {
  cursor: pointer;
  font-size: 0.875rem;
  min-height: 2.25rem;
  padding: 0.4rem 0;
}
.vector-summary pre,
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
@media (max-width: 40rem) {
  .passage-row {
    flex-direction: column;
  }
  .remove {
    width: 100%;
  }
}
</style>
