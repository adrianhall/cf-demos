/**
 * @file Stateful composable behind the Classify Text panel: the text, the ranking controls where a
 *   model has them, running the classification, and handing the result to {@link useRun} for cost
 *   resolution. The thing that makes this panel's state unusual is that **the reviewed models do
 *   not all return the same kind of answer**. DistilBERT and Clef Flash score labels; Llama Guard
 *   returns a verdict with no score for anything. So the controls are rendered from the model's
 *   declaration rather than always present, and `outcomeKind` tells the view which renderer to use.
 *   A panel that assumed a score would draw a bar of width `NaN` against a perfectly valid safety
 *   verdict. Switching model therefore has to discard controls the new model does not have. A
 *   retained `minimumConfidence` would be sent to a model whose output has no score to compare it
 *   against — a request the server correctly refuses, and one the visitor never knowingly made.
 */

import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import {
  MAX_CLASSIFICATION_TEXT_CHARACTERS,
  type AppliedTextClassificationControls,
  type ClassificationOutcome,
  type ClassifyTextRequest,
  type ReviewedLabel
} from '../../../shared/classify-text';
import type { RunMetrics, RunReceipt } from '../../../shared/runs';
import { useRun, type UseRunOptions } from '../../composables/useRun';
import { ApiError, classifyText } from '../../services/playground-api';
import type { CatalogueModel } from '../../stores/catalogue';

/**
 * Options for {@link useClassifyText}.
 */
export interface UseClassifyTextOptions {
  /**
   * Reviewed models for this panel, as reported by the catalogue. Reactive, because the catalogue
   * is fetched after mount and the form has to settle once it arrives.
   */
  models: Ref<CatalogueModel[]>;
  /**
   * Classification transport, injected so tests drive outcomes directly instead of over HTTP.
   */
  classify?: typeof classifyText;
  /**
   * Options forwarded to {@link useRun}, so a test can poll without real delays.
   */
  runOptions?: UseRunOptions;
}

/**
 * What the Classify Text panel binds to.
 */
export interface UseClassifyTextResult {
  /**
   * The text to classify.
   */
  text: Ref<string>;
  /**
   * Selected model identifier.
   */
  model: Ref<string>;
  /**
   * How many labels to show, or `undefined` for a model with no such control.
   */
  topK: Ref<number | undefined>;
  /**
   * Score floor to apply, or `undefined` for a model with no such control.
   */
  minimumConfidence: Ref<number | undefined>;
  /**
   * The selected model's descriptor, so the view can render only its declared controls.
   */
  selectedModel: Ref<CatalogueModel | undefined>;
  /**
   * Whether the selected model scores its labels.
   *
   * Decides which result renderer the view uses, and whether the ranking controls appear at all.
   */
  scoresLabels: Ref<boolean>;
  /**
   * What the selected model's label set is called.
   */
  labelSetName: Ref<string>;
  /**
   * Every label the selected model can emit, published before any run.
   */
  labelSet: Ref<readonly ReviewedLabel[]>;
  /**
   * Whether a classification is in flight.
   */
  classifying: Ref<boolean>;
  /**
   * Message from the most recent failure, or `null`.
   */
  error: Ref<string | null>;
  /**
   * The most recent outcome, or `undefined` before a run.
   */
  outcome: Ref<ClassificationOutcome | undefined>;
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
  applied: Ref<AppliedTextClassificationControls | undefined>;
  /**
   * How many characters the text currently holds, in code points.
   */
  characterCount: Ref<number>;
  /**
   * Whether the panel can be submitted.
   */
  canClassify: Ref<boolean>;
  /**
   * Why the panel cannot be submitted, or `null` when it can.
   */
  blockedReason: Ref<string | null>;
  /**
   * Classifies the current text.
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
 * Drives the Classify Text panel.
 *
 * @param options Catalogue models, injectable transport, and run-tracking options; see
 *   {@link UseClassifyTextOptions}.
 * @returns Reactive form state and actions; see {@link UseClassifyTextResult}.
 */
export function useClassifyText(options: UseClassifyTextOptions): UseClassifyTextResult {
  const transport = options.classify ?? classifyText;
  const runTracker = useRun(options.runOptions);

  const text = ref('');
  const model = ref('');
  const topK = ref<number | undefined>(undefined);
  const minimumConfidence = ref<number | undefined>(undefined);

  const classifying = ref(false);
  const error = ref<string | null>(null);
  const outcome = shallowRef<ClassificationOutcome | undefined>(undefined);
  const receipt = shallowRef<RunReceipt | undefined>(undefined);
  const applied = shallowRef<AppliedTextClassificationControls | undefined>(undefined);

  let controller: AbortController | undefined;

  const selectedModel = computed(() =>
    options.models.value.find((candidate) => candidate.id === model.value)
  );

  /**
   * The selected model's declared classification controls, or `undefined` before the catalogue
   * loads.
   */
  const controls = computed(() => selectedModel.value?.textClassificationControls);

  const scoresLabels = computed(() => controls.value?.outcomeKind === 'scored-labels');
  const labelSetName = computed(() => controls.value?.labelSetName ?? '');
  const labelSet = computed(() => controls.value?.labelSet ?? []);

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

  // Switching model re-settles the ranking controls against what the new model actually has.
  //
  // `immediate` because the model watcher above has already chosen a model by the time this runs,
  // so the controls must settle in the same tick. Without it there is a window — the first paint
  // after the catalogue loads — in which a model is selected but its control defaults are not.
  //
  // A control the new model does not declare is cleared rather than retained: it would otherwise
  // be sent to a model whose output has no score to compare it against, which the server refuses
  // and which the visitor never knowingly asked for.
  watch(
    selectedModel,
    (current) => {
      const support = current?.textClassificationControls;
      if (support === undefined) {
        return;
      }

      topK.value = support.topK === undefined ? undefined : (topK.value ?? support.topK.default);
      minimumConfidence.value =
        support.minimumConfidence === undefined
          ? undefined
          : (minimumConfidence.value ?? support.minimumConfidence.default);
    },
    { immediate: true }
  );

  const characterCount = computed(() => [...text.value].length);

  const blockedReason = computed(() => {
    if (text.value.trim() === '') {
      return null;
    }

    if (characterCount.value > MAX_CLASSIFICATION_TEXT_CHARACTERS) {
      return (
        `That text is ${characterCount.value.toLocaleString()} characters, and this panel `
        + `classifies up to ${MAX_CLASSIFICATION_TEXT_CHARACTERS.toLocaleString()}. The limit `
        + 'keeps the text inside the smallest model\u2019s context window, because a model that '
        + 'truncates scores only the part it read.'
      );
    }

    return null;
  });

  const canClassify = computed(
    () =>
      !classifying.value
      && text.value.trim() !== ''
      && selectedModel.value !== undefined
      && blockedReason.value === null
  );

  return {
    text,
    model,
    topK,
    minimumConfidence,
    selectedModel,
    scoresLabels,
    labelSetName,
    labelSet,
    classifying,
    error,
    outcome,
    receipt,
    metrics: runTracker.metrics,
    costPending: runTracker.costPending,
    applied,
    characterCount,
    canClassify,
    blockedReason,
    run: async (): Promise<void> => {
      if (!canClassify.value) {
        return;
      }

      const runId = crypto.randomUUID();
      const support = controls.value;

      error.value = null;
      classifying.value = true;
      controller = new AbortController();

      const request: ClassifyTextRequest = {
        text: text.value,
        model: model.value,
        runId,
        // Each control is sent only when the selected model declares it *and* a value is set.
        // Checking the declaration here rather than trusting the ref means a stale value surviving
        // a model switch cannot be forwarded to a model that would refuse it.
        ...(support?.topK !== undefined && topK.value !== undefined ? { topK: topK.value } : {}),
        ...(support?.minimumConfidence !== undefined && minimumConfidence.value !== undefined
          ? { minimumConfidence: minimumConfidence.value }
          : {})
      };

      try {
        const result = await transport(request, controller.signal);

        outcome.value = result.outcome;
        receipt.value = result.receipt;
        applied.value = result.applied;
      } catch (cause) {
        // An abort is the visitor's own Cancel, not a failure, so it leaves no error message.
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          error.value =
            cause instanceof ApiError
              ? cause.message
              : 'The text could not be classified. Check your connection and try again.';
        }
      } finally {
        classifying.value = false;
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
