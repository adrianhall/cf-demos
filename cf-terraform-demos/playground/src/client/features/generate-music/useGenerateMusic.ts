/**
 * @file Stateful composable behind the Generate Music panel: composing a prompt, choosing whichever
 *   controls the selected model actually has, running generation, and handing the completed run to
 *   {@link useRun} for cost resolution. The panel's defining complication is that switching model
 *   changes **what kind of thing is being bought**, not merely the numbers on a form. One model has
 *   a length control and bills by the second; the other has no length field at all and bills a flat
 *   price per track. So the controls are re-settled against the newly selected model's own
 *   declarations on every change, and a previous choice is carried over only when the new model
 *   actually publishes it — the two format enums share no value, so carrying a format across would
 *   stage a request the provider rejects. Two behaviours are worth stating because they exist for
 *   cost reasons rather than ergonomic ones. **The estimate is reactive and always visible**,
 *   recomputed in the browser from the catalogue's published pricing as the visitor moves a
 *   control, because this panel spends prepaid credit and an estimate discovered after the fact is
 *   no estimate at all. And **cancelling stops the browser waiting, not the provider working**: by
 *   the time a visitor clicks Cancel the track is already being generated and will be billed, so
 *   the panel says so rather than implying the charge was avoided.
 */

import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import {
  describeMusicCostBasis,
  estimateMusicCostUsd,
  MAX_MUSIC_LYRICS_CHARACTERS,
  MAX_MUSIC_PROMPT_CHARACTERS,
  type AppliedMusicControls,
  type GeneratedTrack,
  type GenerateMusicRequest,
  type MusicFailureReason,
  type MusicPricing
} from '../../../shared/generate-music';
import type { RunMetrics, RunReceipt } from '../../../shared/runs';
import { useRun, type UseRunOptions } from '../../composables/useRun';
import { ApiError, generateMusic } from '../../services/playground-api';
import type { CatalogueModel } from '../../stores/catalogue';

/**
 * Options for {@link useGenerateMusic}.
 */
export interface UseGenerateMusicOptions {
  /**
   * Reviewed models for this panel, as reported by the catalogue. Reactive, because the catalogue
   * is fetched after mount and the form has to settle once it arrives.
   */
  models: Ref<CatalogueModel[]>;
  /**
   * Generation transport, injected so tests drive outcomes directly instead of over HTTP.
   */
  compose?: typeof generateMusic;
  /**
   * Options forwarded to {@link useRun}, so a test can poll for cost without real delays.
   */
  runOptions?: UseRunOptions;
}

/**
 * What the Generate Music panel binds to.
 */
export interface UseGenerateMusicResult {
  /**
   * The style prompt being composed.
   */
  prompt: Ref<string>;
  /**
   * Selected model identifier.
   */
  model: Ref<string>;
  /**
   * Whether to generate an instrumental track.
   */
  instrumental: Ref<boolean>;
  /**
   * Lyrics the visitor supplied, for a model that accepts them.
   */
  lyrics: Ref<string>;
  /**
   * Whether to ask the model to write its own lyrics.
   */
  generateLyrics: Ref<boolean>;
  /**
   * Chosen track length in seconds, or `undefined` to use the model's default.
   */
  lengthSeconds: Ref<number | undefined>;
  /**
   * Chosen output format, or `undefined` to use the model's default.
   */
  format: Ref<string | undefined>;
  /**
   * Chosen seed, or `undefined` for none.
   */
  seed: Ref<number | undefined>;
  /**
   * The selected model's descriptor, so the view renders only its declared controls.
   */
  selectedModel: Ref<CatalogueModel | undefined>;
  /**
   * Estimated cost of the current form state, in US dollars.
   *
   * Computed in the browser from the catalogue's published pricing so it updates as the visitor
   * changes a control, and labelled an estimate wherever it is shown. The server computes the same
   * figure independently and returns it with the result, which is the one recorded in the log.
   */
  estimatedCostUsd: Ref<number | undefined>;
  /**
   * One sentence explaining how {@link UseGenerateMusicResult.estimatedCostUsd} was arrived at,
   * naming the billing unit.
   *
   * Separate from the figure because the figure alone is ambiguous on this panel: `$0.15` means
   * something different for a per-track model than for a per-second one, and the whole lesson is
   * that the two are not comparable.
   */
  costBasis: Ref<string | undefined>;
  /**
   * The billing unit of the selected model, so the panel can label a figure without inspecting the
   * pricing union itself.
   */
  pricingUnit: Ref<MusicPricing['unit'] | undefined>;
  /**
   * Whether generation is in flight.
   */
  generating: Ref<boolean>;
  /**
   * Message from the most recent failure, or `null`.
   */
  error: Ref<string | null>;
  /**
   * Why the most recent run failed, or `undefined`.
   *
   * Exposed separately from {@link UseGenerateMusicResult.error} so the panel can present a billing
   * failure as the actionable thing it is — an account that needs credit — rather than as one more
   * red box inviting a retry that cannot succeed. Every model in this panel is third-party, so this
   * is the first thing an unfunded account will see.
   */
  failureReason: Ref<MusicFailureReason | undefined>;
  /**
   * The most recent track, or `undefined` before a run.
   */
  track: Ref<GeneratedTrack | undefined>;
  /**
   * A playable URL for the current track, or `undefined` before a run.
   */
  audioUri: Ref<string | undefined>;
  /**
   * The lyrics the finished track was sung from, or `undefined`.
   *
   * Held separately from the editable {@link UseGenerateMusicResult.lyrics} field so the words shown
   * beside a player are the ones that run was given, rather than whatever the form says now.
   */
  renderedLyrics: Ref<string | undefined>;
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
  applied: Ref<AppliedMusicControls | undefined>;
  /**
   * How many characters the current prompt contains, counted as the server counts them.
   */
  promptCharacterCount: Ref<number>;
  /**
   * How many characters of lyrics the visitor has written.
   */
  lyricsCharacterCount: Ref<number>;
  /**
   * The reason the panel cannot be submitted, or `undefined` when it can.
   *
   * A sentence rather than a boolean, because this panel has refusals a visitor would not otherwise
   * understand: one model will not sing without words, and supplying lyrics while also asking the
   * model to write them is a request with two answers. Saying why the button is disabled is the
   * difference between a form that teaches the contract and one that merely enforces it.
   */
  blockedReason: Ref<string | undefined>;
  /**
   * Whether the panel can be submitted.
   */
  canGenerate: Ref<boolean>;
  /**
   * Generates a track from the current form state.
   *
   * @returns A promise fulfilled once the run has completed or failed and its cost has been
   *   tracked.
   */
  generate: () => Promise<void>;
  /**
   * Stops waiting for the run in flight.
   *
   * @returns Nothing; the HTTP request is aborted. The provider's work is not cancelled and has
   *   already been charged for, which the panel states rather than implying otherwise.
   */
  cancel: () => void;
}

/**
 * Builds the visitor-facing explanation for a failure classification.
 *
 * The billing case is deliberately the most specific message in this panel, as it is in Create
 * Video. It is the one failure a visitor can actually resolve, and the generic "try again" wording
 * is actively misleading for it — retrying without credit fails identically every time.
 *
 * @param reason Why the run failed.
 * @returns The sentence to show.
 */
export function musicFailureMessage(reason: MusicFailureReason): string {
  return reason === 'insufficient-credit'
    ? 'This account has no prepaid AI Gateway credit, so no track could be generated. Every music '
        + 'model in this panel is third-party and bills against AI Gateway credits — there is no '
        + 'Cloudflare-hosted music model to fall back on. Add credit to the account, then try again; '
        + 'retrying before then will fail the same way. Nothing was charged for this request.'
    : 'The track could not be generated. The model or the provider reported a failure. Trying '
        + 'again may work.';
}

/**
 * Drives the Generate Music panel.
 *
 * @param options Catalogue models, injectable transport, and run-tracking options; see
 *   {@link UseGenerateMusicOptions}.
 * @returns Reactive form state and actions; see {@link UseGenerateMusicResult}.
 */
export function useGenerateMusic(options: UseGenerateMusicOptions): UseGenerateMusicResult {
  const transport = options.compose ?? generateMusic;
  const run = useRun(options.runOptions);

  const prompt = ref('');
  const model = ref('');
  const instrumental = ref(true);
  const lyrics = ref('');
  const generateLyrics = ref(false);
  const lengthSeconds = ref<number | undefined>(undefined);
  const format = ref<string | undefined>(undefined);
  const seed = ref<number | undefined>(undefined);

  const generating = ref(false);
  const error = ref<string | null>(null);
  const failureReason = ref<MusicFailureReason | undefined>(undefined);
  const track = shallowRef<GeneratedTrack | undefined>(undefined);
  const renderedLyrics = ref<string | undefined>(undefined);
  const receipt = shallowRef<RunReceipt | undefined>(undefined);
  const applied = shallowRef<AppliedMusicControls | undefined>(undefined);

  let controller: AbortController | undefined;

  const selectedModel = computed(() =>
    options.models.value.find((candidate) => candidate.id === model.value)
  );

  /**
   * The selected model's declared music controls, or `undefined` before the catalogue loads.
   */
  const controls = computed(() => selectedModel.value?.musicControls);

  // The first reviewed model becomes the default once the catalogue arrives, so the catalogue's
  // order is the preference order and there is no second list to keep in step with it. The
  // catalogue puts the cheap per-second model first deliberately.
  watch(
    options.models,
    (available) => {
      const first = available[0];
      if (model.value === '' && first !== undefined) {
        model.value = first.id;
      }
    },
    { immediate: true }
  );

  // Switching model re-settles every control against the new model's own declarations. A carried-over
  // value is kept only when the new model actually publishes it, which is stricter than it looks:
  // the two reviewed format enums share no value at all, so a format carried across would be a
  // request the provider refuses. The lyrics-writing flag is cleared outright for a model that
  // cannot write lyrics, because it is a separately billed capability rather than a preference.
  watch(selectedModel, (current) => {
    const support = current?.musicControls;

    const formats = support?.formats;
    format.value =
      formats !== undefined && format.value !== undefined && formats.includes(format.value)
        ? format.value
        : undefined;

    // Reset rather than clamped. A length valid for one model is not merely out of range for a
    // model with no length control — the field does not exist there, and the server refuses it.
    const range = support?.lengthSeconds;
    lengthSeconds.value =
      range !== undefined
      && lengthSeconds.value !== undefined
      && lengthSeconds.value >= range.min
      && lengthSeconds.value <= range.max
        ? lengthSeconds.value
        : undefined;

    if (support?.lyrics !== 'optional') {
      lyrics.value = '';
      generateLyrics.value = false;
    }
    if (support?.lyricsOptimizerParameterName === undefined) {
      generateLyrics.value = false;
    }
    if (support?.seed !== true) {
      seed.value = undefined;
    }
  });

  // Counted in code points rather than `String.length`, matching the server's own limits, so an
  // emoji counts once rather than twice and the editor's counter cannot disagree with validation.
  const promptCharacterCount = computed(() => [...prompt.value.trim()].length);
  const lyricsCharacterCount = computed(() => [...lyrics.value.trim()].length);

  /**
   * The length that will actually be used, falling back to the model's declared default.
   */
  const effectiveLength = computed(
    () => lengthSeconds.value ?? controls.value?.lengthSeconds?.default
  );

  const estimatedCostUsd = computed(() => {
    const pricing = controls.value?.pricing;
    return pricing === undefined
      ? undefined
      : estimateMusicCostUsd(pricing, effectiveLength.value, generateLyrics.value);
  });

  const costBasis = computed(() => {
    const pricing = controls.value?.pricing;
    return pricing === undefined
      ? undefined
      : describeMusicCostBasis(pricing, effectiveLength.value, generateLyrics.value);
  });

  const pricingUnit = computed(() => controls.value?.pricing.unit);

  const blockedReason = computed<string | undefined>(() => {
    if (selectedModel.value === undefined) {
      return 'Waiting for the model catalogue.';
    }
    if (promptCharacterCount.value === 0) {
      return 'Describe the music you want.';
    }
    if (promptCharacterCount.value > MAX_MUSIC_PROMPT_CHARACTERS) {
      return `Shorten the prompt to ${MAX_MUSIC_PROMPT_CHARACTERS.toLocaleString()} characters or fewer.`;
    }
    if (lyricsCharacterCount.value > MAX_MUSIC_LYRICS_CHARACTERS) {
      return `Shorten the lyrics to ${MAX_MUSIC_LYRICS_CHARACTERS.toLocaleString()} characters or fewer.`;
    }
    if (instrumental.value && lyricsCharacterCount.value > 0) {
      return 'An instrumental track has no vocals. Turn off "Instrumental", or clear the lyrics.';
    }
    if (instrumental.value && generateLyrics.value) {
      return 'An instrumental track has no vocals, so there are no lyrics to write.';
    }
    if (lyricsCharacterCount.value > 0 && generateLyrics.value) {
      return (
        'Choose one: write the lyrics yourself, or let the model write them. Generated lyrics '
        + 'are charged for separately.'
      );
    }
    // Mirrored from the descriptor rather than hardcoded for one model, so the refusal is published
    // data. It is checked here as well as on the server so the visitor is told before spending,
    // which on a per-track model is the difference between a free refusal and fifteen cents.
    if (
      controls.value?.requiresLyricsForVocals === true
      && !instrumental.value
      && lyricsCharacterCount.value === 0
      && !generateLyrics.value
    ) {
      return (
        `${selectedModel.value.name} will not sing without words. Write some lyrics, let the `
        + 'model write them, or make the track instrumental.'
      );
    }
    return undefined;
  });

  const canGenerate = computed(() => !generating.value && blockedReason.value === undefined);

  // A `data:` URI rather than a blob URL, as in Read Text. The payload is a few megabytes at most,
  // so there is no memory argument for a blob, and a blob URL would need revoking on every
  // replacement and on unmount — a leak that only shows up after a visitor has compared several
  // tracks.
  const audioUri = computed(() =>
    track.value === undefined
      ? undefined
      : `data:${track.value.mediaType};base64,${track.value.base64}`
  );

  /**
   * Builds the request from the current form state.
   *
   * Only controls the selected model declares are included, and only when the visitor actually set
   * one: sending a control a model does not accept is a `400`, and sending a default the server
   * would have filled in anyway adds nothing to the request while adding something to the log.
   *
   * @param runId Run identifier for this generation.
   * @returns The request to post.
   */
  function buildRequest(runId: string): GenerateMusicRequest {
    const support = controls.value;
    const trimmedLyrics = lyrics.value.trim();

    return {
      prompt: prompt.value.trim(),
      model: model.value,
      runId,
      instrumental: instrumental.value,
      ...(support?.lyrics === 'optional' && trimmedLyrics !== '' ? { lyrics: trimmedLyrics } : {}),
      ...(support?.lyricsOptimizerParameterName !== undefined && generateLyrics.value
        ? { generateLyrics: true }
        : {}),
      ...(support?.lengthSeconds !== undefined && lengthSeconds.value !== undefined
        ? { lengthSeconds: lengthSeconds.value }
        : {}),
      ...(format.value === undefined ? {} : { format: format.value }),
      ...(support?.seed === true && seed.value !== undefined ? { seed: seed.value } : {})
    };
  }

  return {
    prompt,
    model,
    instrumental,
    lyrics,
    generateLyrics,
    lengthSeconds,
    format,
    seed,
    selectedModel,
    estimatedCostUsd,
    costBasis,
    pricingUnit,
    generating,
    error,
    failureReason,
    track,
    audioUri,
    renderedLyrics,
    receipt,
    metrics: run.metrics,
    costPending: run.costPending,
    applied,
    promptCharacterCount,
    lyricsCharacterCount,
    blockedReason,
    canGenerate,

    generate: async (): Promise<void> => {
      if (!canGenerate.value) {
        return;
      }

      const runId = crypto.randomUUID();
      // Captured before the request, so the words shown beside the finished player are the ones
      // this run was given rather than whatever the form says by the time it returns.
      const submittedLyrics = lyrics.value.trim();

      error.value = null;
      failureReason.value = undefined;
      generating.value = true;
      controller = new AbortController();

      try {
        const result = await transport(buildRequest(runId), controller.signal);

        track.value = result.track;
        receipt.value = result.receipt;
        applied.value = result.applied;
        renderedLyrics.value =
          result.applied.lyricsSource === 'caller' && submittedLyrics !== ''
            ? submittedLyrics
            : undefined;
      } catch (cause) {
        // An abort is the visitor's own Cancel, not a failure, so it leaves no error message.
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          if (cause instanceof ApiError && cause.status === 503) {
            // The gateway's billing failure, which the Worker turns into a `503` in exactly one
            // place. Reading the status rather than matching the message keeps this classification
            // structural: the server's wording is not a contract, and its status is.
            failureReason.value = 'insufficient-credit';
            error.value = musicFailureMessage('insufficient-credit');
          } else {
            failureReason.value = 'provider-failure';
            error.value =
              cause instanceof ApiError
                ? cause.message
                : 'The track could not be generated. Check your connection and try again.';
          }
        }
      } finally {
        generating.value = false;
        controller = undefined;
      }

      // Tracked only when a receipt exists. A failed or cancelled run has none and contributes
      // nothing to the session meter — which is correct for a refused request and is why the
      // billing-failure message says nothing was charged.
      if (receipt.value !== undefined) {
        await run.trackRun(receipt.value);
      }
    },

    cancel: (): void => {
      controller?.abort();
    }
  };
}
