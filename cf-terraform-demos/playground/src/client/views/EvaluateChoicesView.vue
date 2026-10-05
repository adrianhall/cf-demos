<script setup lang="ts">
/**
 * Route composition for the phase-fourteen Evaluate Choices panel.
 *
 * This panel is the **inverse of Classify Text**, and the two are cross-linked here because the
 * contrast is what each one teaches. A classifier owns its labels: they were fixed at training
 * time, and that panel's request has no field in which one could be named. Here the questions, the
 * types, the instructions, and the criteria are all the visitor's, written in the builder below and
 * sent exactly as written.
 *
 * What the visitor cannot write is a prompt. The request preview exists to make that checkable
 * rather than merely claimed: it shows the whole payload, and there is no `prompt`, no `system`, no
 * `temperature`, and no "respond only with JSON" anywhere in it. The answers come back as typed
 * structures, so nothing in this panel parses text.
 *
 * Two further things are made visible rather than described. **However many questions are asked, it
 * is one model call** — the question count and the call count are both shown. And the state's token
 * count is computed in the browser, borrowed from View Tokens, so a visitor can watch a large
 * structured state consume the context window before spending anything on it.
 */
import { computed, onMounted, ref, watch } from 'vue';
import {
  EVALUATION_QUESTION_TYPES,
  MAX_EVALUATION_OPTIONS,
  MAX_EVALUATION_QUESTIONS,
  MAX_EVALUATION_STATE_CHARACTERS,
  MIN_EVALUATION_OPTIONS,
  type EvaluationQuestionType
} from '../../shared/evaluate-choices';
import { findTask } from '../../shared/tasks';
import InfoButton from '../components/InfoButton.vue';
import InfoDialog from '../components/InfoDialog.vue';
import ModelSettingsPanel from '../components/ModelSettingsPanel.vue';
import PanelPage from '../components/PanelPage.vue';
import PanelWorkspace from '../components/PanelWorkspace.vue';
import { describeEvaluationUsage } from '../components/results/evaluation-answers';
import EvaluationAnswerCard from '../components/results/EvaluationAnswerCard.vue';
import RunDetails from '../components/runs/RunDetails.vue';
import { EVALUATION_EXAMPLES, type EvaluationExample } from '../features/evaluate-choices/examples';
import { useEvaluateChoices } from '../features/evaluate-choices/useEvaluateChoices';
import { contextWindowUsage } from '../features/view-tokens/tokenization';
import { createBrowserTokenizer, DEFAULT_TOKENIZER } from '../features/view-tokens/tokenizers';
import { useCatalogueStore } from '../stores/catalogue';

const task = computed(() => findTask('evaluate-choices'));
const catalogue = useCatalogueStore();
const models = computed(() => catalogue.modelsForTask('evaluate-choices'));

const {
  state,
  stateFormat,
  questions,
  model,
  selectedModel,
  evaluating,
  error,
  result,
  resultQuestions,
  receipt,
  metrics,
  costPending,
  applied,
  stateCharacterCount,
  requestPreview,
  canEvaluate,
  blockedReason,
  canAddQuestion,
  addQuestion,
  removeQuestion,
  moveQuestion,
  changeQuestionType,
  addOption,
  removeOption,
  loadExample,
  run,
  cancel
} = useEvaluateChoices({ models });

const showRunDetails = ref(false);
const controls = computed(() => selectedModel.value?.evaluationControls);
const hasOutput = computed(() => result.value !== undefined);

/**
 * Token count of the current state, computed in the browser.
 *
 * The View Tokens handoff. Counted locally for the same reason that panel exists: nothing needs to
 * leave the browser to answer "how big is this", and a visitor should be able to see a structured
 * state's cost before paying for it.
 */
const stateTokenCount = ref(0);
const tokenizer = createBrowserTokenizer();

watch(
  state,
  async (current) => {
    if (current.trim() === '') {
      stateTokenCount.value = 0;
      return;
    }
    try {
      stateTokenCount.value = (await tokenizer.encode(current, DEFAULT_TOKENIZER)).length;
    } catch {
      // A tokenizer failure must not break the form. The count is an aid, and the character
      // ceiling is the control that actually protects the request.
      stateTokenCount.value = 0;
    }
  },
  { immediate: true }
);

/**
 * How much of the selected model's context window the state occupies.
 *
 * @returns The percentage, or `undefined` when the window size is not known yet.
 */
const windowUsage = computed(() =>
  contextWindowUsage(stateTokenCount.value, controls.value?.contextWindowTokens)
);

/**
 * The questions the displayed result answers, keyed for lookup beside each answer.
 */
const resultInstructions = computed(
  () => new Map(resultQuestions.value.map((entry) => [entry.name, entry.question.instructions]))
);

/**
 * The sentence describing what the evaluation cost in the model's own terms.
 */
const usageSentence = computed(() =>
  result.value === undefined
    ? ''
    : describeEvaluationUsage(
        result.value.usage.inputTokens,
        result.value.usage.outputTokens,
        result.value.answers.length
      )
);

/**
 * Pretty-printed typed response, shown beside the visual rendering.
 */
const structuredResponse = computed(() =>
  result.value === undefined ? '' : JSON.stringify(result.value, null, 2)
);

/**
 * Loads a prepared scenario.
 *
 * @param example Scenario to load.
 * @returns Nothing; the form holds the scenario. The run is not started automatically — a prepared
 *   scenario that spent credit the moment it was clicked would be a trap.
 */
function chooseExample(example: EvaluationExample): void {
  loadExample(example);
}

/**
 * Renames one question.
 *
 * @param index Position of the question.
 * @param value The new name.
 * @returns Nothing; the question is renamed.
 */
function setName(index: number, value: string): void {
  questions.value = questions.value.map((entry, position) =>
    position === index ? { ...entry, name: value } : entry
  );
}

/**
 * Edits one question's instructions.
 *
 * @param index Position of the question.
 * @param value The new instructions.
 * @returns Nothing; the question is updated.
 */
function setInstructions(index: number, value: string): void {
  questions.value = questions.value.map((entry, position) =>
    position === index ? { ...entry, question: { ...entry.question, instructions: value } } : entry
  );
}

/**
 * Edits one of a `noul` question's optional criteria.
 *
 * @param index Position of the question.
 * @param field Which criterion to set.
 * @param value The new description.
 * @returns Nothing; the question is updated, or left alone when it is not a `noul`.
 */
function setCriterion(index: number, field: 'whenTrue' | 'whenFalse', value: string): void {
  questions.value = questions.value.map((entry, position) => {
    if (position !== index || entry.question.type !== 'noul') {
      return entry;
    }
    return { ...entry, question: { ...entry.question, [field]: value } };
  });
}

/**
 * Edits one option of a `choice` question.
 *
 * @param index Position of the question.
 * @param optionIndex Position of the option.
 * @param field Which part of the option to set.
 * @param value The new value.
 * @returns Nothing; the option is updated, or left alone when the question is not a `choice`.
 */
function setOption(
  index: number,
  optionIndex: number,
  field: 'name' | 'description',
  value: string
): void {
  questions.value = questions.value.map((entry, position) => {
    if (position !== index || entry.question.type !== 'choice') {
      return entry;
    }
    return {
      ...entry,
      question: {
        ...entry.question,
        options: entry.question.options.map((option, at) =>
          at === optionIndex ? { ...option, [field]: value } : option
        )
      }
    };
  });
}

/**
 * Edits one legend entry of a `score` question.
 *
 * @param index Position of the question.
 * @param entryIndex Position of the legend entry.
 * @param value The new label.
 * @returns Nothing; the legend is updated, or left alone when the question is not a `score`.
 */
function setLegendEntry(index: number, entryIndex: number, value: string): void {
  questions.value = questions.value.map((entry, position) => {
    if (position !== index || entry.question.type !== 'score') {
      return entry;
    }
    return {
      ...entry,
      question: {
        ...entry.question,
        legend: entry.question.legend.map((label, at) => (at === entryIndex ? value : label))
      }
    };
  });
}

/**
 * Reads the value of an input or textarea event.
 *
 * @param event The DOM event.
 * @returns The element's current value, or `undefined` when the target is not a field.
 */
function fieldValue(event: Event): string | undefined {
  const target = event.target;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    ? target.value
    : undefined;
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
        state and questions are logged too: do not submit anything confidential.
      </p>
      <p class="attribution" role="note">
        A decision model answers typed questions. There is no prompt, no system message, no JSON
        mode, and nothing here parses text — check the request preview below and see for yourself.
        <strong>Every question you add is answered in the same single model call.</strong>
      </p>
      <p class="attribution" role="note">
        This is the opposite of <RouterLink to="/classify-text">Classify Text</RouterLink>, where
        the categories belong to the trained model and you cannot change them. Here the questions
        and the criteria are yours.
      </p>
    </template>

    <div class="evaluate-choices">
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <PanelWorkspace :has-output="hasOutput">
        <template #input>
          <section class="composer" aria-labelledby="state-heading">
            <h2 id="state-heading" class="section-heading">The situation to judge</h2>
            <fieldset class="format">
              <legend class="field-label">State format</legend>
              <label class="radio">
                <input v-model="stateFormat" type="radio" value="text" />
                <span>Plain text</span>
              </label>
              <label class="radio">
                <input v-model="stateFormat" type="radio" value="json" />
                <span>Structured JSON</span>
              </label>
            </fieldset>
            <div class="field">
              <label class="field-label" for="evaluation-state">State</label>
              <textarea
                id="evaluation-state"
                v-model="state"
                aria-describedby="evaluation-state-hint"
                aria-label="The situation to judge"
                class="textarea state-text"
                rows="8"
                placeholder="A support ticket, a review, a transcript, or a JSON document."
              ></textarea>
              <p id="evaluation-state-hint" class="hint">
                {{ stateCharacterCount.toLocaleString() }} of
                {{ MAX_EVALUATION_STATE_CHARACTERS.toLocaleString() }} characters.
                <template v-if="stateTokenCount > 0">
                  Roughly {{ stateTokenCount.toLocaleString() }} tokens, counted in your browser.
                  <template v-if="windowUsage !== undefined">
                    That is about {{ windowUsage }}% of this model&rsquo;s
                    {{ controls?.contextWindowTokens?.toLocaleString() }}-token context window.
                  </template>
                  <RouterLink to="/view-tokens">See how text becomes tokens</RouterLink>.
                </template>
              </p>
            </div>
            <div class="examples">
              <span class="field-label">Prepared scenarios</span>
              <div class="example-buttons">
                <button
                  v-for="example in EVALUATION_EXAMPLES"
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
          </section>

          <section class="composer" aria-labelledby="questions-heading">
            <div class="result-header">
              <h2 id="questions-heading" class="section-heading">Questions</h2>
              <span class="call-count"
                >{{ questions.length }} {{ questions.length === 1 ? 'question' : 'questions' }}, 1
                model call</span
              >
            </div>

            <article v-for="(entry, index) in questions" :key="index" class="question-editor">
              <div class="question-head">
                <div class="field name-field">
                  <label class="field-label" :for="`question-name-${index}`">Answer key</label>
                  <input
                    :id="`question-name-${index}`"
                    :value="entry.name"
                    :aria-label="`Question ${index + 1} answer key`"
                    class="input"
                    type="text"
                    @input="setName(index, fieldValue($event) ?? entry.name)"
                  />
                </div>
                <div class="field type-field">
                  <label class="field-label" :for="`question-type-${index}`">Type</label>
                  <select
                    :id="`question-type-${index}`"
                    :value="entry.question.type"
                    :aria-label="`Question ${index + 1} type`"
                    class="select"
                    @change="
                      changeQuestionType(
                        index,
                        (fieldValue($event) ?? entry.question.type) as EvaluationQuestionType
                      )
                    "
                  >
                    <option v-for="type in EVALUATION_QUESTION_TYPES" :key="type" :value="type">
                      {{ type }}
                    </option>
                  </select>
                </div>
                <div class="question-actions">
                  <button
                    type="button"
                    class="icon-button"
                    :disabled="index === 0"
                    :aria-label="`Move question ${index + 1} earlier`"
                    @click="moveQuestion(index, -1)"
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    class="icon-button"
                    :disabled="index === questions.length - 1"
                    :aria-label="`Move question ${index + 1} later`"
                    @click="moveQuestion(index, 1)"
                  >
                    Down
                  </button>
                  <button
                    type="button"
                    class="icon-button"
                    :disabled="questions.length === 1"
                    :aria-label="`Remove question ${index + 1}`"
                    @click="removeQuestion(index)"
                  >
                    Remove
                  </button>
                </div>
              </div>

              <div class="field">
                <label class="field-label" :for="`question-instructions-${index}`"
                  >Instructions</label
                >
                <textarea
                  :id="`question-instructions-${index}`"
                  :value="entry.question.instructions"
                  :aria-label="`Question ${index + 1} instructions`"
                  class="textarea"
                  rows="2"
                  placeholder="What is being judged?"
                  @input="setInstructions(index, fieldValue($event) ?? '')"
                ></textarea>
              </div>

              <!-- A truth-valued question: two optional criteria saying what each answer means. -->
              <template v-if="entry.question.type === 'noul'">
                <div class="field">
                  <label class="field-label" :for="`question-true-${index}`"
                    >What a true answer looks like (optional)</label
                  >
                  <input
                    :id="`question-true-${index}`"
                    :value="entry.question.whenTrue ?? ''"
                    :aria-label="`Question ${index + 1}, description of a true answer`"
                    class="input"
                    type="text"
                    @input="setCriterion(index, 'whenTrue', fieldValue($event) ?? '')"
                  />
                </div>
                <div class="field">
                  <label class="field-label" :for="`question-false-${index}`"
                    >What a false answer looks like (optional)</label
                  >
                  <input
                    :id="`question-false-${index}`"
                    :value="entry.question.whenFalse ?? ''"
                    :aria-label="`Question ${index + 1}, description of a false answer`"
                    class="input"
                    type="text"
                    @input="setCriterion(index, 'whenFalse', fieldValue($event) ?? '')"
                  />
                </div>
                <p class="hint">
                  Returns a probability, never a yes or no. This question type reports no separate
                  confidence.
                </p>
              </template>

              <!-- A selection: named options, each with a description the model reads. -->
              <template v-else-if="entry.question.type === 'choice'">
                <span class="field-label">Options</span>
                <div
                  v-for="(option, optionIndex) in entry.question.options"
                  :key="optionIndex"
                  class="option-row"
                >
                  <input
                    :value="option.name"
                    :aria-label="`Question ${index + 1}, option ${optionIndex + 1} name`"
                    class="input option-name"
                    type="text"
                    placeholder="NAME"
                    @input="setOption(index, optionIndex, 'name', fieldValue($event) ?? '')"
                  />
                  <input
                    :value="option.description"
                    :aria-label="`Question ${index + 1}, option ${optionIndex + 1} description`"
                    class="input"
                    type="text"
                    placeholder="What this option covers"
                    @input="setOption(index, optionIndex, 'description', fieldValue($event) ?? '')"
                  />
                  <button
                    type="button"
                    class="icon-button"
                    :disabled="entry.question.options.length <= MIN_EVALUATION_OPTIONS"
                    :aria-label="`Remove option ${optionIndex + 1} from question ${index + 1}`"
                    @click="removeOption(index, optionIndex)"
                  >
                    Remove
                  </button>
                </div>
                <button
                  type="button"
                  class="add"
                  :disabled="entry.question.options.length >= MAX_EVALUATION_OPTIONS"
                  @click="addOption(index)"
                >
                  Add option
                </button>
                <p class="hint">
                  Returns a probability for every option plus a separate confidence. At least
                  {{ MIN_EVALUATION_OPTIONS }} options are required.
                </p>
              </template>

              <!-- A graded rating: an ordered legend whose order is the meaning. -->
              <template v-else>
                <span class="field-label">Legend, lowest first</span>
                <div
                  v-for="(label, entryIndex) in entry.question.legend"
                  :key="entryIndex"
                  class="option-row"
                >
                  <input
                    :value="label"
                    :aria-label="`Question ${index + 1}, legend entry ${entryIndex + 1}`"
                    class="input"
                    type="text"
                    placeholder="Legend label"
                    @input="setLegendEntry(index, entryIndex, fieldValue($event) ?? '')"
                  />
                  <button
                    type="button"
                    class="icon-button"
                    :disabled="entry.question.legend.length <= MIN_EVALUATION_OPTIONS"
                    :aria-label="`Remove legend entry ${entryIndex + 1} from question ${index + 1}`"
                    @click="removeOption(index, entryIndex)"
                  >
                    Remove
                  </button>
                </div>
                <button
                  type="button"
                  class="add"
                  :disabled="entry.question.legend.length >= MAX_EVALUATION_OPTIONS"
                  @click="addOption(index)"
                >
                  Add legend entry
                </button>
                <p class="hint">
                  Returns a continuous score along this legend, a distribution across it, and a
                  separate confidence. The order is the meaning.
                </p>
              </template>
            </article>

            <div class="add-buttons">
              <button
                v-for="type in EVALUATION_QUESTION_TYPES"
                :key="type"
                type="button"
                class="add"
                :disabled="!canAddQuestion"
                @click="addQuestion(type)"
              >
                Add {{ type }} question
              </button>
            </div>
            <p class="hint">{{ questions.length }} of {{ MAX_EVALUATION_QUESTIONS }} questions.</p>

            <div class="actions">
              <v-btn
                class="evaluate-button"
                color="primary"
                :disabled="!canEvaluate"
                variant="flat"
                @click="run"
              >
                Evaluate
              </v-btn>
              <v-btn v-if="evaluating" class="cancel-button" variant="outlined" @click="cancel">
                Stop waiting
              </v-btn>
            </div>
            <p v-if="blockedReason" class="blocked" role="status">{{ blockedReason }}</p>
            <p class="status" role="status">
              <template v-if="evaluating"
                >Evaluating. Stopping will not cancel a model request already sent.</template
              >
              <template v-else-if="result">Answers ready.</template>
            </p>

            <!--
              The strongest evidence for the panel's central claim, so it is part of the form
              rather than hidden in a result. Nothing in here is a prompt.
            -->
            <details class="preview">
              <summary>Request preview</summary>
              <p class="hint">
                Exactly what this panel posts. Typed questions and nothing else &mdash; no prompt,
                no system message, no instruction to return JSON.
              </p>
              <pre class="preview-json">{{ requestPreview }}</pre>
            </details>
          </section>

          <ModelSettingsPanel :model-name="selectedModel?.name" :model-id="selectedModel?.id">
            <div class="field">
              <label class="field-label" for="evaluation-model">Model</label>
              <select id="evaluation-model" v-model="model" class="select">
                <option v-for="candidate in models" :key="candidate.id" :value="candidate.id">
                  {{ candidate.name }}
                </option>
              </select>
            </div>
            <p v-if="controls" class="settings-note">
              Answers {{ controls.supportedQuestionTypes.join(', ') }} questions.
              {{ controls.contextWindowTokens.toLocaleString() }}-token context window. Priced at
              ${{ controls.inputPricePerMillionTokens }} per million input tokens, with
              <strong>no output charge</strong> &mdash; a typed decision is not generated text, so
              there is nothing to bill for on the way out. Run the same questions against both
              models to compare cost and confidence.
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

            <p v-if="applied" class="result-note">
              {{ applied.questionCount }}
              {{ applied.questionCount === 1 ? 'question' : 'questions' }} answered from a
              {{ applied.stateFormat === 'json' ? 'structured JSON' : 'plain text' }} state in one
              model call.
            </p>

            <div v-if="result" class="answer-grid">
              <EvaluationAnswerCard
                v-for="entry in result.answers"
                :key="entry.name"
                :name="entry.name"
                :instructions="resultInstructions.get(entry.name) ?? ''"
                :answer="entry.answer"
              />
            </div>

            <!--
              A real outcome rather than a failure: the model answered, but one answer could not
              be read against the type it was asked for. Named, because a shorter card list with
              no comment is indistinguishable from never having asked.
            -->
            <p v-if="result && result.unansweredQuestions.length > 0" class="blocked" role="status">
              No usable answer came back for
              {{ result.unansweredQuestions.join(', ') }}. The other answers are unaffected.
            </p>

            <p v-if="usageSentence" class="cost-note" role="status">{{ usageSentence }}</p>

            <details v-if="result" class="structured">
              <summary>Typed response</summary>
              <p class="hint">
                The model&rsquo;s own structured answer. Nothing was parsed out of prose to produce
                the cards above.
              </p>
              <pre class="preview-json">{{ structuredResponse }}</pre>
            </details>
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
.evaluate-choices,
.composer,
.result {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

.evaluate-choices {
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
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: space-between;
}

.call-count {
  background-color: rgb(var(--v-theme-surface-variant));
  border-radius: 999px;
  font-size: 0.75rem;
  padding: 0.15rem 0.6rem;
}

.field,
.examples {
  min-width: 0;
}

.field-label {
  color: rgb(var(--v-theme-on-surface-variant));
  display: block;
  font-size: 0.8125rem;
  margin-bottom: 0.25rem;
}

.input,
.select,
.textarea {
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

.state-text {
  font-family: ui-monospace, monospace;
  font-size: 0.8125rem;
}

.format {
  border: none;
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin: 0;
  padding: 0;
}

.radio {
  align-items: center;
  cursor: pointer;
  display: flex;
  gap: 0.35rem;
  font-size: 0.875rem;
  min-height: 2.25rem;
}

.question-editor {
  border: 1px solid rgb(var(--v-theme-outline-variant));
  border-radius: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-width: 0;
  padding: 0.9rem;
}

.question-head {
  align-items: flex-end;
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
}

.name-field {
  flex: 1 1 10rem;
}

.type-field {
  flex: 0 1 8rem;
}

.question-actions,
.add-buttons,
.example-buttons,
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.actions {
  gap: 0.75rem;
}

.option-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.option-row .input {
  flex: 1 1 10rem;
  width: auto;
}

.option-name {
  flex: 0 1 9rem;
  font-family: ui-monospace, monospace;
  font-size: 0.8125rem;
}

.icon-button,
.add,
.example {
  background: transparent;
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.375rem;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-size: 0.875rem;
  min-height: 2.25rem;
  padding: 0.25rem 0.75rem;
}

.example {
  border-radius: 999px;
}

.icon-button:disabled,
.add:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.icon-button:focus-visible,
.add:focus-visible,
.example:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.answer-grid {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.status,
.settings-note,
.hint,
.blocked,
.result-note,
.cost-note {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0;
}

.settings-note,
.hint,
.blocked,
.result-note,
.cost-note {
  font-size: 0.875rem;
}

.cost-note {
  border-left: 3px solid rgb(var(--v-theme-primary));
  padding-left: 0.75rem;
}

.error {
  color: rgb(var(--v-theme-error));
  margin: 0;
}

.preview,
.structured {
  border-top: 1px solid rgb(var(--v-theme-outline-variant));
  padding-top: 0.5rem;
}

.preview summary,
.structured summary {
  cursor: pointer;
  font-size: 0.875rem;
  min-height: 2.25rem;
  padding: 0.4rem 0;
}

.preview-json {
  background-color: rgb(var(--v-theme-surface-variant));
  border-radius: 0.375rem;
  font-family: ui-monospace, monospace;
  font-size: 0.8125rem;
  margin: 0.5rem 0 0;
  max-height: 22rem;
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
  .question-head,
  .option-row {
    flex-direction: column;
    align-items: stretch;
  }

  .option-row .input,
  .option-name {
    flex: 1 1 auto;
  }
}
</style>
