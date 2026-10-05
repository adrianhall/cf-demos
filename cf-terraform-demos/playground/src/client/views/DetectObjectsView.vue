<script setup lang="ts">
/**
 * @file The Detect Objects panel: answers _where_ rather than _what_. Two things make this panel
 *   different from Classify Image, and the markup below is shaped by both. First, the model takes a
 *   **phrase the visitor supplies** instead of choosing from a label set it was trained on, so the
 *   label beside every region is their own words echoed back. Second, a detection carries **no
 *   score at all** — four coordinates and nothing else — so there is no confidence bar, no score
 *   column, and no score floor. Both absences are stated rather than left to be inferred from a
 *   missing control. The overlay is an enhancement on a result that is already complete without it.
 *   The table below carries every fact the boxes do, including each region described in words,
 *   which is what keeps the answer usable for a visitor who cannot see the picture.
 */
import { computed, onMounted, watch } from 'vue';
import { findTask } from '../../shared/tasks';
import SourceImagePicker from '../components/media/SourceImagePicker.vue';
import ModelSettingsPanel from '../components/ModelSettingsPanel.vue';
import PanelPage from '../components/PanelPage.vue';
import PanelWorkspace from '../components/PanelWorkspace.vue';
import RunDetails from '../components/runs/RunDetails.vue';
import { DETECTION_EXAMPLES } from '../features/detect-objects/examples';
import { useDetectObjects } from '../features/detect-objects/useDetectObjects';
import { useCatalogueStore } from '../stores/catalogue';

const task = computed(() => findTask('detect-objects'));
const catalogue = useCatalogueStore();
const panel = useDetectObjects();

const {
  image,
  model,
  target,
  maxObjects,
  models,
  selectedModel,
  detecting,
  error,
  detections,
  hasResult,
  receipt,
  applied,
  metrics,
  costPending,
  canDetect
} = panel;

onMounted(() => {
  void catalogue.load();
});

// The catalogue arrives after the first render, so the default is chosen when it does rather than
// being hard-coded here where it could drift from the reviewed list.
watch(
  models,
  (available) => {
    if (model.value === '' && available[0] !== undefined) {
      model.value = available[0].id;
    }
  },
  { immediate: true }
);

/**
 * Converts a normalised coordinate into a CSS percentage.
 *
 * Percentages rather than pixels so a box tracks the picture as the preview is resized. The model
 * returns fractions of the image, which is exactly what a percentage means here, so no dimension is
 * needed to place one.
 *
 * @param value A coordinate in the range 0–1.
 * @returns The equivalent CSS percentage.
 */
function percent(value: number): string {
  return `${value * 100}%`;
}
</script>

<template>
  <PanelPage v-if="task" :task="task">
    <template #description>
      <p class="attribution">
        This Cloudflare-hosted model localises the phrase you supply. Unlike Classify Image, it does
        not choose labels from a fixed set and returns no confidence score — a detection is a
        region, not a judgement about how certain the model is. Your verified email is recorded in
        AI Gateway for attribution; assume your picture and target phrase are logged, and do not
        upload anything confidential.
      </p>
    </template>

    <p v-if="error" role="alert" class="error">{{ error }}</p>

    <PanelWorkspace :has-output="image !== undefined">
      <template #input>
        <section class="composer">
          <h2>Find objects</h2>
          <SourceImagePicker
            label="Picture to search"
            :image="image"
            :busy="detecting"
            @selected="panel.selectFile"
            @cleared="panel.clearImage"
          />
          <label class="field-label" for="detect-target">What should the model locate?</label>
          <input id="detect-target" v-model="target" class="target-input" />
          <button class="detect-button" :disabled="!canDetect" @click="panel.detect">
            Detect objects
          </button>

          <section class="examples">
            <h3>Or try a prepared target</h3>
            <ul>
              <li v-for="example in DETECTION_EXAMPLES" :key="example.name">
                <button type="button" @click="target = example.target">{{ example.name }}</button>
                <span>{{ example.teaches }}</span>
              </li>
            </ul>
          </section>
        </section>

        <ModelSettingsPanel :model-name="selectedModel?.name" :model-id="selectedModel?.id">
          <label class="field-label" for="detect-model">Model</label>
          <select id="detect-model" v-model="model">
            <option v-for="item in models" :key="item.id" :value="item.id">
              {{ item.name }}
            </option>
          </select>
          <label class="field-label" for="detect-max-objects">
            Maximum regions (model applies this limit)
          </label>
          <input
            id="detect-max-objects"
            v-model.number="maxObjects"
            type="number"
            :min="selectedModel?.detectionControls?.maxObjects.min ?? 1"
            :max="selectedModel?.detectionControls?.maxObjects.max ?? 500"
            :placeholder="String(selectedModel?.detectionControls?.maxObjects.default ?? 150)"
          />
          <p>
            This model receives your target and maximum directly, so the limit is applied by the
            provider rather than by trimming a longer list here. It returns structured regions, not
            labels or scores.
          </p>
        </ModelSettingsPanel>
      </template>

      <template #output>
        <section>
          <h2>Run output</h2>
          <p v-if="!hasResult && !detecting">Detected regions will appear here.</p>
          <p v-else-if="detecting" role="status">Locating matching regions.</p>

          <template v-else>
            <p v-if="detections.length === 0">
              No objects matching <em>{{ applied?.target }}</em> were detected. This was a
              successful run — the model looked and found none.
            </p>

            <template v-else>
              <p>
                {{ detections.length }}
                {{ detections.length === 1 ? 'region' : 'regions' }} matching
                <em>{{ applied?.target }}</em
                >. The model supplied no ranking and no confidence.
              </p>

              <div class="overlay">
                <img :src="image?.previewUri" alt="Source picture with detected regions overlaid" />
                <button
                  v-for="detection in detections"
                  :key="detection.index"
                  class="box"
                  :style="{
                    left: percent(detection.xMin),
                    top: percent(detection.yMin),
                    width: percent(detection.xMax - detection.xMin),
                    height: percent(detection.yMax - detection.yMin)
                  }"
                  :aria-label="`${detection.label}, ${detection.region}`"
                />
              </div>

              <table>
                <caption>
                  Detected regions (the complete result, without the overlay)
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Target</th>
                    <th scope="col">Region</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="detection in detections" :key="detection.index">
                    <td>{{ detection.label }}</td>
                    <td>{{ detection.region }}</td>
                  </tr>
                </tbody>
              </table>
            </template>

            <RunDetails
              v-if="receipt"
              :receipt="receipt"
              :metrics="metrics"
              :cost-pending="costPending"
            />
          </template>
        </section>
      </template>
    </PanelWorkspace>
  </PanelPage>
</template>

<style scoped>
.composer {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.error {
  color: rgb(var(--v-theme-error));
}

.examples ul {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  list-style: none;
  padding: 0;
}

.examples span {
  display: block;
  font-size: 0.875rem;
  opacity: 0.8;
}

.overlay {
  position: relative;
  line-height: 0;
}

.overlay img {
  display: block;
  max-width: 100%;
  height: auto;
}

.box {
  position: absolute;
  border: 3px solid rgb(var(--v-theme-primary));
  background: transparent;
  cursor: pointer;
}

/*
  Hover and focus are styled together so the two representations highlight identically, and so the
  link between a row and its box works for a keyboard as well as a pointer.
*/
.box:hover,
.box:focus-visible,
tbody tr:hover,
tbody tr:focus-within {
  outline: 3px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

table {
  border-collapse: collapse;
  margin-top: 1rem;
  width: 100%;
}

th,
td {
  border: 1px solid rgb(var(--v-theme-outline));
  padding: 0.5rem;
  text-align: left;
}

.attribution {
  margin-top: 1rem;
}
</style>
