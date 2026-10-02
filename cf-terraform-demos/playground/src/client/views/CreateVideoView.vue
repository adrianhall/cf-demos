<script setup lang="ts">
/**
 * Route composition for the phase-eight Create Video panel.
 *
 * Two things make this panel's copy different from every panel before it, and both are honesty
 * obligations rather than presentation choices.
 *
 * **The cost is quoted before the request.** Generation bills per second of output at rates that
 * differ thirtyfold across resolutions, so a visitor who learns the price afterwards learns it too
 * late. The estimate sits next to the button that spends it, and is labelled an estimate everywhere
 * — the authoritative figure still comes from the AI Gateway log.
 *
 * **The video is stored, and the panel says so without promising an expiry.** Nothing deletes a
 * finished video until the scheduled reaper arrives in a later phase, so the panel states that it
 * is stored and stops there. A countdown this demo could not honour would be worse than silence.
 */
import { computed, onMounted, ref } from 'vue';
import { MAX_VIDEO_PROMPT_CHARACTERS } from '../../shared/create-video';
import { findTask } from '../../shared/tasks';
import InfoButton from '../components/InfoButton.vue';
import InfoDialog from '../components/InfoDialog.vue';
import { formatBytes } from '../components/media/image-input';
import ModelSettingsPanel from '../components/ModelSettingsPanel.vue';
import PanelPage from '../components/PanelPage.vue';
import PanelWorkspace from '../components/PanelWorkspace.vue';
import RunDetails from '../components/runs/RunDetails.vue';
import { VIDEO_EXAMPLES, type VideoExample } from '../features/create-video/examples';
import { useCreateVideo } from '../features/create-video/useCreateVideo';
import { useCatalogueStore } from '../stores/catalogue';

const task = computed(() => findTask('create-video'));
const catalogue = useCatalogueStore();

/**
 * Reviewed models for this panel, as the server reported them.
 */
const models = computed(() => catalogue.modelsForTask('create-video'));

const {
  prompt,
  negativePrompt,
  model,
  resolution,
  aspectRatio,
  duration,
  generateAudio,
  selectedModel,
  estimatedCostUsd,
  state,
  generating,
  error,
  video,
  source,
  receipt,
  metrics,
  costPending,
  applied,
  canGenerate,
  generate,
  stop
} = useCreateVideo({ models });

/**
 * Whether the run-details modal is showing.
 */
const showRunDetails = ref(false);

/**
 * The selected model's declared video controls, or `undefined` before the catalogue loads.
 */
const controls = computed(() => selectedModel.value?.videoControls);

/**
 * The durations the selected model accepts, as a list the UI can render.
 *
 * A model declares either a continuous range or a fixed set. Flattening both into one list of
 * options keeps the markup to a single control rather than branching the template on which form the
 * model happens to use.
 *
 * @returns The permitted durations in seconds, or an empty list before a model is selected.
 */
const durationOptions = computed<number[]>(() => {
  const support = controls.value;
  if (support === undefined) {
    return [];
  }
  if (support.durationChoices !== undefined) {
    return [...support.durationChoices];
  }
  if (support.durationRange === undefined) {
    return [];
  }
  const { min, max, step } = support.durationRange;
  const options: number[] = [];
  for (let value = min; value <= max; value += step) {
    options.push(value);
  }
  return options;
});

/**
 * Whether the output column has anything to show.
 *
 * @returns `true` once a job has been started or a video exists.
 */
const hasOutput = computed(() => state.value !== undefined || video.value !== undefined);

/**
 * The estimate rendered as currency, or a note that the price is unknown.
 *
 * @returns The formatted estimate, or an empty string before a model is selected.
 */
const estimateLabel = computed(() => {
  const estimate = estimatedCostUsd.value;
  if (estimate === undefined) {
    return '';
  }
  // Four decimal places rather than two: the cheapest combination is a few cents, and rounding it
  // to `$0.13` is fine while rounding a 1-second 360p render to `$0.03` loses the point.
  return `$${estimate.toFixed(estimate < 1 ? 4 : 2)}`;
});

/**
 * A sentence describing what the current job is doing.
 *
 * Written per state rather than as one spinner caption, because the states mean genuinely different
 * things to someone deciding whether to wait: `accepted` means nothing is being charged yet, while
 * `running` means the model is working and the money is being spent.
 *
 * @returns The sentence, or an empty string when no job is in flight.
 */
const progressSentence = computed(() => {
  switch (state.value) {
    case 'accepted':
      return 'Job accepted and waiting to start. Nothing has been charged yet.';
    case 'running':
      return 'Generating. This takes a few minutes, and it keeps going if you close this tab.';
    case 'cancelled':
      return 'Cancelled. Anything already generated has been deleted.';
    default:
      return '';
  }
});

onMounted(() => {
  void catalogue.load();
});

/**
 * Loads a prepared prompt and its controls.
 *
 * @param example Example to load.
 * @returns Nothing; the form is populated. The run is deliberately not started — a prepared prompt
 *   that spent several dollars the moment it was clicked would be a trap, and this is the panel
 *   where that matters most.
 */
function loadExample(example: VideoExample): void {
  prompt.value = example.prompt;
  if (example.resolution !== undefined) {
    resolution.value = example.resolution;
  }
  if (example.duration !== undefined) {
    duration.value = example.duration;
  }
}
</script>

<template>
  <PanelPage v-if="task" :task="task">
    <template #description>
      <p class="attribution" role="note">
        This panel calls a real model and spends real inference credit. Every reviewed video model
        is third-party, so it bills against prepaid AI Gateway credits. Your verified email is
        recorded in the AI Gateway log for each request so spending can be attributed. Assume your
        prompt is logged too, and do not describe anything confidential.
      </p>
      <p class="attribution" role="note">
        Video is charged per second of output, and the rate changes with resolution — a
        fifteen-second render at the highest setting can cost several dollars, where a short clip at
        the lowest costs a few cents. The panel shows an estimate before you start. The figure in
        Run details afterwards is the one the gateway actually reported, and it is the authoritative
        one.
      </p>
      <p class="attribution" role="note">
        Unlike the other panels, the result is stored rather than held in your browser. The model
        returns a short-lived link on the provider's own servers, so this demo copies the video once
        into its own storage and serves it back from this site — which is what lets the player seek,
        and what keeps the result working after the provider's link has expired. Nothing deletes it
        automatically yet.
      </p>
    </template>

    <div class="create-video">
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <PanelWorkspace :has-output="hasOutput">
        <template #input>
          <section class="composer" aria-labelledby="composer-heading">
            <h2 id="composer-heading" class="section-heading">Describe a video</h2>

            <div class="field">
              <label class="field-label" for="video-prompt">What should the video show?</label>
              <textarea
                id="video-prompt"
                v-model="prompt"
                class="textarea"
                :maxlength="MAX_VIDEO_PROMPT_CHARACTERS"
                rows="4"
                :disabled="generating"
              ></textarea>
              <p class="hint">
                {{ prompt.trim().length }} of {{ MAX_VIDEO_PROMPT_CHARACTERS }} characters
              </p>
            </div>

            <div v-if="controls?.negativePrompt" class="field">
              <label class="field-label" for="video-negative-prompt">
                Anything to avoid (optional)
              </label>
              <textarea
                id="video-negative-prompt"
                v-model="negativePrompt"
                class="textarea"
                :maxlength="MAX_VIDEO_PROMPT_CHARACTERS"
                rows="2"
                :disabled="generating"
              ></textarea>
            </div>

            <!--
              The estimate sits next to the button that spends it, not in a disclosure. This is the
              one number a visitor most needs before clicking, and putting it one interaction away
              would be putting it out of the way.
            -->
            <p v-if="estimateLabel" class="estimate">
              Estimated cost:
              <strong>{{ estimateLabel }}</strong>
              for {{ applied?.duration ?? duration ?? controls?.defaultDuration }} seconds at
              {{ resolution ?? controls?.defaultResolution }}.
              <!--
                Each branch carries its own complete sentence, including the full stop. Putting the
                conditional *inside* a shared sentence rendered as "per-second price . The reported
                cost", because the formatter wraps the tag and the browser collapses the newline
                into a space before the period.
              -->
              <span class="estimate-caveat">
                <template v-if="generateAudio">
                  An estimate from the model's published per-second price, and a floor rather than a
                  prediction, since audio is billed at a higher rate.
                </template>
                <template v-else>An estimate from the model's published per-second price.</template>
                The reported cost appears in Run details.
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
                Generate video
              </v-btn>
              <v-btn v-if="generating" class="cancel-button" variant="outlined" @click="stop">
                Cancel
              </v-btn>
            </div>

            <p v-if="prompt.trim() === ''" class="hint">Describe a video to generate.</p>

            <!--
              Persistent, so the text *changes* between states rather than appearing already
              populated. Screen readers announce a changed live region more reliably than one
              inserted with content.
            -->
            <p class="status" role="status">{{ progressSentence }}</p>

            <div class="example-group" role="group" aria-labelledby="examples-heading">
              <h3 id="examples-heading" class="field-label">Or try a prepared prompt</h3>
              <div class="examples">
                <button
                  v-for="example in VIDEO_EXAMPLES"
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
            </div>
          </section>

          <ModelSettingsPanel :model-name="selectedModel?.name">
            <div class="field">
              <label class="field-label" for="video-model">Model</label>
              <select id="video-model" v-model="model" class="select" :disabled="generating">
                <option v-for="candidate in models" :key="candidate.id" :value="candidate.id">
                  {{ candidate.name }}
                </option>
              </select>
            </div>

            <div v-if="controls" class="field">
              <label class="field-label" for="video-resolution">Resolution</label>
              <select
                id="video-resolution"
                v-model="resolution"
                class="select"
                :disabled="generating"
              >
                <option :value="undefined">Model default ({{ controls.defaultResolution }})</option>
                <option v-for="option in controls.resolutions" :key="option" :value="option">
                  {{ option }} — ${{ controls.pricePerSecondUsd[option]?.toFixed(3) }}/second
                </option>
              </select>
              <p class="hint">
                Resolution is the biggest lever on cost in this panel, which is why the price is
                shown against each option.
              </p>
            </div>

            <div v-if="controls" class="field">
              <label class="field-label" for="video-duration">Duration</label>
              <select
                id="video-duration"
                v-model.number="duration"
                class="select"
                :disabled="generating"
              >
                <option :value="undefined">
                  Model default ({{ controls.defaultDuration }} seconds)
                </option>
                <option v-for="option in durationOptions" :key="option" :value="option">
                  {{ option }} seconds
                </option>
              </select>
            </div>

            <div v-if="controls" class="field">
              <label class="field-label" for="video-aspect">Aspect ratio</label>
              <select id="video-aspect" v-model="aspectRatio" class="select" :disabled="generating">
                <option :value="undefined">
                  Model default ({{ controls.defaultAspectRatio }})
                </option>
                <option v-for="option in controls.aspectRatios" :key="option" :value="option">
                  {{ option }}
                </option>
              </select>
            </div>

            <div v-if="controls?.audioParameterName" class="field checkbox-field">
              <input
                id="video-audio"
                v-model="generateAudio"
                class="checkbox"
                type="checkbox"
                :disabled="generating"
              />
              <label class="field-label" for="video-audio">Generate audio</label>
              <p class="hint">Audio is billed at a higher per-second rate than silent video.</p>
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

            <p v-if="state === undefined" class="awaiting">The generated video will appear here.</p>

            <!--
              A job in flight gets a real description of its state rather than a bare spinner,
              because "accepted" and "running" differ in whether money is being spent.
            -->
            <p v-else-if="generating" class="generating">{{ progressSentence }}</p>

            <p v-else-if="state === 'cancelled'" class="empty-result">
              Cancelled. The job was stopped and anything it had stored has been deleted.
            </p>

            <template v-else-if="state === 'completed' && source">
              <!--
                `controls` gives keyboard operation, play/pause, seeking, and volume without this
                demo reimplementing any of it. `preload="metadata"` fetches enough to show duration
                and a first frame, which is what makes the player look ready rather than blank — and
                it is a ranged request, which is the whole reason the video is served from storage.
              -->
              <video
                class="player"
                controls
                preload="metadata"
                :src="source"
                :aria-label="`Generated video for: ${applied?.prompt ?? prompt}`"
              ></video>

              <p class="prompt-echo">
                <span class="prompt-echo-label">Prompt</span>
                {{ applied?.prompt }}
              </p>

              <dl v-if="video" class="verified-facts">
                <div class="fact">
                  <dt>Format</dt>
                  <dd>{{ video.mediaType }}</dd>
                </div>
                <div class="fact">
                  <dt>Size</dt>
                  <dd>
                    <!--
                      The download link is the metadata line, matching the other media panels rather
                      than adding a separate button.
                    -->
                    <a :href="source" download>{{ formatBytes(video.byteLength) }}</a>
                  </dd>
                </div>
                <div v-if="applied" class="fact">
                  <dt>Settings</dt>
                  <dd>
                    {{ applied.resolution }}, {{ applied.duration }}s, {{ applied.aspectRatio }}
                  </dd>
                </div>
                <div v-if="applied" class="fact">
                  <dt>Estimated</dt>
                  <dd>
                    ${{ applied.estimatedCostUsd.toFixed(applied.estimatedCostUsd < 1 ? 4 : 2) }}
                  </dd>
                </div>
              </dl>

              <p class="storage-note">
                This video is stored in the demo's own bucket and served from this site. It is not
                deleted automatically yet.
              </p>
            </template>
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
.create-video {
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
}

.field-label {
  font-size: 0.8125rem;
  font-weight: 600;
}

.textarea,
.select {
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgba(var(--v-border-color), 0.4);
  border-radius: 6px;
  color: inherit;
  font: inherit;
  padding: 0.5rem 0.625rem;
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
.estimate-caveat {
  color: rgba(var(--v-theme-on-surface), 0.7);
  font-size: 0.8125rem;
  margin: 0;
}

.estimate {
  background: rgba(var(--v-theme-primary), 0.06);
  border-left: 3px solid rgb(var(--v-theme-primary));
  border-radius: 4px;
  font-size: 0.875rem;
  margin: 0;
  padding: 0.625rem 0.75rem;
}

.estimate-caveat {
  display: block;
  margin-top: 0.25rem;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.status,
.generating,
.awaiting,
.empty-result,
.storage-note {
  color: rgba(var(--v-theme-on-surface), 0.75);
  font-size: 0.875rem;
  margin: 0;
  min-height: 1.25rem;
}

.error {
  background: rgba(var(--v-theme-error), 0.08);
  border-left: 3px solid rgb(var(--v-theme-error));
  border-radius: 4px;
  margin: 0;
  padding: 0.625rem 0.75rem;
}

.player {
  background: #000;
  border-radius: 8px;
  max-height: 60vh;
  width: 100%;
}

.prompt-echo {
  font-size: 0.875rem;
  margin: 0;
}

.prompt-echo-label {
  color: rgba(var(--v-theme-on-surface), 0.7);
  display: block;
  font-size: 0.75rem;
  text-transform: uppercase;
}

.verified-facts {
  display: grid;
  gap: 0.5rem 1rem;
  grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
  margin: 0;
}

.fact dt {
  color: rgba(var(--v-theme-on-surface), 0.7);
  font-size: 0.75rem;
  text-transform: uppercase;
}

.fact dd {
  font-size: 0.875rem;
  margin: 0;
}

.examples {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.example-button {
  background: rgba(var(--v-theme-on-surface), 0.04);
  border: 1px solid rgba(var(--v-border-color), 0.4);
  border-radius: 999px;
  cursor: pointer;
  font-size: 0.8125rem;
  padding: 0.25rem 0.75rem;
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

.docs-link {
  font-size: 0.8125rem;
  margin: 0;
}

.attribution {
  margin: 0 0 0.5rem;
}
</style>
