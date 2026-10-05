/**
 * @file Stateful composable behind the Animate Image panel: choosing a picture, composing a
 *   request, starting a durable job, polling it, cancelling it, and handing a finished run to
 *   {@link useRun} for cost resolution. It follows Create Video's polling discipline exactly, and
 *   for the same reasons: **the interval backs off and stops**, so a render taking minutes does not
 *   generate hundreds of requests and a job the platform has lost cannot leave the UI spinning
 *   forever; **a late poll is discarded**, because cancellation and a slow in-flight response race
 *   each other and a stale response must not overwrite newer state; and **cancelling is not
 *   forgetting**, because it terminates the job and deletes what it stored, which is a real outcome
 *   worth showing. Two behaviours are this panel's own. The **source picture is kept across a
 *   run**, because the side-by-side result is only legible while the still is still on screen — and
 *   because a visitor whose render failed for want of credit should not also lose their upload. And
 *   the **estimate can be genuinely unknown**: one reviewed model publishes prices per exact
 *   resolution-and-duration combination and has not published all of them, so the panel
 *   distinguishes "this will cost nothing" from "nobody has said what this costs".
 */

import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import {
  priceCombinationKey,
  type AnimateImageRequest,
  type AppliedAnimateImageControls
} from '../../../shared/animate-image';
import {
  isTerminalMediaJobState,
  type MediaJobState,
  type StoredVideo,
  type VideoFailureReason
} from '../../../shared/create-video';
import type { RunMetrics, RunReceipt } from '../../../shared/runs';
import {
  isAcceptedUploadType,
  prepareImage,
  type PreparedImage
} from '../../components/media/image-input';
import { useRun, type UseRunOptions } from '../../composables/useRun';
import {
  animationUrl,
  ApiError,
  cancelAnimation,
  fetchAnimationStatus,
  startAnimation
} from '../../services/playground-api';
import type { CatalogueModel } from '../../stores/catalogue';
import type { HandoffImage } from '../../stores/handoff';

/**
 * Shortest gap between status polls, in milliseconds.
 */
const MIN_POLL_INTERVAL_MS = 1_000;

/**
 * Longest gap between status polls, in milliseconds.
 *
 * A render takes minutes, so once the job is clearly in progress there is nothing gained by asking
 * more often than this.
 */
const MAX_POLL_INTERVAL_MS = 15_000;

/**
 * How much each poll lengthens the interval.
 */
const POLL_BACKOFF_FACTOR = 1.6;

/**
 * Longest this panel will poll one job before declaring it lost, in milliseconds.
 *
 * Deliberately longer than the Workflow's own step timeouts, so this ceiling is reached only when
 * something has gone wrong that the Workflow itself did not report.
 */
export const ANIMATE_POLL_BUDGET_MS = 20 * 60 * 1_000;

/**
 * Options for {@link useAnimateImage}.
 */
export interface UseAnimateImageOptions {
  /**
   * Reviewed models for this panel, as reported by the catalogue. Reactive, because the catalogue
   * is fetched after mount and the form has to settle once it arrives.
   */
  models: Ref<CatalogueModel[]>;
  /**
   * Job-start transport, injected so tests drive outcomes directly instead of over HTTP.
   */
  start?: typeof startAnimation;
  /**
   * Status transport, injected for the same reason.
   */
  status?: typeof fetchAnimationStatus;
  /**
   * Cancellation transport, injected for the same reason.
   */
  cancel?: typeof cancelAnimation;
  /**
   * Sleep function used between polls, injected so a test advances time instead of waiting.
   */
  wait?: (ms: number) => Promise<void>;
  /**
   * Clock reading epoch milliseconds, injected so the poll budget can be tested without waiting.
   */
  now?: () => number;
  /**
   * Options forwarded to {@link useRun}, so a test can poll for cost without real delays.
   */
  runOptions?: UseRunOptions;
}

/**
 * An estimate the panel can render, including the case where there is not one.
 */
export interface AnimateEstimate {
  /**
   * Estimated cost in US dollars, meaningful only when {@link AnimateEstimate.known} is `true`.
   */
  costUsd: number;
  /**
   * Whether the selected model publishes a price for this exact combination.
   */
  known: boolean;
}

/**
 * What the Animate Image panel binds to.
 */
export interface UseAnimateImageResult {
  /**
   * The chosen source picture, or `undefined` before one is selected.
   */
  source: Ref<PreparedImage | undefined>;
  /**
   * The motion prompt being composed.
   */
  motionPrompt: Ref<string>;
  /**
   * Text describing what to avoid, for a model that accepts one.
   */
  negativePrompt: Ref<string>;
  /**
   * Selected model identifier.
   */
  model: Ref<string>;
  /**
   * Chosen resolution, or `undefined` to use the model's default.
   */
  resolution: Ref<string | undefined>;
  /**
   * Chosen duration in seconds, or `undefined` to use the model's default.
   */
  duration: Ref<number | undefined>;
  /**
   * The selected model's descriptor, so the view renders only its declared controls.
   */
  selectedModel: Ref<CatalogueModel | undefined>;
  /**
   * Estimated cost of the current form state, and whether it is known at all.
   *
   * Computed in the browser from the catalogue's published prices so it updates as the visitor
   * changes a control, and labelled an estimate wherever it is shown. The server computes the same
   * figure independently and returns it with the accepted job.
   */
  estimate: Ref<AnimateEstimate | undefined>;
  /**
   * Current job state, or `undefined` before anything has been started.
   */
  state: Ref<MediaJobState | undefined>;
  /**
   * Whether a job is in flight, meaning it has been accepted and has not reached a terminal state.
   */
  animating: Ref<boolean>;
  /**
   * Message from the most recent failure, or `null`.
   */
  error: Ref<string | null>;
  /**
   * Why the most recent job failed, or `undefined`.
   *
   * Exposed separately from {@link UseAnimateImageResult.error} so the panel can present a billing
   * failure as the actionable thing it is — an account that needs credit — rather than as one more
   * red box inviting a retry that cannot succeed. Every model in this panel is third-party, so this
   * is the expected outcome on an unfunded account.
   */
  failureReason: Ref<VideoFailureReason | undefined>;
  /**
   * The finished video's metadata, or `undefined` until a job completes.
   */
  video: Ref<StoredVideo | undefined>;
  /**
   * Same-origin URL the player reads the finished video from, or `undefined`.
   */
  videoSource: Ref<string | undefined>;
  /**
   * Receipt of the most recently completed run, or `undefined`.
   */
  receipt: Ref<RunReceipt | undefined>;
  /**
   * Resolved gateway metrics for the most recent run, or `undefined` while unresolved.
   */
  metrics: Ref<RunMetrics | undefined>;
  /**
   * Whether the most recent run's cost is still being polled for.
   */
  costPending: Ref<boolean>;
  /**
   * The controls the server reported applying, or `undefined` before a run.
   */
  applied: Ref<AppliedAnimateImageControls | undefined>;
  /**
   * Whether the panel can be submitted.
   */
  canAnimate: Ref<boolean>;
  /**
   * Prepares and selects a source picture from a file.
   *
   * @param file The picture the visitor chose, dropped, or pasted.
   * @returns A promise fulfilled once the picture has been read and either accepted or refused.
   */
  selectSource: (file: File) => Promise<void>;
  /**
   * Accepts a picture handed over from another panel.
   *
   * @param image The picture Create Image offered.
   * @returns Nothing; the picture becomes the current source, or an error is shown when its type is
   *   one this panel cannot display.
   */
  acceptHandoff: (image: HandoffImage) => void;
  /**
   * Clears the source picture and any result derived from it.
   *
   * @returns Nothing; ignored while a job is in flight, since the still is half of the result
   *   currently being rendered.
   */
  clearSource: () => void;
  /**
   * Starts animating the picture and polls until the job settles.
   *
   * @returns A promise fulfilled once the job has reached a terminal state or the poll budget has
   *   been exhausted.
   */
  animate: () => Promise<void>;
  /**
   * Cancels the job in flight.
   *
   * @returns A promise fulfilled once the job has been terminated and its stored object deleted.
   */
  stop: () => Promise<void>;
}

/**
 * Builds the visitor-facing explanation for a failure classification.
 *
 * The billing case is deliberately the most specific message in this panel, and it is the likely
 * one rather than an edge case: every reviewed image-to-video model is third-party. It is also the
 * one failure a visitor can actually resolve, and the generic "try again" wording is actively
 * misleading for it — retrying without credit fails identically every time.
 *
 * @param reason Why the job failed.
 * @returns The sentence to show.
 */
export function animateFailureMessage(reason: VideoFailureReason): string {
  return reason === 'insufficient-credit'
    ? 'This account has no prepaid AI Gateway credit, so the picture could not be animated. '
        + 'Every image-to-video model is third-party and bills against AI Gateway credits — there is '
        + 'no Cloudflare-hosted model for this task. Add credit to the account, then try again; '
        + 'retrying before then will fail the same way. Nothing was charged for this request, and '
        + 'your picture is still here.'
    : 'The picture could not be animated. The model or the provider reported a failure; nothing '
        + 'was charged for a video you did not receive unless the model had already completed it.';
}

/**
 * Sleeps for a duration.
 *
 * @param ms Milliseconds to wait.
 * @returns A promise fulfilled after the delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Drives the Animate Image panel.
 *
 * @param options Catalogue models and injectable transports; see {@link UseAnimateImageOptions}.
 * @returns The panel's reactive state and actions; see {@link UseAnimateImageResult}.
 */
export function useAnimateImage(options: UseAnimateImageOptions): UseAnimateImageResult {
  const startJob = options.start ?? startAnimation;
  const readStatus = options.status ?? fetchAnimationStatus;
  const cancelJob = options.cancel ?? cancelAnimation;
  const wait = options.wait ?? sleep;
  const now = options.now ?? Date.now;

  const source = shallowRef<PreparedImage | undefined>(undefined);
  const motionPrompt = ref('');
  const negativePrompt = ref('');
  const model = ref('');
  const resolution = ref<string | undefined>(undefined);
  const duration = ref<number | undefined>(undefined);

  const state = ref<MediaJobState | undefined>(undefined);
  const error = ref<string | null>(null);
  const failureReason = ref<VideoFailureReason | undefined>(undefined);
  const video = shallowRef<StoredVideo | undefined>(undefined);
  const videoSource = ref<string | undefined>(undefined);
  const applied = shallowRef<AppliedAnimateImageControls | undefined>(undefined);
  const receipt = shallowRef<RunReceipt | undefined>(undefined);

  const run = useRun(options.runOptions);

  // The run identifier of the job currently being polled. A poll that finds this has changed
  // discards its own result: the visitor has cancelled or started another job, and an older
  // response must not overwrite the newer state.
  const activeRunId = ref<string | undefined>(undefined);

  const selectedModel = computed(() =>
    options.models.value.find((entry) => entry.id === model.value)
  );

  // Settles the selection once the catalogue arrives.
  watch(
    options.models,
    (available) => {
      if (model.value === '' && available.length > 0) {
        model.value = available[0]?.id ?? '';
      }
    },
    { immediate: true }
  );

  // Resets the per-model controls whenever the model changes. Not optional housekeeping here: the
  // two reviewed models share *no* resolution value — `720P` against `768P` — and one takes a
  // duration range while the other accepts exactly two lengths, so carrying a selection across
  // would produce a request the server rightly rejects.
  watch(model, () => {
    resolution.value = undefined;
    duration.value = undefined;
  });

  /**
   * The resolution that will actually be used, falling back to the model's declared default.
   */
  const effectiveResolution = computed(
    () => resolution.value ?? selectedModel.value?.animateImageControls?.defaultResolution
  );

  /**
   * The duration that will actually be used, falling back to the model's declared default.
   */
  const effectiveDuration = computed(
    () => duration.value ?? selectedModel.value?.animateImageControls?.defaultDuration
  );

  const estimate = computed<AnimateEstimate | undefined>(() => {
    const controls = selectedModel.value?.animateImageControls;
    const chosenResolution = effectiveResolution.value;
    const chosenDuration = effectiveDuration.value;
    if (controls === undefined || chosenResolution === undefined || chosenDuration === undefined) {
      return undefined;
    }

    const perSecond = controls.pricePerSecondUsd?.[chosenResolution];
    if (perSecond !== undefined) {
      return { costUsd: perSecond * chosenDuration, known: true };
    }

    // The per-combination shape. A combination the provider has not published is reported as
    // unknown rather than interpolated from the ones it has — mirroring the server's own refusal
    // to invent a rate, so the two never disagree about what is knowable.
    const exact =
      controls.priceByCombinationUsd?.[priceCombinationKey(chosenResolution, chosenDuration)];
    return exact === undefined ? { costUsd: 0, known: false } : { costUsd: exact, known: true };
  });

  const animating = computed(
    () => state.value !== undefined && !isTerminalMediaJobState(state.value)
  );

  const canAnimate = computed(() => {
    const controls = selectedModel.value?.animateImageControls;
    if (source.value === undefined || controls === undefined || animating.value) {
      return false;
    }
    // Enforced in the browser only so the button's state is honest; the server checks the same
    // rule, because one reviewed model genuinely refuses a request without a prompt.
    return !controls.motionPromptRequired || motionPrompt.value.trim() !== '';
  });

  /**
   * Builds the request from the current form state.
   *
   * Only controls the selected model declares are included, and only when the visitor actually set
   * one: sending a control a model does not accept is a `400`, and sending a default the server
   * would have filled in anyway adds nothing.
   *
   * @param runId Run identifier for the new job.
   * @param imageBase64 The prepared picture's bytes, base64-encoded.
   * @returns The request to post.
   */
  function buildRequest(runId: string, imageBase64: string): AnimateImageRequest {
    const controls = selectedModel.value?.animateImageControls;
    const trimmedMotion = motionPrompt.value.trim();
    const trimmedNegative = negativePrompt.value.trim();

    return {
      imageBase64,
      model: model.value,
      runId,
      ...(trimmedMotion === '' ? {} : { motionPrompt: trimmedMotion }),
      ...(controls?.negativePrompt === true && trimmedNegative !== ''
        ? { negativePrompt: trimmedNegative }
        : {}),
      ...(resolution.value === undefined ? {} : { resolution: resolution.value }),
      ...(duration.value === undefined ? {} : { duration: duration.value })
    };
  }

  /**
   * Polls one job until it settles or the budget runs out.
   *
   * @param runId The job to poll.
   * @returns A promise fulfilled once polling has stopped.
   */
  async function poll(runId: string): Promise<void> {
    const startedAtMs = now();
    let interval = MIN_POLL_INTERVAL_MS;

    for (;;) {
      await wait(interval);

      // The visitor cancelled or started another job while this poll was waiting. Returning without
      // writing anything is what keeps a stale response from overwriting current state.
      if (activeRunId.value !== runId) {
        return;
      }

      let status;
      try {
        status = await readStatus(runId);
      } catch (cause) {
        if (activeRunId.value !== runId) {
          return;
        }
        error.value =
          cause instanceof ApiError ? cause.message : 'The animation job could not be checked.';
        state.value = 'failed';
        return;
      }

      if (activeRunId.value !== runId) {
        return;
      }

      state.value = status.state;
      if (status.applied !== undefined) {
        applied.value = status.applied;
      }

      if (status.state === 'completed') {
        video.value = status.video;
        videoSource.value = animationUrl(runId);
        if (status.receipt !== undefined) {
          receipt.value = status.receipt;
          // Awaited rather than fired and forgotten, so the session meter has settled by the time
          // polling stops and the panel reports itself finished.
          await run.trackRun(status.receipt);
        }
        return;
      }

      if (status.state === 'failed') {
        failureReason.value = status.reason ?? 'provider-failure';
        error.value = animateFailureMessage(failureReason.value);
        return;
      }

      if (isTerminalMediaJobState(status.state)) {
        return;
      }

      if (now() - startedAtMs > ANIMATE_POLL_BUDGET_MS) {
        // Honest about what is known: the job was started and its outcome is no longer being
        // watched. Claiming it failed would be a guess, and spinning forever would be worse.
        state.value = 'failed';
        error.value =
          'This job has been running longer than this demo will wait. It may still complete; check the Activity page for its gateway record.';
        return;
      }

      interval = Math.min(Math.round(interval * POLL_BACKOFF_FACTOR), MAX_POLL_INTERVAL_MS);
    }
  }

  return {
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
    metrics: run.metrics,
    costPending: run.costPending,
    applied,
    canAnimate,

    async selectSource(file: File): Promise<void> {
      const prepared = await prepareImage(file);
      if (!prepared.ok) {
        error.value = prepared.message;
        return;
      }
      error.value = null;
      source.value = prepared.image;
      // A new picture invalidates the previous result: the panel's whole layout is a comparison
      // between one still and the video made from it, so showing the old video beside a new
      // still would be claiming a relationship that does not exist.
      video.value = undefined;
      videoSource.value = undefined;
      applied.value = undefined;
      receipt.value = undefined;
      state.value = undefined;
    },

    acceptHandoff(image: HandoffImage): void {
      if (!isAcceptedUploadType(image.mediaType)) {
        error.value = 'That picture is not in a format this panel can display.';
        return;
      }
      source.value = {
        base64: image.base64,
        previewUri: `data:${image.mediaType};base64,${image.base64}`,
        byteLength: image.byteLength,
        fileName: image.origin
      };
      error.value = null;
    },

    clearSource(): void {
      if (animating.value) {
        return;
      }
      source.value = undefined;
      video.value = undefined;
      videoSource.value = undefined;
      applied.value = undefined;
      receipt.value = undefined;
      state.value = undefined;
    },

    async animate(): Promise<void> {
      const picture = source.value;
      if (!canAnimate.value || picture === undefined) {
        return;
      }

      const runId = crypto.randomUUID();
      activeRunId.value = runId;

      error.value = null;
      failureReason.value = undefined;
      video.value = undefined;
      videoSource.value = undefined;
      applied.value = undefined;
      receipt.value = undefined;
      state.value = 'accepted';

      try {
        const accepted = await startJob(buildRequest(runId, picture.base64));
        if (activeRunId.value !== runId) {
          return;
        }
        applied.value = accepted.applied;
        state.value = accepted.state;
      } catch (cause) {
        if (activeRunId.value !== runId) {
          return;
        }
        error.value =
          cause instanceof ApiError ? cause.message : 'The animation job could not be started.';
        state.value = 'failed';
        return;
      }

      await poll(runId);
    },

    async stop(): Promise<void> {
      const runId = activeRunId.value;
      if (runId === undefined || !animating.value) {
        return;
      }

      // Cleared before the request, so an in-flight poll discards itself rather than racing the
      // cancellation and resurrecting a state the visitor has already dismissed.
      activeRunId.value = undefined;

      try {
        await cancelJob(runId);
        state.value = 'cancelled';
      } catch (cause) {
        error.value =
          cause instanceof ApiError ? cause.message : 'The animation job could not be cancelled.';
      }
    }
  };
}
