/**
 * @file Stateful composable behind the Create Video panel: composing a request, starting a durable
 *   job, polling it, cancelling it, and handing a finished run to {@link useRun} for cost
 *   resolution. Every other panel's composable awaits one request and renders its answer. This one
 *   cannot: the answer arrives minutes later, from a different endpoint, and the visitor may close
 *   the tab in between. Three behaviours follow, and each is a deliberate choice rather than an
 *   implementation detail. **Polling backs off, and stops.** The interval grows from one second
 *   towards fifteen, because a render takes minutes and a fixed one-second poll would make hundreds
 *   of pointless requests. It also has a hard ceiling on total elapsed time, so a job the platform
 *   has lost cannot leave the UI spinning forever — the panel says so instead. **A late poll is
 *   discarded.** Cancellation and a slow in-flight status response race each other, so every poll
 *   checks that it still belongs to the current run before it writes anything. Without that,
 *   cancelling a job then starting another could let the first job's response overwrite the
 *   second's state. **Cancelling is not the same as forgetting.** Cancel terminates the job and
 *   deletes what it stored, which is a real state worth showing, rather than quietly resetting the
 *   form.
 */

import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import type {
  AppliedVideoControls,
  CreateVideoRequest,
  MediaJobState,
  StoredVideo
} from '../../../shared/create-video';
import { isTerminalMediaJobState, MAX_VIDEO_PROMPT_CHARACTERS } from '../../../shared/create-video';
import type { RunMetrics, RunReceipt } from '../../../shared/runs';
import { useRun, type UseRunOptions } from '../../composables/useRun';
import {
  ApiError,
  cancelVideo,
  fetchVideoStatus,
  startVideo,
  videoUrl
} from '../../services/playground-api';
import type { CatalogueModel } from '../../stores/catalogue';

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
 * something has gone wrong that the Workflow itself did not report. Twenty minutes is past the
 * point where any reviewed model should still be working.
 */
export const POLL_BUDGET_MS = 20 * 60 * 1_000;

/**
 * Options for {@link useCreateVideo}.
 */
export interface UseCreateVideoOptions {
  /**
   * Reviewed models for this panel, as reported by the catalogue. Reactive, because the catalogue
   * is fetched after mount and the form has to settle once it arrives.
   */
  models: Ref<CatalogueModel[]>;
  /**
   * Job-start transport, injected so tests drive outcomes directly instead of over HTTP.
   */
  start?: typeof startVideo;
  /**
   * Status transport, injected for the same reason.
   */
  status?: typeof fetchVideoStatus;
  /**
   * Cancellation transport, injected for the same reason.
   */
  cancel?: typeof cancelVideo;
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
 * What the Create Video panel binds to.
 */
export interface UseCreateVideoResult {
  /**
   * The prompt being composed.
   */
  prompt: Ref<string>;
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
   * Chosen aspect ratio, or `undefined` to use the model's default.
   */
  aspectRatio: Ref<string | undefined>;
  /**
   * Chosen duration in seconds, or `undefined` to use the model's default.
   */
  duration: Ref<number | undefined>;
  /**
   * Whether to generate audio, for a model that can.
   */
  generateAudio: Ref<boolean | undefined>;
  /**
   * The selected model's descriptor, so the view renders only its declared controls.
   */
  selectedModel: Ref<CatalogueModel | undefined>;
  /**
   * Estimated cost of the current form state, in US dollars.
   *
   * Computed in the browser from the catalogue's published price list so it updates as the visitor
   * changes a control, and labelled an estimate wherever it is shown. The server computes the same
   * figure independently and returns it with the accepted job, which is the one recorded in the
   * log.
   */
  estimatedCostUsd: Ref<number | undefined>;
  /**
   * Current job state, or `undefined` before anything has been started.
   */
  state: Ref<MediaJobState | undefined>;
  /**
   * Whether a job is in flight, meaning it has been accepted and has not reached a terminal state.
   */
  generating: Ref<boolean>;
  /**
   * Message from the most recent failure, or `null`.
   */
  error: Ref<string | null>;
  /**
   * The finished video's metadata, or `undefined` until a job completes.
   */
  video: Ref<StoredVideo | undefined>;
  /**
   * Same-origin URL the player reads the finished video from, or `undefined`.
   */
  source: Ref<string | undefined>;
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
  applied: Ref<AppliedVideoControls | undefined>;
  /**
   * Whether the panel can be submitted.
   */
  canGenerate: Ref<boolean>;
  /**
   * Starts generating a video and polls until the job settles.
   *
   * @returns A promise fulfilled once the job has reached a terminal state or the poll budget has
   *   been exhausted.
   */
  generate: () => Promise<void>;
  /**
   * Cancels the job in flight.
   *
   * @returns A promise fulfilled once the job has been terminated and its stored object deleted.
   */
  stop: () => Promise<void>;
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
 * Drives the Create Video panel.
 *
 * @param options Catalogue models and injectable transports; see {@link UseCreateVideoOptions}.
 * @returns The panel's reactive state and actions; see {@link UseCreateVideoResult}.
 */
export function useCreateVideo(options: UseCreateVideoOptions): UseCreateVideoResult {
  const startJob = options.start ?? startVideo;
  const readStatus = options.status ?? fetchVideoStatus;
  const cancelJob = options.cancel ?? cancelVideo;
  const wait = options.wait ?? sleep;
  const now = options.now ?? Date.now;

  const prompt = ref('');
  const negativePrompt = ref('');
  const model = ref('');
  const resolution = ref<string | undefined>(undefined);
  const aspectRatio = ref<string | undefined>(undefined);
  const duration = ref<number | undefined>(undefined);
  const generateAudio = ref<boolean | undefined>(undefined);

  const state = ref<MediaJobState | undefined>(undefined);
  const error = ref<string | null>(null);
  const video = shallowRef<StoredVideo | undefined>(undefined);
  const source = ref<string | undefined>(undefined);
  const applied = shallowRef<AppliedVideoControls | undefined>(undefined);
  const receipt = shallowRef<RunReceipt | undefined>(undefined);

  const run = useRun(options.runOptions);

  // The run identifier of the job currently being polled. A poll that finds this has changed
  // discards its own result: the visitor has cancelled or started another job, and an older
  // response must not overwrite the newer state.
  const activeRunId = ref<string | undefined>(undefined);

  const selectedModel = computed(() =>
    options.models.value.find((entry) => entry.id === model.value)
  );

  // Settles the selection once the catalogue arrives, and resets the per-model controls whenever the
  // model changes — a resolution valid for one model is often not even spelled the same way for
  // another, so carrying it across would produce a request the server rightly rejects.
  watch(
    options.models,
    (available) => {
      if (model.value === '' && available.length > 0) {
        model.value = available[0]?.id ?? '';
      }
    },
    { immediate: true }
  );

  watch(model, () => {
    resolution.value = undefined;
    aspectRatio.value = undefined;
    duration.value = undefined;
    generateAudio.value = undefined;
  });

  /**
   * The resolution that will actually be used, falling back to the model's declared default.
   */
  const effectiveResolution = computed(
    () => resolution.value ?? selectedModel.value?.videoControls?.defaultResolution
  );

  /**
   * The duration that will actually be used, falling back to the model's declared default.
   */
  const effectiveDuration = computed(
    () => duration.value ?? selectedModel.value?.videoControls?.defaultDuration
  );

  const estimatedCostUsd = computed(() => {
    const controls = selectedModel.value?.videoControls;
    const chosenResolution = effectiveResolution.value;
    const chosenDuration = effectiveDuration.value;
    if (controls === undefined || chosenResolution === undefined || chosenDuration === undefined) {
      return undefined;
    }
    const perSecond = controls.pricePerSecondUsd[chosenResolution];
    return perSecond === undefined ? undefined : perSecond * chosenDuration;
  });

  const generating = computed(
    () => state.value !== undefined && !isTerminalMediaJobState(state.value)
  );

  const canGenerate = computed(
    () =>
      prompt.value.trim() !== ''
      && prompt.value.trim().length <= MAX_VIDEO_PROMPT_CHARACTERS
      && selectedModel.value !== undefined
      && !generating.value
  );

  /**
   * Builds the request from the current form state.
   *
   * Only controls the selected model declares are included, and only when the visitor actually set
   * one: sending a control a model does not accept is a `400`, and sending a default the server
   * would have filled in anyway adds nothing.
   *
   * @param runId Run identifier for the new job.
   * @returns The request to post.
   */
  function buildRequest(runId: string): CreateVideoRequest {
    const controls = selectedModel.value?.videoControls;
    const trimmedNegative = negativePrompt.value.trim();

    return {
      prompt: prompt.value.trim(),
      model: model.value,
      runId,
      ...(controls?.negativePrompt === true && trimmedNegative !== ''
        ? { negativePrompt: trimmedNegative }
        : {}),
      ...(resolution.value === undefined ? {} : { resolution: resolution.value }),
      ...(aspectRatio.value === undefined ? {} : { aspectRatio: aspectRatio.value }),
      ...(duration.value === undefined ? {} : { duration: duration.value }),
      ...(controls?.audioParameterName !== undefined && generateAudio.value !== undefined
        ? { generateAudio: generateAudio.value }
        : {})
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
          cause instanceof ApiError ? cause.message : 'The video job could not be checked.';
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
        source.value = videoUrl(runId);
        if (status.receipt !== undefined) {
          receipt.value = status.receipt;
          // Awaited rather than fired and forgotten, so the session meter has settled by the time
          // polling stops and the panel reports itself finished.
          await run.trackRun(status.receipt);
        }
        return;
      }

      if (status.state === 'failed') {
        error.value = status.error ?? 'The video could not be generated.';
        return;
      }

      if (isTerminalMediaJobState(status.state)) {
        return;
      }

      if (now() - startedAtMs > POLL_BUDGET_MS) {
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
    metrics: run.metrics,
    costPending: run.costPending,
    applied,
    canGenerate,

    async generate(): Promise<void> {
      if (!canGenerate.value) {
        return;
      }

      const runId = crypto.randomUUID();
      activeRunId.value = runId;

      error.value = null;
      video.value = undefined;
      source.value = undefined;
      applied.value = undefined;
      receipt.value = undefined;
      state.value = 'accepted';

      try {
        const accepted = await startJob(buildRequest(runId));
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
          cause instanceof ApiError ? cause.message : 'The video job could not be started.';
        state.value = 'failed';
        return;
      }

      await poll(runId);
    },

    async stop(): Promise<void> {
      const runId = activeRunId.value;
      if (runId === undefined || !generating.value) {
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
          cause instanceof ApiError ? cause.message : 'The video job could not be cancelled.';
      }
    }
  };
}
