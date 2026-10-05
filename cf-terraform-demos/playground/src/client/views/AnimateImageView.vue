<script setup lang="ts">
/**
 * Route composition for the phase-sixteen Animate Image panel.
 *
 * **This is a top-level panel, not a mode inside Create Video**, and the distinction is the whole
 * point of the phase. A visitor arriving with a picture finds a route, a title, and a form named
 * for what they want to do. There is no mode switch here and no nested selector: what the two
 * panels share is the implementation underneath — the job lifecycle, the bucket, the ownership
 * derivation, the credit-failure path — and none of that is visible as a tab.
 *
 * Three honesty obligations shape the copy, and each is a reviewed decision rather than a
 * presentation choice.
 *
 * **The cost is quoted before the request, and sometimes cannot be.** One reviewed model prices per
 * second; the other publishes a figure for each exact resolution-and-duration combination and has
 * not published all of them. The panel therefore has two different cost sentences and a third for
 * "no published price", rather than rendering a confident `$0.00` that would read as free.
 *
 * **The two halves of the result are handled differently, and the panel says which.** The source
 * still travels inside the request to a third-party model, and this demo writes it to no storage of
 * its own — but it reaches the provider, so the copy tells a visitor to assume it is logged exactly
 * as a prompt is, rather than offering a retention guarantee that belongs to someone else. The
 * generated video is copied into this demo's bucket so the player can seek.
 *
 * **There is no Cloudflare-hosted model for this task.** Every image-to-video model in the
 * catalogue is third-party and bills against prepaid AI Gateway credits. That is said plainly in
 * the panel rather than discovered through a failure.
 */
import { computed, onMounted, ref } from 'vue';
import { MAX_MOTION_PROMPT_CHARACTERS } from '../../shared/animate-image';
import { findTask } from '../../shared/tasks';
import InfoButton from '../components/InfoButton.vue';
import InfoDialog from '../components/InfoDialog.vue';
import { formatBytes } from '../components/media/image-input';
import SourceImagePicker from '../components/media/SourceImagePicker.vue';
import ModelSettingsPanel from '../components/ModelSettingsPanel.vue';
import PanelPage from '../components/PanelPage.vue';
import PanelWorkspace from '../components/PanelWorkspace.vue';
import RunDetails from '../components/runs/RunDetails.vue';
import { ANIMATE_EXAMPLES, type AnimateExample } from '../features/animate-image/examples';
import { useAnimateImage } from '../features/animate-image/useAnimateImage';
import { useCatalogueStore } from '../stores/catalogue';
import { useHandoffStore } from '../stores/handoff';

const task = computed(() => findTask('animate-image'));
const catalogue = useCatalogueStore();
const handoff = useHandoffStore();

/**
 * Reviewed models for this panel, as the server reported them.
 */
const models = computed(() => catalogue.modelsForTask('animate-image'));

const {
  source,
  motionPrompt,
  negativePrompt,
  model,
  resolution,
  duration,
  selectedModel,
  estimate,
  state,
  animating,
  error,
  failureReason,
  video,
  videoSource,
  receipt,
  metrics,
  costPending,
  applied,
  canAnimate,
  selectSource,
  acceptHandoff,
  clearSource,
  animate,
  stop
} = useAnimateImage({ models });

/**
 * Whether the run-details modal is showing.
 */
const showRunDetails = ref(false);

/**
 * The selected model's declared animation controls, or `undefined` before the catalogue loads.
 */
const controls = computed(() => selectedModel.value?.animateImageControls);

/**
 * The durations the selected model accepts, as a list the UI can render.
 *
 * A model declares either a continuous range or a fixed set, and here both forms genuinely occur:
 * Alibaba takes any integer from 3 to 15, MiniMax takes 6 or 10 and nothing else. Flattening them
 * into one list keeps the markup to a single control rather than branching the template on which
 * form the model happens to use.
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
 * Switches as soon as a picture is chosen rather than waiting for a run, because the still is half
 * of this panel's result and is worth showing beside the form immediately.
 *
 * @returns `true` once a picture is selected or a job has been started.
 */
const hasOutput = computed(() => source.value !== undefined || state.value !== undefined);

/**
 * The estimate rendered as currency, or an empty string when there is nothing to quote.
 *
 * @returns The formatted estimate, or an empty string before a model is selected or when no price
 *   is published for the chosen combination.
 */
const estimateLabel = computed(() => {
  const current = estimate.value;
  if (current === undefined || !current.known) {
    return '';
  }
  // Four decimal places below a dollar: the cheapest combination here is around forty cents, but a
  // future cheaper model should not have its price rounded away.
  return `$${current.costUsd.toFixed(current.costUsd < 1 ? 4 : 2)}`;
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
      return 'Animating. This takes a few minutes, and it keeps going if you close this tab.';
    case 'cancelled':
      return 'Cancelled. Anything already generated has been deleted.';
    default:
      return '';
  }
});

onMounted(() => {
  void catalogue.load();

  // Collects a picture handed over from Create Image. Taking it clears the slot, so returning to
  // this panel later does not silently reload a picture the visitor has moved on from.
  const pending = handoff.take();
  if (pending !== undefined) {
    acceptHandoff(pending);
  }
});

/**
 * Loads a prepared motion prompt and its duration.
 *
 * @param example Example to load.
 * @returns Nothing; the form is populated. The run is deliberately not started — a prepared prompt
 *   that spent real money the moment it was clicked would be a trap, and this panel bills per
 *   second of output.
 */
function loadExample(example: AnimateExample): void {
  motionPrompt.value = example.motionPrompt;
  // Only applied when the selected model actually accepts it. The two reviewed models disagree
  // about which durations exist, so an example's suggestion is a preference rather than a value
  // the form may adopt unchecked.
  if (example.duration !== undefined && durationOptions.value.includes(example.duration)) {
    duration.value = example.duration;
  }
}
</script>

<template>
  <PanelPage v-if="task" :task="task">
    <template #description>
      <p class="attribution" role="note">
        This panel calls a real model and spends real inference credit.
        <strong>There is no Cloudflare-hosted image-to-video model</strong>
        — every model here is third-party and bills against prepaid AI Gateway credits. Your
        verified email is recorded in the AI Gateway log for each request so spending can be
        attributed. Assume your motion prompt is logged too, and do not describe anything
        confidential.
      </p>
      <p class="attribution" role="note">
        Animation is charged by the length of the clip, and the two models price differently: one
        publishes a rate per second, the other a price for each exact length and resolution it
        supports. The panel shows an estimate before you start, and says so plainly when a model has
        published no price for the combination you picked. The figure in Run details afterwards is
        the one the gateway actually reported, and it is the authoritative one.
      </p>
      <p class="attribution" role="note">
        Your picture travels inside the generation request to a third-party model, so assume it is
        logged in the same way your prompt is. This demo writes it to no storage of its own — only
        the generated video is kept — but what the gateway or the provider retains is theirs to
        state, not this demo's.
      </p>
      <p class="attribution" role="note">
        The generated video is handled differently and deliberately so. The model returns a
        short-lived link on the provider's own servers, so the video is copied once into this demo's
        storage and served back from this site — which is what lets the player seek, and what keeps
        the result working after the provider's link has expired. Nothing deletes it automatically
        yet.
      </p>
    </template>

    <div class="animate-image">
      <!--
        The billing failure gets its own treatment rather than sharing the generic error box. It is
        the only failure in this panel a visitor can resolve, it is the *likely* one on an account
        without prepaid credit, and it needs a different verb from every other error: top up an
        account, not try again.
      -->
      <section
        v-if="failureReason === 'insufficient-credit'"
        class="credit-notice"
        role="alert"
        aria-labelledby="credit-heading"
      >
        <h2 id="credit-heading" class="credit-heading">AI Gateway credit is required</h2>
        <p class="credit-detail">{{ error }}</p>
        <p class="credit-actions">
          <a
            href="https://developers.cloudflare.com/ai-gateway/features/unified-billing/"
            rel="noreferrer"
            target="_blank"
          >
            How prepaid AI Gateway credits work
          </a>
        </p>
      </section>

      <p v-else-if="error" class="error" role="alert">{{ error }}</p>

      <PanelWorkspace :has-output="hasOutput">
        <template #input>
          <section class="composer" aria-labelledby="composer-heading">
            <h2 id="composer-heading" class="section-heading">Animate a picture</h2>

            <SourceImagePicker
              label="Picture to animate"
              :image="source"
              :busy="animating"
              @selected="selectSource"
              @cleared="clearSource"
            />

            <div class="field">
              <label class="field-label" for="animate-motion-prompt">
                What should happen?
                <span v-if="controls?.motionPromptRequired === false">(optional)</span>
              </label>
              <textarea
                id="animate-motion-prompt"
                v-model="motionPrompt"
                class="textarea"
                :maxlength="MAX_MOTION_PROMPT_CHARACTERS"
                rows="3"
                :disabled="animating"
              ></textarea>
              <p class="hint">
                Describe the
                <em>motion</em>
                , not the picture — the model can already see it.
                <template v-if="controls?.motionPromptRequired">
                  {{ selectedModel?.name }} requires this.
                </template>
                <template v-else-if="controls">
                  {{ selectedModel?.name }} will animate the picture without one.
                </template>
              </p>
            </div>

            <div v-if="controls?.negativePrompt" class="field">
              <label class="field-label" for="animate-negative-prompt">
                Anything to avoid (optional)
              </label>
              <textarea
                id="animate-negative-prompt"
                v-model="negativePrompt"
                class="textarea"
                :maxlength="MAX_MOTION_PROMPT_CHARACTERS"
                rows="2"
                :disabled="animating"
              ></textarea>
            </div>

            <!--
              The estimate sits next to the button that spends it. The unknown branch is not an
              error state: it is an accurate report that the provider has published no price for
              this exact combination, and showing "$0.00" instead would claim the run is free.
            -->
            <p v-if="estimate && estimate.known" class="estimate">
              Estimated cost:
              <strong>{{ estimateLabel }}</strong>
              for {{ applied?.duration ?? duration ?? controls?.defaultDuration }} seconds at
              {{ resolution ?? controls?.defaultResolution }}.
              <span class="estimate-caveat">
                An estimate from the model's published prices. The reported cost appears in Run
                details.
              </span>
            </p>
            <p v-else-if="estimate" class="estimate estimate--unknown">
              <strong>No published price</strong>
              for {{ duration ?? controls?.defaultDuration }} seconds at
              {{ resolution ?? controls?.defaultResolution }}.
              <span class="estimate-caveat">
                {{ selectedModel?.name }} publishes prices for specific length and resolution
                combinations, and not for this one. This run will still be charged — the amount
                simply is not knowable in advance. Run details will report what the gateway actually
                charged.
              </span>
            </p>

            <div class="actions">
              <v-btn
                class="animate-button"
                color="primary"
                :disabled="!canAnimate"
                variant="flat"
                @click="animate"
              >
                Animate picture
              </v-btn>
              <v-btn v-if="animating" class="cancel-button" variant="outlined" @click="stop">
                Cancel
              </v-btn>
            </div>

            <p v-if="!source" class="hint">Choose a picture to animate.</p>
            <p
              v-else-if="controls?.motionPromptRequired && motionPrompt.trim() === ''"
              class="hint"
            >
              {{ selectedModel?.name }} needs a description of the motion.
            </p>

            <!--
              Persistent, so the text *changes* between states rather than appearing already
              populated. Screen readers announce a changed live region more reliably than one
              inserted with content.
            -->
            <p class="status" role="status">{{ progressSentence }}</p>

            <div class="example-group" role="group" aria-labelledby="examples-heading">
              <h3 id="examples-heading" class="field-label">Or try a prepared instruction</h3>
              <div class="examples">
                <button
                  v-for="example in ANIMATE_EXAMPLES"
                  :key="example.id"
                  type="button"
                  class="example-button"
                  :data-example="example.id"
                  :title="example.teaches"
                  :disabled="animating"
                  @click="loadExample(example)"
                >
                  {{ example.label }}
                </button>
              </div>
            </div>
          </section>

          <ModelSettingsPanel :model-name="selectedModel?.name">
            <div class="field">
              <label class="field-label" for="animate-model">Model</label>
              <select id="animate-model" v-model="model" class="select" :disabled="animating">
                <option v-for="candidate in models" :key="candidate.id" :value="candidate.id">
                  {{ candidate.name }}
                </option>
              </select>
              <p class="hint">
                These models disagree about almost everything: what the picture parameter is called,
                which resolutions exist, which clip lengths are allowed, and how they bill.
                Switching model resets the controls below rather than carrying over a value the
                other one would reject.
              </p>
            </div>

            <div v-if="controls" class="field">
              <label class="field-label" for="animate-resolution">Resolution</label>
              <select
                id="animate-resolution"
                v-model="resolution"
                class="select"
                :disabled="animating"
              >
                <option :value="undefined">Model default ({{ controls.defaultResolution }})</option>
                <option v-for="option in controls.resolutions" :key="option" :value="option">
                  {{ option
                  }}<template v-if="controls.pricePerSecondUsd?.[option] !== undefined">
                    — ${{ controls.pricePerSecondUsd[option]?.toFixed(3) }}/second
                  </template>
                </option>
              </select>
            </div>

            <div v-if="controls" class="field">
              <label class="field-label" for="animate-duration">Duration</label>
              <select
                id="animate-duration"
                v-model.number="duration"
                class="select"
                :disabled="animating"
              >
                <option :value="undefined">
                  Model default ({{ controls.defaultDuration }} seconds)
                </option>
                <option v-for="option in durationOptions" :key="option" :value="option">
                  {{ option }} seconds
                </option>
              </select>
              <p v-if="controls.durationChoices" class="hint">
                {{ selectedModel?.name }} accepts only these lengths — not a range.
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
              <h2 id="result-heading" class="section-heading">Still and animation</h2>
              <InfoButton
                v-if="receipt"
                class="run-details-button"
                label="Run details, including reported cost"
                @activate="showRunDetails = true"
              />
            </div>

            <!--
              The side-by-side layout is the panel's primary result, and it is deliberately a
              comparison rather than two unrelated boxes: the relationship between the still and
              the clip is the only thing worth looking at here. It stacks on a narrow screen, where
              two tiny panes would show neither properly.
            -->
            <div class="comparison">
              <figure v-if="source" class="pane">
                <img class="still" :src="source.previewUri" alt="The picture being animated" />
                <figcaption class="pane-caption">
                  <span class="pane-label">Source still</span>
                  <template v-if="applied">
                    {{ applied.source.width }}×{{ applied.source.height }},
                    {{ formatBytes(applied.source.byteLength) }}
                    <!--
                      Reported from the facts the server read out of the bytes rather than from
                      anything the browser knew about the file, which is why they only appear once
                      a run has been accepted.
                    -->
                    <span class="verified-note">as verified by the server</span>
                  </template>
                  <template v-else>{{ formatBytes(source.byteLength) }}</template>
                </figcaption>
              </figure>

              <figure class="pane">
                <p v-if="state === undefined" class="awaiting">
                  The animation will appear here, beside your picture.
                </p>

                <p v-else-if="animating" class="generating">{{ progressSentence }}</p>

                <p v-else-if="state === 'cancelled'" class="empty-result">
                  Cancelled. The job was stopped and anything it had stored has been deleted.
                </p>

                <p v-else-if="state === 'failed'" class="empty-result">
                  <template v-if="failureReason === 'insufficient-credit'">
                    No animation was generated: this account needs prepaid AI Gateway credit.
                  </template>
                  <template v-else>
                    No animation was generated. The model or provider reported a failure.
                  </template>
                </p>

                <template v-else-if="state === 'completed' && videoSource">
                  <!--
                    `controls` gives keyboard operation, play/pause, seeking, and volume without
                    this demo reimplementing any of it. `preload="metadata"` issues a ranged
                    request, which is the whole reason the video is served from storage.
                  -->
                  <video
                    class="player"
                    controls
                    preload="metadata"
                    :src="videoSource"
                    aria-label="The animation generated from your picture"
                  ></video>
                </template>

                <figcaption v-if="state === 'completed' && video" class="pane-caption">
                  <span class="pane-label">Animation</span>
                  {{ applied?.duration }}s, {{ applied?.resolution }},
                  <a :href="videoSource" download>{{ formatBytes(video.byteLength) }}</a>
                </figcaption>
              </figure>
            </div>

            <p v-if="applied?.motionPrompt" class="prompt-echo">
              <span class="prompt-echo-label">Motion</span>
              {{ applied.motionPrompt }}
            </p>

            <dl v-if="state === 'completed' && applied" class="verified-facts">
              <div class="fact">
                <dt>Format</dt>
                <dd>{{ video?.mediaType }}</dd>
              </div>
              <div class="fact">
                <dt>Estimated</dt>
                <dd>
                  <template v-if="applied.estimateKnown">
                    ${{ applied.estimatedCostUsd.toFixed(applied.estimatedCostUsd < 1 ? 4 : 2) }}
                  </template>
                  <!--
                    Says so rather than printing a zero. "No published price" and "free" are
                    opposite claims, and only one of them is true here.
                  -->
                  <template v-else>Not published for this combination</template>
                </dd>
              </div>
            </dl>

            <p v-if="state === 'completed'" class="storage-note">
              The animation is kept in the demo's own bucket and served from this site. Your
              original picture was sent to the model with the request; this demo kept no copy of it,
              and what the provider retains is theirs to state.
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
.animate-image {
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

.comparison {
  display: grid;
  gap: 1rem;
  grid-template-columns: 1fr;
}

@media (min-width: 60rem) {
  .comparison {
    grid-template-columns: 1fr 1fr;
  }
}

.pane {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin: 0;
  min-width: 0;
}

.pane-caption {
  color: rgba(var(--v-theme-on-surface), 0.75);
  font-size: 0.8125rem;
}

.pane-label {
  display: block;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
}

.verified-note {
  display: block;
  font-size: 0.75rem;
  opacity: 0.8;
}

.still {
  background: rgba(var(--v-theme-on-surface), 0.04);
  border-radius: 8px;
  max-height: 60vh;
  object-fit: contain;
  width: 100%;
}

.player {
  background: #000;
  border-radius: 8px;
  max-height: 60vh;
  width: 100%;
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

.estimate--unknown {
  background: rgba(var(--v-theme-warning), 0.08);
  border-left-color: rgb(var(--v-theme-warning));
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

.credit-notice {
  background: rgba(var(--v-theme-warning), 0.1);
  border-left: 3px solid rgb(var(--v-theme-warning));
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.75rem 0.875rem;
}

.credit-heading {
  font-size: 1rem;
  margin: 0;
}

.credit-detail,
.credit-actions {
  font-size: 0.875rem;
  margin: 0;
}

.error {
  background: rgba(var(--v-theme-error), 0.08);
  border-left: 3px solid rgb(var(--v-theme-error));
  border-radius: 4px;
  margin: 0;
  padding: 0.625rem 0.75rem;
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
