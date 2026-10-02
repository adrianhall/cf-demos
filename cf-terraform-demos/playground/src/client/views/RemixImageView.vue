<script setup lang="ts">
/**
 * Route composition for the phase-six Remix Image activity-first panel.
 */
import { computed, onMounted, ref } from 'vue';
import { IMAGE_FILE_EXTENSIONS } from '../../images';
import { MAX_REMIX_INSTRUCTION_CHARACTERS } from '../../remix-image';
import { findTask } from '../../tasks';
import InfoButton from '../components/InfoButton.vue';
import InfoDialog from '../components/InfoDialog.vue';
import ModelSettingsPanel from '../components/ModelSettingsPanel.vue';
import PanelPage from '../components/PanelPage.vue';
import PanelWorkspace from '../components/PanelWorkspace.vue';
import RunDetails from '../components/runs/RunDetails.vue';
import BeforeAfterComparison from '../features/remix-image/BeforeAfterComparison.vue';
import { REMIX_EXAMPLES, type RemixExample } from '../features/remix-image/examples';
import RemixImagePicker from '../features/remix-image/RemixImagePicker.vue';
import { useRemixImage } from '../features/remix-image/useRemixImage';
import { useCatalogueStore } from '../stores/catalogue';
import { useHandoffStore } from '../stores/handoff';

const task = computed(() => findTask('remix-image'));
const catalogue = useCatalogueStore();
const handoff = useHandoffStore();
const models = computed(() => catalogue.modelsForTask('remix-image'));
const showRunDetails = ref(false);
const {
  source,
  instruction,
  model,
  seed,
  selectedModel,
  remixing,
  error,
  result,
  receipt,
  metrics,
  costPending,
  canRemix,
  selectSource,
  acceptHandoff,
  clearSource,
  remix,
  cancel
} = useRemixImage({ models });
const controls = computed(() => selectedModel.value?.remixImageControls);
const hasOutput = computed(() => source.value !== undefined || result.value !== undefined);
const downloadFileName = computed(() => {
  if (receipt.value === undefined || result.value === undefined) return 'playground-remix.png';
  return `playground-${receipt.value.runId}.${IMAGE_FILE_EXTENSIONS[result.value.mediaType]}`;
});

onMounted(() => {
  void catalogue.load();
  const pending = handoff.take();
  if (pending !== undefined) acceptHandoff(pending);
});

/**
 * Loads a preservation-aware example without starting a paid run.
 */
function loadExample(example: RemixExample): void {
  instruction.value = example.instruction;
}
</script>

<template>
  <PanelPage v-if="task" :task="task">
    <template #description>
      <p class="attribution" role="note">
        This panel calls a real model and spends real inference credit. Your verified email is
        recorded in the AI Gateway log for each request so spending can be attributed. Assume your
        source picture, instruction, and result are logged too: do not upload anything confidential.
      </p>
    </template>
    <div class="remix-image">
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <PanelWorkspace :has-output="hasOutput">
        <template #input>
          <section class="composer" aria-labelledby="remix-input-heading">
            <h2 id="remix-input-heading" class="heading">Transform a picture</h2>
            <RemixImagePicker
              label="Source image"
              :image="source"
              :busy="remixing"
              @selected="selectSource"
              @cleared="clearSource"
            />
            <div class="field">
              <label class="field-label" for="remix-instruction">Transformation instruction</label>
              <textarea
                id="remix-instruction"
                v-model="instruction"
                class="text-input"
                rows="3"
                :maxlength="MAX_REMIX_INSTRUCTION_CHARACTERS"
                placeholder="Restyle the provided image while preserving its major subjects and composition"
              ></textarea>
              <span class="counter"
                >{{ [...instruction].length.toLocaleString() }} /
                {{ MAX_REMIX_INSTRUCTION_CHARACTERS.toLocaleString() }}</span
              >
            </div>
            <div class="examples" role="group" aria-label="Example transformation instructions">
              <button
                v-for="example in REMIX_EXAMPLES"
                :key="example.id"
                type="button"
                :data-example="example.id"
                :title="example.teaches"
                @click="loadExample(example)"
              >
                {{ example.label }}
              </button>
            </div>
            <div class="actions">
              <v-btn
                class="remix-button"
                color="primary"
                variant="flat"
                :disabled="!canRemix"
                @click="remix"
                >Remix</v-btn
              >
              <v-btn v-if="remixing" class="cancel-button" variant="outlined" @click="cancel"
                >Stop waiting</v-btn
              >
            </div>
            <p v-if="source === undefined" class="hint">Choose a source image to remix.</p>
            <p v-else-if="instruction.trim() === ''" class="hint">
              Describe how you want to transform the source.
            </p>
            <p class="status" role="status">
              <template v-if="remixing">Remixing. This usually takes a few seconds.</template
              ><template v-else-if="receipt">Remixed image ready.</template>
            </p>
          </section>
          <ModelSettingsPanel :model-name="selectedModel?.name">
            <div class="field">
              <label class="field-label" for="remix-model">Model</label
              ><select id="remix-model" v-model="model" class="select">
                <option v-for="candidate in models" :key="candidate.id" :value="candidate.id">
                  {{ candidate.name }}
                </option>
              </select>
            </div>
            <p class="settings-note">
              Controls appear only when the selected model explicitly supports them.
              <span v-if="controls?.maxInputEdge">
                This model receives a {{ controls.maxInputEdge }}px reference copy; the original
                remains in the comparison. The Cloudflare-hosted FLUX.2 family's required multipart
                stream cannot pass through AI Gateway, so this is a documented direct Workers AI
                exception and Gateway cost is unavailable.
              </span>
              <span v-if="selectedModel?.provider === 'third-party'">
                This model requires prepaid AI Gateway credits.
              </span>
            </p>
            <div v-if="controls?.seed" class="field">
              <label class="field-label" for="remix-seed">Seed (optional)</label
              ><input
                id="remix-seed"
                v-model.number="seed"
                class="number-input"
                type="number"
                min="0"
                placeholder="Leave empty for a random seed"
              />
            </div>
            <p v-if="selectedModel" class="docs-link">
              <a :href="selectedModel.documentationUrl" rel="noreferrer" target="_blank"
                >{{ selectedModel.name }} in the model catalog</a
              >
            </p>
          </ModelSettingsPanel>
        </template>
        <template #output>
          <section class="output" aria-labelledby="remix-output-heading">
            <div class="output-header">
              <h2 id="remix-output-heading" class="heading">Run output</h2>
              <InfoButton
                v-if="receipt"
                class="run-details-button"
                label="Run details, including reported cost"
                @activate="showRunDetails = true"
              />
            </div>
            <p v-if="source === undefined" class="awaiting">Choose a source image to begin.</p>
            <BeforeAfterComparison
              v-else-if="result"
              :source="source"
              :result="result"
              :file-name="downloadFileName"
            />
            <div v-else class="source-preview">
              <img :src="source.previewUri" alt="Source image awaiting transformation" />
              <p>Your remixed result will appear beside this source image.</p>
            </div>
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
.remix-image {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  min-width: 0;
}
.composer,
.output {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}
.heading {
  font-size: 1.125rem;
  margin: 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.field-label {
  font-weight: 600;
}
.text-input,
.select,
.number-input {
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.5rem;
  color: inherit;
  font: inherit;
  padding: 0.65rem;
  width: 100%;
  box-sizing: border-box;
}
.counter,
.hint,
.settings-note,
.awaiting,
.source-preview p {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
}
.counter {
  text-align: right;
}
.examples,
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.examples button {
  background: transparent;
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 999px;
  color: inherit;
  cursor: pointer;
  min-height: 2.5rem;
  padding: 0.25rem 0.75rem;
}
.status {
  min-height: 1.5rem;
  margin: 0;
}
.error {
  color: rgb(var(--v-theme-error));
  margin: 0;
}
.output-header {
  align-items: center;
  display: flex;
  justify-content: space-between;
}
.source-preview img {
  border-radius: 0.75rem;
  display: block;
  max-height: 32rem;
  max-width: 100%;
  object-fit: contain;
}
.attribution {
  margin: 1rem 0 0;
}
</style>
