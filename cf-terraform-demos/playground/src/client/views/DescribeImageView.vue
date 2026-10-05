<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { MAX_INSTRUCTION_CHARACTERS } from '../../shared/describe-image';
import { findTask } from '../../shared/tasks';
import InfoButton from '../components/InfoButton.vue';
import InfoDialog from '../components/InfoDialog.vue';
import { formatBytes } from '../components/media/image-input';
import SourceImagePicker from '../components/media/SourceImagePicker.vue';
import ModelSettingsPanel from '../components/ModelSettingsPanel.vue';
import PanelPage from '../components/PanelPage.vue';
import PanelWorkspace from '../components/PanelWorkspace.vue';
import RunDetails from '../components/runs/RunDetails.vue';
import { VISION_EXAMPLES, type VisionExample } from '../features/describe-image/examples';
import { useDescribeImage } from '../features/describe-image/useDescribeImage';
import { useCatalogueStore } from '../stores/catalogue';
import { useHandoffStore } from '../stores/handoff';

const task = computed(() => findTask('describe-image'));
const catalogue = useCatalogueStore();
const handoff = useHandoffStore();

/**
 * Reviewed models for this panel, as the server reported them.
 */
const models = computed(() => catalogue.modelsForTask('describe-image'));

const {
  image,
  instruction,
  model,
  maxTokens,
  selectedModel,
  instructionRequired,
  describing,
  error,
  description,
  verified,
  receipt,
  metrics,
  costPending,
  canDescribe,
  selectFile,
  acceptHandoff,
  clearImage,
  describe,
  cancel
} = useDescribeImage({ models });

/**
 * Whether the run-details modal is showing.
 *
 * The run details were the fifth and last block on the page, which meant the cost of a run — one of
 * the things this demo exists to show — was the item furthest from the visitor's attention.
 * Attached to the output heading as an info button, it is one click from the answer it describes.
 */
const showRunDetails = ref(false);

/**
 * The selected model's declared controls, or `undefined` before the catalogue loads.
 */
const controls = computed(() => selectedModel.value?.visionControls);

/**
 * Whether the output column has anything to show.
 *
 * True as soon as a picture is chosen, not merely once an answer arrives. The preview is worth a
 * column of its own: seeing the picture beside the question is what makes the question easy to
 * write, and switching the layout only on completion would move the input mid-run.
 *
 * @returns `true` when a picture has been chosen or an answer exists.
 */
const hasOutput = computed(() => image.value !== undefined || description.value !== undefined);

/**
 * A sentence describing how the selected model expects to be used.
 *
 * The difference it reports is not a detail: one model answers a question about a picture and the
 * other will also caption one unasked. A visitor who switches models and finds the Describe button
 * disabled deserves to be told why in the same place they made the change.
 *
 * @returns The sentence, or an empty string before a model has been selected.
 */
const capabilitySentence = computed(() => {
  const support = controls.value;
  if (support === undefined || selectedModel.value === undefined) {
    return '';
  }

  const name = selectedModel.value.name;
  const question = support.instructionRequired
    ? `${name} requires a question about the picture.`
    : `${name} will caption a picture on its own, so the question is optional.`;

  if (support.maxTokens === undefined) {
    return question;
  }

  return `${question} Answers are capped at ${support.maxTokens.default} tokens by default.`;
});

/**
 * Whether the server's view of the picture differs from the browser's.
 *
 * Surfaced rather than hidden. A file named `.png` whose bytes are JPEG is common and harmless, but
 * it is also the exact shape of a more interesting problem, and the panel's claim that it trusts
 * bytes over declarations is only meaningful if a visitor can see it happen.
 *
 * @returns `true` when the sniffed size differs from what the browser read.
 */
const sizeDiffers = computed(
  () =>
    verified.value !== undefined
    && image.value !== undefined
    && verified.value.byteLength !== image.value.byteLength
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
 * Loads a prepared question into the editor.
 *
 * @param example Example to load.
 * @returns Nothing; the question is replaced. It is not submitted automatically — a prepared
 *   question that spent credit the moment it was clicked would be a trap.
 */
function loadExample(example: VisionExample): void {
  instruction.value = example.instruction;
}
</script>

<template>
  <PanelPage v-if="task" :task="task">
    <!--
      The credit-and-logging disclosure, now reached through the header's info button rather than
      printed above the controls. This panel has an extra thing to disclose that the others do
      not: the visitor is uploading a picture, which may contain faces, documents, or location
      data they have not thought about. It stays in the panel's own description slot so it is one
      click from the panel at all times, and `tests/client/privacy-claims.test.ts` holds every
      inference panel to carrying it.
    -->
    <template #description>
      <p class="attribution" role="note">
        This panel calls a real model and spends real inference credit. Your verified email is
        recorded in the AI Gateway log for each request so spending can be attributed. Assume your
        picture and question are logged too: treat this as you would any shared AI service and do
        not upload anything confidential.
      </p>
    </template>

    <div class="describe-image">
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <PanelWorkspace :has-output="hasOutput">
        <template #input>
          <section class="composer" aria-labelledby="composer-heading">
            <h2 id="composer-heading" class="section-heading">Ask about a picture</h2>

            <SourceImagePicker
              label="Picture to describe"
              :image="image"
              :busy="describing"
              @selected="selectFile"
              @cleared="clearImage"
            />

            <div class="question-field">
              <label class="field-label" for="vision-instruction">
                Question
                <span v-if="instructionRequired" class="required-marker">
                  (required for this model)
                </span>
                <span v-else class="optional-marker">(optional for this model)</span>
              </label>
              <textarea
                id="vision-instruction"
                v-model="instruction"
                class="text-input"
                rows="3"
                :maxlength="MAX_INSTRUCTION_CHARACTERS"
                :required="instructionRequired"
                placeholder="What is in this picture?"
              ></textarea>
              <!--
                Not a live region: announcing the count on every keystroke masks the useful run
                status below. The visible counter remains directly after the field, and
                `maxlength` enforces the limit.
              -->
              <span class="counter">
                {{ [...instruction].length.toLocaleString() }} /
                {{ MAX_INSTRUCTION_CHARACTERS.toLocaleString() }}
              </span>
            </div>

            <div class="actions">
              <v-btn
                class="describe-button"
                color="primary"
                :disabled="!canDescribe"
                variant="flat"
                @click="describe"
              >
                Describe
              </v-btn>
              <v-btn v-if="describing" class="cancel-button" variant="outlined" @click="cancel">
                Stop waiting
              </v-btn>
            </div>

            <!--
              Says which precondition is unmet rather than leaving a disabled button unexplained.
              The two reasons are genuinely different: one is "choose a picture" and the other is
              "this model needs a question", and conflating them would make a model switch look
              broken.
            -->
            <p v-if="image === undefined" class="hint">Choose a picture to describe.</p>
            <p v-else-if="instructionRequired && instruction.trim() === ''" class="hint">
              {{ selectedModel?.name }} needs a question before it can answer.
            </p>

            <!--
              Persistent so the text *changes* from the start phrase to the completion phrase.
              Screen readers announce that more reliably than a live region inserted already
              populated after the answer arrives.
            -->
            <p class="status" role="status">
              <template v-if="describing">Describing. This usually takes a few seconds.</template>
              <template v-else-if="description">Description ready.</template>
            </p>

            <div class="example-group" role="group" aria-labelledby="examples-heading">
              <h3 id="examples-heading" class="field-label">Or try a question</h3>
              <div class="examples">
                <button
                  v-for="example in VISION_EXAMPLES"
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

          <!--
            Below the input and collapsed, because a visitor picks a model once and then runs
            several questions against it. The summary keeps the selected model's name visible, so
            the one fact the expanded form was being kept open for is readable while it is closed.
          -->
          <ModelSettingsPanel :model-name="selectedModel?.name" :model-id="selectedModel?.id">
            <div class="field">
              <label class="field-label" for="vision-model">Model</label>
              <select id="vision-model" v-model="model" class="select">
                <option v-for="candidate in models" :key="candidate.id" :value="candidate.id">
                  {{ candidate.name }}
                </option>
              </select>
            </div>

            <p class="settings-note">
              Each model declares its own contract, so this form changes with your selection.
              <span v-if="capabilitySentence">{{ capabilitySentence }}</span>
            </p>

            <div v-if="controls?.maxTokens" class="field">
              <label class="field-label" for="vision-max-tokens">
                Answer length ({{ maxTokens ?? `model default: ${controls.maxTokens.default}` }}
                tokens)
              </label>
              <input
                id="vision-max-tokens"
                v-model.number="maxTokens"
                class="range"
                type="range"
                :min="controls.maxTokens.min"
                :max="controls.maxTokens.max"
                :step="controls.maxTokens.step"
              />
              <p class="hint">
                A longer answer costs more, because these models bill per token. Compare the figures
                in the run details beside the answer.
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
          <section class="answer" aria-labelledby="answer-heading">
            <div class="answer-header">
              <h2 id="answer-heading" class="section-heading">Run output</h2>
              <!--
                The run details move here from the bottom of the page. A run's cost is one of the
                things this demo exists to show, and it was previously the item furthest from the
                answer it belonged to.
              -->
              <InfoButton
                v-if="receipt"
                class="run-details-button"
                label="Run details, including reported cost"
                @activate="showRunDetails = true"
              />
            </div>

            <p v-if="!description && !describing" class="awaiting">
              Your description will appear here.
            </p>

            <!--
              The persistent status beside the input announces that the description is ready. The
              answer itself is ordinary text rather than another live region, so a long model
              response is not read over the shorter completion announcement.
            -->
            <p v-if="description" class="description-text">{{ description }}</p>

            <!--
              What the server established about the picture, as opposed to what the browser
              believed. Shown because this panel's central claim is that it trusts bytes rather
              than declarations, and a claim nobody can observe is just a comment in the source.
            -->
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
            </dl>
            <p v-if="sizeDiffers" class="fact-note">
              The server measured this picture itself rather than trusting what your browser
              reported.
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
.describe-image {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  min-width: 0;
}

.composer,
.answer {
  min-width: 0;
}

.section-heading {
  font-size: 1.125rem;
  margin: 0;
}

.attribution {
  margin: 1rem 0 0;
}

.composer {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.answer-header {
  align-items: center;
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.awaiting {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0;
}

.question-field,
.field {
  min-width: 0;
  width: 100%;
}

.field {
  margin-bottom: 1rem;
  max-width: 28rem;
}

.field-label {
  color: rgb(var(--v-theme-on-surface-variant));
  display: block;
  font-size: 0.8125rem;
  margin-bottom: 0.25rem;
}

.required-marker,
.optional-marker {
  font-style: italic;
}

/*
  `box-sizing: border-box` so the padding counts inside the declared width rather than being added
  to it — without it a `width: 100%` input is always wider than its container.
*/
.text-input {
  background-color: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.5rem;
  box-sizing: border-box;
  color: rgb(var(--v-theme-on-surface));
  font-size: 0.9375rem;
  padding: 0.75rem;
  resize: vertical;
  width: 100%;
}

.text-input:focus-visible {
  border-color: rgb(var(--v-theme-primary));
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 1px;
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

.counter {
  color: rgb(var(--v-theme-on-surface-variant));
  display: block;
  font-size: 0.8125rem;
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

.settings-note {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin: 0 0 1rem;
}

.description-text {
  background-color: rgb(var(--v-theme-surface-variant));
  border-radius: 0.5rem;
  margin: 0;
  padding: 1rem;
  white-space: pre-wrap;
}

.verified-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 1.5rem;
  margin: 0.75rem 0 0;
}

.fact dt {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
}

.fact dd {
  margin: 0;
}

.fact-note {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
  margin: 0.5rem 0 0;
}

.hint {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
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
