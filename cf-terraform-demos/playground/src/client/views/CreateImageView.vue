<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { MAX_NEGATIVE_PROMPT_CHARACTERS, MAX_PROMPT_CHARACTERS } from '../../shared/images';
import { findTask } from '../../shared/tasks';
import InfoButton from '../components/InfoButton.vue';
import InfoDialog from '../components/InfoDialog.vue';
import ModelSettingsPanel from '../components/ModelSettingsPanel.vue';
import PanelPage from '../components/PanelPage.vue';
import PanelWorkspace from '../components/PanelWorkspace.vue';
import RunDetails from '../components/runs/RunDetails.vue';
import { IMAGE_EXAMPLES, type ImageExample } from '../features/create-image/examples';
import ImageGallery from '../features/create-image/ImageGallery.vue';
import { useCreateImage } from '../features/create-image/useCreateImage';
import { useCatalogueStore } from '../stores/catalogue';
import { useHandoffStore } from '../stores/handoff';

const task = computed(() => findTask('create-image'));
const catalogue = useCatalogueStore();
const handoff = useHandoffStore();
const router = useRouter();

/**
 * Reviewed models for this panel, as the server reported them.
 *
 * Read from the catalogue endpoint rather than hard-coded, because the server decides which models
 * it will accept and which controls each one allows. A browser-side list could offer a model, or a
 * control, that the API then rejects.
 */
const models = computed(() => catalogue.modelsForTask('create-image'));

const {
  prompt,
  negativePrompt,
  model,
  width,
  height,
  steps,
  guidance,
  seed,
  selectedModel,
  generating,
  error,
  gallery,
  receipt,
  metrics,
  costPending,
  canGenerate,
  generate,
  cancel
} = useCreateImage({ models });

/**
 * Whether the run-details modal is showing.
 *
 * The run details were the fourth of five stacked blocks, which put a run's reported cost — one of
 * the things this demo exists to show — a long scroll away from the image it described. As an info
 * button on the results heading it is one click from the output instead.
 */
const showRunDetails = ref(false);

/**
 * Whether the output column has anything to show.
 *
 * @returns `true` once at least one image has been generated.
 */
const hasOutput = computed(() => gallery.value.length > 0);

/**
 * The selected model's declared controls, or `undefined` before the catalogue loads.
 *
 * The template renders each control only when this says the model has it, which is why selecting
 * FLUX.1 makes the negative prompt, dimensions, guidance, and seed disappear rather than appear
 * disabled. A disabled control invites the question "why can't I use this?"; an absent one answers
 * it, and the note beneath the selector says which model to pick instead.
 */
const controls = computed(() => selectedModel.value?.imageControls);

/**
 * A sentence naming the controls the selected model offers.
 *
 * Built here rather than with template conditionals, which produced "offers and 1–8 steps" for a
 * model with only one control. Assembling a list and joining it is the difference between prose
 * that reads and prose that betrays its own implementation.
 *
 * @returns The sentence, or an empty string before a model has been selected.
 */
const capabilitySentence = computed(() => {
  const support = controls.value;
  if (support === undefined || selectedModel.value === undefined) {
    return '';
  }

  const offered: string[] = [];
  if (support.negativePrompt) {
    offered.push('a negative prompt');
  }
  if (support.dimensions !== undefined) {
    offered.push('custom dimensions');
  }
  if (support.guidance !== undefined) {
    offered.push('guidance');
  }
  if (support.seed) {
    offered.push('a seed');
  }
  if (support.steps !== undefined) {
    offered.push(`${support.steps.min}–${support.steps.max} steps`);
  }

  if (offered.length === 0) {
    return `${selectedModel.value.name} takes a prompt and nothing else.`;
  }

  const last = offered.at(-1);
  const list =
    offered.length === 1 ? last : `${offered.slice(0, -1).join(', ')} and ${String(last)}`;

  return `${selectedModel.value.name} offers ${String(list)}.`;
});

onMounted(() => void catalogue.load());

/**
 * Loads a prepared example into the prompt editor.
 *
 * @param example Example to load.
 * @returns Nothing; the prompt is replaced. It is not generated automatically — a prepared prompt
 *   that spent money the moment it was clicked would be a trap in a panel that bills per image.
 */
function loadExample(example: ImageExample): void {
  prompt.value = example.prompt;
}

/**
 * Sends a server-sniffed generated image to Remix Image without placing bytes in a route query.
 *
 * @param entry Result selected for transformation.
 * @returns A promise fulfilled after navigation begins.
 */
async function remixGeneratedImage(entry: (typeof gallery.value)[number]): Promise<void> {
  handoff.offer({
    base64: entry.image.base64,
    mediaType: entry.image.mediaType,
    byteLength: entry.image.byteLength,
    origin: 'Generated in Create Image'
  });
  await router.push('/remix-image');
}
</script>

<template>
  <PanelPage v-if="task" :task="task">
    <!--
      The credit-and-logging disclosure, now reached through the header's info button rather than
      printed above the controls. Image models bill per image or per step, which is materially more
      per click than a short chat answer, so the warning is worth making concrete.

      It deliberately makes no promise about what the gateway retains. This demo asks AI Gateway
      not to store payloads, but a retention guarantee is the platform's to give, not this
      application's — so the panel tells a visitor to assume their prompt is logged rather than
      asserting something it cannot verify on the visitor's behalf.
    -->
    <template #description>
      <p class="attribution" role="note">
        This panel calls a real model and spends real inference credit — an image costs noticeably
        more per request than a short chat answer. Your verified email is recorded in the AI Gateway
        log for each request so spending can be attributed. Assume your prompt is logged too: treat
        this as you would any shared AI service and do not enter anything confidential.
      </p>
    </template>

    <div class="create-image">
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <PanelWorkspace :has-output="hasOutput">
        <template #input>
          <section class="composer" aria-labelledby="composer-heading">
            <h2 id="composer-heading" class="section-heading">Describe the image</h2>

            <div class="prompt-field">
              <label class="field-label" for="image-prompt">Prompt</label>
              <textarea
                id="image-prompt"
                v-model="prompt"
                class="text-input"
                rows="3"
                :maxlength="MAX_PROMPT_CHARACTERS"
                placeholder="A lighthouse in a storm, in the style of a 1930s travel poster"
              ></textarea>
              <!--
                Not a live region: announcing "1 of 2,048", "2 of 2,048" on every keystroke masks
                the useful status messages below. The visible counter is still associated by
                proximity, and the input's `maxlength` enforces the limit.
              -->
              <span class="counter">
                {{ [...prompt].length.toLocaleString() }} /
                {{ MAX_PROMPT_CHARACTERS.toLocaleString() }}
              </span>
            </div>

            <!--
              Examples belong to the prompt editor rather than to the run controls, so they sit
              immediately below the box they replace and before the Generate button that acts on
              the chosen text.
            -->
            <div class="example-group" role="group" aria-labelledby="examples-heading">
              <h3 id="examples-heading" class="field-label">Or try an example</h3>
              <div class="examples">
                <button
                  v-for="example in IMAGE_EXAMPLES"
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

            <div class="actions">
              <v-btn
                class="generate-button"
                color="primary"
                :disabled="!canGenerate"
                variant="flat"
                @click="generate"
              >
                Generate
              </v-btn>
              <!--
                Rendered only while generating, so the control a visitor needs mid-run is the one
                in that position.
              -->
              <v-btn v-if="generating" class="cancel-button" variant="outlined" @click="cancel">
                Stop waiting
              </v-btn>
            </div>

            <!--
              Persistent rather than inserted only while running. The text changes from the start
              phrase to the completion phrase, which assistive technology announces reliably;
              inserting an image or a pre-populated live region after the fact is inconsistent
              across screen readers.
            -->
            <p class="status" role="status">
              <template v-if="generating">Generating. This usually takes a few seconds.</template>
              <template v-else-if="receipt">Image generated.</template>
            </p>
          </section>

          <!--
            Below the input and collapsed, because a visitor picks a model once and then runs
            several prompts against it. The summary keeps the selected model's name visible, which
            matters more here than in most panels: the two reviewed models differ by four controls,
            so which one is selected explains the shape of the form.
          -->
          <ModelSettingsPanel :model-name="selectedModel?.name">
            <div class="field">
              <label class="field-label" for="image-model">Model</label>
              <select id="image-model" v-model="model" class="select">
                <option v-for="candidate in models" :key="candidate.id" :value="candidate.id">
                  {{ candidate.name }}
                </option>
              </select>
            </div>

            <!--
              The honest explanation for why this form changes shape. Without it, a visitor who
              selects FLUX.1 and loses four controls would reasonably think the page had broken.
            -->
            <p class="settings-note">
              Each model declares its own controls, so this form changes with your selection.
              <span v-if="capabilitySentence">{{ capabilitySentence }}</span>
            </p>

            <div v-if="controls?.negativePrompt" class="field">
              <label class="field-label" for="image-negative">
                Negative prompt (what to avoid)
              </label>
              <textarea
                id="image-negative"
                v-model="negativePrompt"
                class="text-input"
                rows="2"
                :maxlength="MAX_NEGATIVE_PROMPT_CHARACTERS"
                placeholder="people, cars, text"
              ></textarea>
            </div>

            <div v-if="controls?.steps" class="field">
              <label class="field-label" for="image-steps">
                Steps ({{ steps ?? `model default: ${controls.steps.default}` }})
              </label>
              <input
                id="image-steps"
                v-model.number="steps"
                class="range"
                type="range"
                :min="controls.steps.min"
                :max="controls.steps.max"
                :step="controls.steps.step"
              />
              <p class="hint">
                More steps can improve detail and take longer. This model bills per step, so it also
                costs more — compare the figures in the run details beside the results.
              </p>
            </div>

            <div v-if="controls?.dimensions" class="dimensions">
              <div class="field">
                <label class="field-label" for="image-width">
                  Width ({{ width ?? controls.dimensions.default }})
                </label>
                <input
                  id="image-width"
                  v-model.number="width"
                  class="range"
                  type="range"
                  :min="controls.dimensions.min"
                  :max="controls.dimensions.max"
                  :step="controls.dimensions.step"
                />
              </div>
              <div class="field">
                <label class="field-label" for="image-height">
                  Height ({{ height ?? controls.dimensions.default }})
                </label>
                <input
                  id="image-height"
                  v-model.number="height"
                  class="range"
                  type="range"
                  :min="controls.dimensions.min"
                  :max="controls.dimensions.max"
                  :step="controls.dimensions.step"
                />
              </div>
            </div>

            <div v-if="controls?.guidance" class="field">
              <label class="field-label" for="image-guidance">
                Guidance ({{ guidance ?? controls.guidance.default }})
              </label>
              <input
                id="image-guidance"
                v-model.number="guidance"
                class="range"
                type="range"
                :min="controls.guidance.min"
                :max="controls.guidance.max"
                :step="controls.guidance.step"
              />
              <p class="hint">
                How closely to follow the prompt. Very high values tend to look harsh.
              </p>
            </div>

            <div v-if="controls?.seed" class="field">
              <label class="field-label" for="image-seed">Seed (optional)</label>
              <input
                id="image-seed"
                v-model.number="seed"
                class="number-input"
                type="number"
                min="0"
                placeholder="Leave empty for a random seed"
              />
              <p class="hint">
                Reusing a seed with the same prompt and settings reproduces the same image.
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
          <div class="output">
            <div class="output-header">
              <h2 class="section-heading">Run output</h2>
              <!--
                The run details move here from the bottom of the page, beside the images they
                describe. The receipt is for the most recent run, which is why the button is
                labelled as such rather than implying it covers the whole gallery.
              -->
              <InfoButton
                v-if="receipt"
                class="run-details-button"
                label="Run details for the most recent image, including reported cost"
                @activate="showRunDetails = true"
              />
            </div>

            <ImageGallery :entries="gallery" @remix="remixGeneratedImage" />
          </div>
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
.create-image {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  min-width: 0;
}

.composer,
.output {
  min-width: 0;
}

.composer {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.section-heading {
  font-size: 1.125rem;
  margin: 0;
}

.attribution {
  margin: 1rem 0 0;
}

.output {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.output-header {
  align-items: center;
  display: flex;
  gap: 0.5rem;
}

/*
  `max-width` caps the field on a wide screen; `width: 100%` with `min-width: 0` lets it shrink
  below that cap on a narrow one. Without the `min-width` override a flex child refuses to shrink
  past its content's intrinsic width, which pushed the whole panel wider than a phone viewport.
*/
.field {
  margin-bottom: 1rem;
  max-width: 28rem;
  min-width: 0;
  width: 100%;
}

.prompt-field {
  min-width: 0;
  width: 100%;
}

.field-label {
  color: rgb(var(--v-theme-on-surface-variant));
  display: block;
  font-size: 0.8125rem;
  margin-bottom: 0.25rem;
}

/*
  `box-sizing: border-box` so the 12px padding counts inside the declared width rather than being
  added to it — without it a `width: 100%` input is always wider than its container.
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

.select,
.number-input {
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

.dimensions {
  display: flex;
  flex-wrap: wrap;
  gap: 1.5rem;
  max-width: 28rem;
}

/*
  `flex-basis: 10rem` rather than `12rem`: two 12rem fields plus the gap exceed a 390px viewport, so
  they neither fitted side by side nor wrapped, and stretched the panel instead. At 10rem they wrap
  cleanly on a phone and still sit side by side from a tablet upwards.
*/
.dimensions .field {
  flex: 1 1 10rem;
  margin-bottom: 0;
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

.docs-link {
  margin: 0.5rem 0 0;
}
</style>
