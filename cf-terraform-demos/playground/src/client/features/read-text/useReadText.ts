/**
 * @file Stateful composable behind the Read Text panel: typing the passage, choosing a voice or a
 *   language depending on which the selected model has, running synthesis, and handing the
 *   completed run to {@link useRun} for cost resolution. The panel's defining complication is that
 *   switching model can invalidate the current selection outright rather than merely re-scaling it.
 *   Aura 1 publishes `angus`; Aura 2 does not. MeloTTS publishes no voices at all and a language
 *   instead. So every control is reset against the newly selected model's own declared lists on
 *   change, and a previous choice is carried over only when the new model actually publishes it —
 *   which is the difference between a helpful default and a request the server will refuse. The
 *   previous audio is kept on screen while a new run is in flight, because a visitor comparing two
 *   voices wants to hear the first one until the second arrives.
 */

import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import {
  estimateSpeechCostUsd,
  MAX_SPEECH_CHARACTERS,
  type AppliedSpeechControls,
  type GeneratedSpeech,
  type ReadTextRequest,
  type SpeechFormatName
} from '../../../shared/read-text';
import type { RunMetrics, RunReceipt } from '../../../shared/runs';
import { useRun, type UseRunOptions } from '../../composables/useRun';
import { ApiError, readText } from '../../services/playground-api';
import type { CatalogueModel } from '../../stores/catalogue';
import type { HandoffText } from '../../stores/handoff';

/**
 * Options for {@link useReadText}.
 */
export interface UseReadTextOptions {
  /**
   * Reviewed models for this panel, as reported by the catalogue. Reactive, because the catalogue
   * is fetched after mount and the form has to settle once it arrives.
   */
  models: Ref<CatalogueModel[]>;
  /**
   * Speech transport, injected so tests drive outcomes directly instead of over HTTP.
   */
  speak?: typeof readText;
  /**
   * Options forwarded to {@link useRun}, so a test can poll without real delays.
   */
  runOptions?: UseRunOptions;
}

/**
 * What the Read Text panel binds to.
 */
export interface UseReadTextResult {
  /**
   * The passage to speak.
   */
  text: Ref<string>;
  /**
   * Selected model identifier.
   */
  model: Ref<string>;
  /**
   * Selected voice, or `undefined` to use the model's declared default.
   */
  voice: Ref<string | undefined>;
  /**
   * Selected language, or `undefined` to use the model's declared default.
   */
  language: Ref<string | undefined>;
  /**
   * Selected output format, or `undefined` to use the model's declared default.
   */
  format: Ref<SpeechFormatName | undefined>;
  /**
   * The selected model's descriptor, so the view can render only its declared controls.
   */
  selectedModel: Ref<CatalogueModel | undefined>;
  /**
   * Whether synthesis is in flight.
   */
  speaking: Ref<boolean>;
  /**
   * Message from the most recent failure, or `null`.
   */
  error: Ref<string | null>;
  /**
   * A note about how the current passage arrived, or `null`.
   *
   * Set when text was handed over from another panel, including whether it had to be shortened.
   * Distinct from `error`, because a truncated handoff is information rather than a failure.
   */
  notice: Ref<string | null>;
  /**
   * The most recent audio, or `undefined` before a run.
   */
  speech: Ref<GeneratedSpeech | undefined>;
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
  applied: Ref<AppliedSpeechControls | undefined>;
  /**
   * How many characters the current passage contains, counted as the server counts them.
   */
  characterCount: Ref<number>;
  /**
   * Estimated cost of running the current passage, or `undefined` when the selected model's billing
   * makes a pre-request estimate impossible.
   */
  estimatedCostUsd: Ref<number | undefined>;
  /**
   * A playable URL for the current audio, or `undefined` before a run.
   */
  audioUri: Ref<string | undefined>;
  /**
   * Whether the panel can be submitted.
   */
  canSpeak: Ref<boolean>;
  /**
   * Accepts text handed over from another panel.
   *
   * @param handoff The text, its provenance, and its language when known.
   * @returns Nothing; the text becomes the current passage.
   */
  acceptHandoff: (handoff: HandoffText) => void;
  /**
   * Speaks the current passage.
   *
   * @returns A promise fulfilled when the run has completed or failed and its cost has been
   *   tracked.
   */
  speak: () => Promise<void>;
  /**
   * Stops waiting for the run in flight.
   *
   * @returns Nothing; the HTTP request is aborted.
   */
  cancel: () => void;
}

/**
 * Drives the Read Text panel.
 *
 * @param options Catalogue models, injectable transport, and run-tracking options; see
 *   {@link UseReadTextOptions}.
 * @returns Reactive form state and actions; see {@link UseReadTextResult}.
 */
export function useReadText(options: UseReadTextOptions): UseReadTextResult {
  const transport = options.speak ?? readText;
  const run = useRun(options.runOptions);

  const text = ref('');
  const model = ref('');
  const voice = ref<string | undefined>(undefined);
  const language = ref<string | undefined>(undefined);
  const format = ref<SpeechFormatName | undefined>(undefined);

  const speaking = ref(false);
  const error = ref<string | null>(null);
  const notice = ref<string | null>(null);
  const speech = shallowRef<GeneratedSpeech | undefined>(undefined);
  const receipt = shallowRef<RunReceipt | undefined>(undefined);
  const applied = shallowRef<AppliedSpeechControls | undefined>(undefined);

  let controller: AbortController | undefined;

  const selectedModel = computed(() =>
    options.models.value.find((candidate) => candidate.id === model.value)
  );

  /**
   * The selected model's declared speech controls, or `undefined` before the catalogue loads.
   */
  const controls = computed(() => selectedModel.value?.speechControls);

  // The first reviewed model becomes the default once the catalogue arrives, so the catalogue's
  // order is the preference order and there is no second list to keep in step with it.
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

  // Switching model re-settles every control against the new model's own declared lists.
  //
  // A carried-over value is kept only when the new model actually publishes it, which is stricter
  // than it looks: the two Aura generations share eight voice names and differ on eight more, so a
  // visitor who picked `angus` on Aura 1 and switched to Aura 2 would otherwise be holding a value
  // that model's schema rejects. Resetting to the new model's default is the only choice that
  // cannot produce a request the server refuses.
  watch(selectedModel, (current) => {
    const support = current?.speechControls;

    const voices = support?.voices;
    voice.value =
      voices !== undefined && voice.value !== undefined && voices.includes(voice.value)
        ? voice.value
        : undefined;

    const languages = support?.languages;
    language.value =
      languages !== undefined && language.value !== undefined && languages.includes(language.value)
        ? language.value
        : undefined;

    const formats = support?.formats;
    format.value =
      formats !== undefined && format.value !== undefined && formats.includes(format.value)
        ? format.value
        : undefined;
  });

  // Counted in code points rather than `String.length`, matching the server's own limit, so an emoji
  // counts once rather than twice and the editor's counter cannot disagree with the validation.
  const characterCount = computed(() => [...text.value.trim()].length);

  const estimatedCostUsd = computed(() =>
    estimateSpeechCostUsd(characterCount.value, controls.value?.pricePerThousandCharactersUsd)
  );

  const canSpeak = computed(
    () =>
      !speaking.value
      && characterCount.value > 0
      && characterCount.value <= MAX_SPEECH_CHARACTERS
      && selectedModel.value !== undefined
  );

  // A `data:` URI rather than a blob URL. The payload is a few hundred kilobytes, so there is no
  // memory argument for a blob, and a blob URL would need revoking on every replacement and on
  // unmount — a leak that only shows up after a visitor has compared a dozen voices.
  const audioUri = computed(() =>
    speech.value === undefined
      ? undefined
      : `data:${speech.value.mediaType};base64,${speech.value.base64}`
  );

  /**
   * Builds the request from the form, including only controls the selected model declares.
   *
   * @param runId Identifier for this run.
   * @returns The request to send.
   */
  function buildRequest(runId: string): ReadTextRequest {
    const support = controls.value;

    return {
      text: text.value.trim(),
      model: model.value,
      runId,
      // Each control is sent only when the model publishes it *and* the visitor chose a value.
      // Omitting it lets the server fill in the model's own documented default, which is the value
      // the panel then reports back as applied.
      ...(support?.voices !== undefined && voice.value !== undefined ? { voice: voice.value } : {}),
      ...(support?.languages !== undefined && language.value !== undefined
        ? { language: language.value }
        : {}),
      ...(support?.formats !== undefined && format.value !== undefined
        ? { format: format.value }
        : {})
    };
  }

  /**
   * Discards the previous run's audio and receipt.
   *
   * Called when text arrives from another panel. Audio left on screen beside a different passage is
   * worse than an empty space: it reads as a recording _of_ the new passage.
   *
   * @returns Nothing.
   */
  function clearResult(): void {
    speech.value = undefined;
    receipt.value = undefined;
    applied.value = undefined;
  }

  return {
    text,
    model,
    voice,
    language,
    format,
    selectedModel,
    speaking,
    error,
    notice,
    speech,
    receipt,
    metrics: run.metrics,
    costPending: run.costPending,
    applied,
    characterCount,
    estimatedCostUsd,
    audioUri,
    canSpeak,
    acceptHandoff: (handoff): void => {
      text.value = handoff.text;
      error.value = null;
      clearResult();

      // Preselected only when the selected model publishes a matching language. The handoff's code
      // comes from another panel's model, which has no obligation to agree with this one's list, so
      // trusting it would stage a value the server rejects.
      const languages = controls.value?.languages;
      if (
        handoff.language !== undefined
        && languages !== undefined
        && languages.includes(handoff.language)
      ) {
        language.value = handoff.language;
      }

      notice.value = handoff.truncated
        ? `${handoff.origin}. The text was longer than this panel can read, so only the first `
          + `${MAX_SPEECH_CHARACTERS.toLocaleString()} characters were carried over.`
        : handoff.origin;
    },
    speak: async (): Promise<void> => {
      if (!canSpeak.value) {
        return;
      }

      const runId = crypto.randomUUID();

      error.value = null;
      speaking.value = true;
      controller = new AbortController();

      try {
        const result = await transport(buildRequest(runId), controller.signal);

        speech.value = result.speech;
        receipt.value = result.receipt;
        applied.value = result.applied;
      } catch (cause) {
        // An abort is the visitor's own Cancel, not a failure, so it leaves no error message.
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          error.value =
            cause instanceof ApiError
              ? cause.message
              : 'The text could not be read aloud. Check your connection and try again.';
        }
      } finally {
        speaking.value = false;
        controller = undefined;
      }

      // Tracked only when a receipt exists. A failed or cancelled run has none and contributes
      // nothing to the session meter.
      if (receipt.value !== undefined) {
        await run.trackRun(receipt.value);
      }
    },
    cancel: (): void => {
      controller?.abort();
    }
  };
}
