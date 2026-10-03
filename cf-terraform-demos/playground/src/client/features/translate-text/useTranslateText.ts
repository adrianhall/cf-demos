/**
 * @file Stateful composable behind the Translate Text panel: the source text, the language pair,
 *   the swap action, running the translation, handing the result to {@link useRun} for cost
 *   resolution, and offering it to Read Text. Two things here are specific to this panel.
 *   **Swapping is only possible for one of the reviewed models.** M2M100 translates in both
 *   directions, so swapping means exchanging two selected codes. IndicTrans2 translates from
 *   English only and has no source control at all, so there is nothing to exchange — the action is
 *   reported as unavailable rather than rendered and left inert. Swapping also carries the
 *   _translation_ into the source box when there is one, because that is what a visitor checking a
 *   translation back into its original language actually wants. **The panel predicts how many paid
 *   calls a passage will make.** Both reviewed models bill per token, which cannot be known before
 *   the model tokenises the text, so no currency figure is honest in advance. The _call count_ is
 *   known exactly, and it is the number that surprises people: the same twelve-line passage is one
 *   charge on a batching model and twelve on the other. That prediction uses the shared helper so
 *   the browser's figure and the server's actual count come from one implementation.
 */

import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import type { RunMetrics, RunReceipt } from '../../../shared/runs';
import {
  countTranslatableLines,
  MAX_TRANSLATION_CHARACTERS,
  MAX_TRANSLATION_SEGMENTS,
  predictInferenceCallCount,
  type AppliedTranslationControls,
  type TranslateTextRequest,
  type Translation,
  type TranslationLanguage
} from '../../../shared/translate-text';
import { useRun, type UseRunOptions } from '../../composables/useRun';
import { ApiError, translateText } from '../../services/playground-api';
import type { CatalogueModel } from '../../stores/catalogue';

/**
 * Options for {@link useTranslateText}.
 */
export interface UseTranslateTextOptions {
  /**
   * Reviewed models for this panel, as reported by the catalogue. Reactive, because the catalogue
   * is fetched after mount and the form has to settle once it arrives.
   */
  models: Ref<CatalogueModel[]>;
  /**
   * Translation transport, injected so tests drive outcomes directly instead of over HTTP.
   */
  translate?: typeof translateText;
  /**
   * Options forwarded to {@link useRun}, so a test can poll without real delays.
   */
  runOptions?: UseRunOptions;
}

/**
 * What the Translate Text panel binds to.
 */
export interface UseTranslateTextResult {
  /**
   * The source text, with whatever line structure the visitor gave it.
   */
  text: Ref<string>;
  /**
   * Selected model identifier.
   */
  model: Ref<string>;
  /**
   * Selected source language, or `undefined` for a model whose source is fixed.
   */
  sourceLanguage: Ref<string | undefined>;
  /**
   * Selected target language.
   */
  targetLanguage: Ref<string>;
  /**
   * The selected model's descriptor, so the view can render only its declared controls.
   */
  selectedModel: Ref<CatalogueModel | undefined>;
  /**
   * Source languages the selected model offers, empty for a fixed-source model.
   */
  sourceLanguages: Ref<readonly TranslationLanguage[]>;
  /**
   * Target languages the selected model offers.
   */
  targetLanguages: Ref<readonly TranslationLanguage[]>;
  /**
   * The language a fixed-source model always translates from, or `undefined`.
   */
  fixedSourceLanguage: Ref<TranslationLanguage | undefined>;
  /**
   * Whether the source and target can be exchanged.
   *
   * False for a model with no source control — there is nothing to exchange — and false when the
   * target is not also an accepted source, which cannot happen for the reviewed models but would
   * for a model whose two lists differ.
   */
  canSwap: Ref<boolean>;
  /**
   * How many lines of the current text would be sent to a model.
   */
  translatableLineCount: Ref<number>;
  /**
   * How many billed gateway calls the current text would make.
   */
  predictedCallCount: Ref<number>;
  /**
   * Whether a translation is in flight.
   */
  translating: Ref<boolean>;
  /**
   * Message from the most recent failure, or `null`.
   */
  error: Ref<string | null>;
  /**
   * The most recent translation, or `undefined` before a run.
   */
  translation: Ref<Translation | undefined>;
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
  applied: Ref<AppliedTranslationControls | undefined>;
  /**
   * Whether the panel can be submitted.
   */
  canTranslate: Ref<boolean>;
  /**
   * Why the panel cannot be submitted, or `null` when it can.
   *
   * Stated rather than left to a disabled button, because two of the reasons — too many lines, and
   * identical languages — are not obvious from looking at the form.
   */
  blockedReason: Ref<string | null>;
  /**
   * Exchanges the source and target languages.
   *
   * @returns Nothing; the languages are exchanged and any existing translation moves into the
   *   source box.
   */
  swap: () => void;
  /**
   * Translates the current text.
   *
   * @returns A promise fulfilled when the run has completed or failed and its cost has been
   *   tracked.
   */
  run: () => Promise<void>;
  /**
   * Stops waiting for the run in flight.
   *
   * @returns Nothing; the HTTP request is aborted.
   */
  cancel: () => void;
}

/**
 * Drives the Translate Text panel.
 *
 * @param options Catalogue models, injectable transport, and run-tracking options; see
 *   {@link UseTranslateTextOptions}.
 * @returns Reactive form state and actions; see {@link UseTranslateTextResult}.
 */
export function useTranslateText(options: UseTranslateTextOptions): UseTranslateTextResult {
  const transport = options.translate ?? translateText;
  const runTracker = useRun(options.runOptions);

  const text = ref('');
  const model = ref('');
  const sourceLanguage = ref<string | undefined>(undefined);
  const targetLanguage = ref('');

  const translating = ref(false);
  const error = ref<string | null>(null);
  const translation = shallowRef<Translation | undefined>(undefined);
  const receipt = shallowRef<RunReceipt | undefined>(undefined);
  const applied = shallowRef<AppliedTranslationControls | undefined>(undefined);

  let controller: AbortController | undefined;

  const selectedModel = computed(() =>
    options.models.value.find((candidate) => candidate.id === model.value)
  );

  /**
   * The selected model's declared translation controls, or `undefined` before the catalogue loads.
   */
  const controls = computed(() => selectedModel.value?.translationControls);

  const sourceLanguages = computed(() => controls.value?.sourceLanguages ?? []);
  const targetLanguages = computed(() => controls.value?.targetLanguages ?? []);
  const fixedSourceLanguage = computed(() => controls.value?.fixedSourceLanguage);

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

  // Switching model re-settles both languages against the new model's declared lists.
  //
  // A carried-over code would usually be invalid here rather than merely unusual: the two reviewed
  // models use different standards, so `hi` and `hin_Deva` name the same language and neither model
  // accepts the other's spelling. Keeping a value only when the new model declares it means the
  // form is always in a state the server would accept.
  //
  // `immediate` because the model watcher above has already chosen a model by the time this runs,
  // so the languages must settle in the same tick. Without it there is a window — the first paint
  // after the catalogue loads — in which a model is selected but its default languages are not,
  // leaving the target selector empty and the Translate button inert for no visible reason.
  watch(
    selectedModel,
    (current) => {
      const support = current?.translationControls;
      if (support === undefined) {
        return;
      }

      const sources = support.sourceLanguages;
      if (sources === undefined) {
        // A fixed-source model has no source control, so any selection is discarded rather than
        // retained invisibly and sent on the next model switch.
        sourceLanguage.value = undefined;
      } else {
        const kept =
          sourceLanguage.value !== undefined
          && sources.some((language) => language.code === sourceLanguage.value);
        sourceLanguage.value = kept ? sourceLanguage.value : support.defaultSourceLanguage;
      }

      const keptTarget = support.targetLanguages.some(
        (language) => language.code === targetLanguage.value
      );
      targetLanguage.value = keptTarget ? targetLanguage.value : support.defaultTargetLanguage;
    },
    { immediate: true }
  );

  const translatableLineCount = computed(() => countTranslatableLines(text.value));

  const predictedCallCount = computed(() =>
    // Shared with the server so the figure quoted before the request is the one the run will
    // actually make. A second implementation here would be a number that drifts.
    predictInferenceCallCount(text.value, controls.value?.batchesSegments ?? false)
  );

  /**
   * The source language in force, including a fixed-source model's own.
   *
   * Needed because the same-language check has to work for both model families, and only one of
   * them has a control the visitor could have set.
   */
  const effectiveSourceLanguage = computed(
    () =>
      sourceLanguage.value
      ?? controls.value?.defaultSourceLanguage
      ?? controls.value?.fixedSourceLanguage?.code
  );

  const canSwap = computed(() => {
    const support = controls.value;
    if (support?.sourceLanguages === undefined) {
      return false;
    }

    // Both directions have to be legal, not just the one being left. For the reviewed models the
    // source and target lists are the same object, but a model declaring different lists would
    // otherwise offer a swap that produced an invalid pair.
    return (
      support.sourceLanguages.some((language) => language.code === targetLanguage.value)
      && support.targetLanguages.some((language) => language.code === effectiveSourceLanguage.value)
    );
  });

  const characterCount = computed(() => [...text.value].length);

  const blockedReason = computed(() => {
    if (text.value.trim() === '') {
      return null;
    }

    if (characterCount.value > MAX_TRANSLATION_CHARACTERS) {
      return (
        `That text is ${characterCount.value.toLocaleString()} characters, and this panel `
        + `translates up to ${MAX_TRANSLATION_CHARACTERS.toLocaleString()}.`
      );
    }

    // The limit a visitor is most likely to hit without understanding why, so the reason names the
    // per-line billing that makes it necessary.
    if (translatableLineCount.value > MAX_TRANSLATION_SEGMENTS) {
      return (
        `That text has ${translatableLineCount.value} lines, and this panel translates up to `
        + `${MAX_TRANSLATION_SEGMENTS} at a time. Some models translate each line as a separate `
        + 'paid request, so the limit is on lines rather than length.'
      );
    }

    if (
      effectiveSourceLanguage.value !== undefined
      && effectiveSourceLanguage.value === targetLanguage.value
    ) {
      return 'The source and target languages are the same, so there is nothing to translate.';
    }

    return null;
  });

  const canTranslate = computed(
    () =>
      !translating.value
      && text.value.trim() !== ''
      && targetLanguage.value !== ''
      && selectedModel.value !== undefined
      && blockedReason.value === null
  );

  return {
    text,
    model,
    sourceLanguage,
    targetLanguage,
    selectedModel,
    sourceLanguages,
    targetLanguages,
    fixedSourceLanguage,
    canSwap,
    translatableLineCount,
    predictedCallCount,
    translating,
    error,
    translation,
    receipt,
    metrics: runTracker.metrics,
    costPending: runTracker.costPending,
    applied,
    canTranslate,
    blockedReason,
    swap: (): void => {
      if (!canSwap.value) {
        return;
      }

      const previousSource = effectiveSourceLanguage.value;
      sourceLanguage.value = targetLanguage.value;
      if (previousSource !== undefined) {
        targetLanguage.value = previousSource;
      }

      // The translation becomes the new source when there is one. Swapping is overwhelmingly done
      // to check a translation back the other way, and leaving the original text in place would
      // mean the visitor has to copy the result across by hand to do the obvious next thing.
      const produced = translation.value;
      if (produced !== undefined) {
        text.value = produced.text;
        translation.value = undefined;
        receipt.value = undefined;
        applied.value = undefined;
      }
    },
    run: async (): Promise<void> => {
      if (!canTranslate.value) {
        return;
      }

      const runId = crypto.randomUUID();
      const support = controls.value;

      error.value = null;
      translating.value = true;
      controller = new AbortController();

      const request: TranslateTextRequest = {
        text: text.value,
        model: model.value,
        runId,
        // Sent only when the model has the control *and* the value is one it declares. The server
        // refuses a source language on a fixed-source model, so offering the chance to send one
        // would be staging a request already known to be invalid.
        ...(support?.sourceLanguages !== undefined
        && sourceLanguage.value !== undefined
        && support.sourceLanguages.some((language) => language.code === sourceLanguage.value)
          ? { sourceLanguage: sourceLanguage.value }
          : {}),
        targetLanguage: targetLanguage.value
      };

      try {
        const result = await transport(request, controller.signal);

        translation.value = result.translation;
        receipt.value = result.receipt;
        applied.value = result.applied;
      } catch (cause) {
        // An abort is the visitor's own Cancel, not a failure, so it leaves no error message.
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          error.value =
            cause instanceof ApiError
              ? cause.message
              : 'The text could not be translated. Check your connection and try again.';
        }
      } finally {
        translating.value = false;
        controller = undefined;
      }

      // Tracked only when a receipt exists. A failed or cancelled run has none and contributes
      // nothing to the session meter.
      if (receipt.value !== undefined) {
        await runTracker.trackRun(receipt.value);
      }
    },
    cancel: (): void => {
      controller?.abort();
    }
  };
}
