/**
 * @file Stateful composable behind the Classify Image panel: choosing a picture, setting the two
 *   result controls, running the classifier, and handing the completed run to {@link useRun} for
 *   cost resolution. Simpler than the generative panels in one respect and fussier in another.
 *   There is no prompt, so the only precondition for running is a picture. But the controls are
 *   applied to the result rather than sent to the model, which means changing one is a reason to
 *   re-run rather than a reason to invalidate what is already on screen — so the previous ranking
 *   is kept visible while a new run is in flight.
 */

import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import type {
  AppliedClassificationControls,
  ClassificationLabel,
  ClassifyImageRequest
} from '../../../shared/classify-image';
import type { VerifiedImageFacts } from '../../../shared/describe-image';
import type { RunMetrics, RunReceipt } from '../../../shared/runs';
import {
  isAcceptedUploadType,
  prepareImage,
  type PreparedImage
} from '../../components/media/image-input';
import { useRun, type UseRunOptions } from '../../composables/useRun';
import { ApiError, classifyImage } from '../../services/playground-api';
import type { CatalogueModel } from '../../stores/catalogue';
import type { HandoffImage } from '../../stores/handoff';

/**
 * Options for {@link useClassifyImage}.
 */
export interface UseClassifyImageOptions {
  /**
   * Reviewed models for this panel, as reported by the catalogue. Reactive, because the catalogue
   * is fetched after mount and the form has to settle once it arrives.
   */
  models: Ref<CatalogueModel[]>;
  /**
   * Classification transport, injected so tests drive outcomes directly instead of over HTTP.
   */
  classify?: typeof classifyImage;
  /**
   * Options forwarded to {@link useRun}, so a test can poll without real delays.
   */
  runOptions?: UseRunOptions;
}

/**
 * What the Classify Image panel binds to.
 */
export interface UseClassifyImageResult {
  /**
   * The chosen picture, or `undefined` before one is selected.
   */
  image: Ref<PreparedImage | undefined>;
  /**
   * Selected model identifier.
   */
  model: Ref<string>;
  /**
   * How many labels to show, or `undefined` to use the model's declared default.
   */
  topK: Ref<number | undefined>;
  /**
   * Score floor to apply, or `undefined` to use the model's declared default.
   */
  minimumConfidence: Ref<number | undefined>;
  /**
   * The selected model's descriptor, so the view can render only its declared controls.
   */
  selectedModel: Ref<CatalogueModel | undefined>;
  /**
   * Whether a classification is in flight.
   */
  classifying: Ref<boolean>;
  /**
   * Message from the most recent failure, or `null`.
   */
  error: Ref<string | null>;
  /**
   * The most recent ranking, or `undefined` before a run.
   *
   * An empty array is a distinct, meaningful state: the model answered and nothing cleared the
   * floor. The view reports that rather than treating it as "no result yet".
   */
  labels: Ref<ClassificationLabel[] | undefined>;
  /**
   * How many usable labels the model returned before ranking, or `undefined` before a run.
   */
  totalLabels: Ref<number | undefined>;
  /**
   * What the server verified about the classified picture, or `undefined`.
   */
  verified: Ref<VerifiedImageFacts | undefined>;
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
  applied: Ref<AppliedClassificationControls | undefined>;
  /**
   * Whether the panel can be submitted.
   */
  canClassify: Ref<boolean>;
  /**
   * Accepts a chosen file, validating it before it can be sent.
   *
   * @param file The file a visitor picked, dropped, or pasted.
   * @returns A promise fulfilled once the file has been accepted or refused.
   */
  selectFile: (file: File) => Promise<void>;
  /**
   * Accepts a picture handed over from another panel.
   *
   * @param handoff The picture and where it came from.
   * @returns Nothing; the picture becomes the current selection.
   */
  acceptHandoff: (handoff: HandoffImage) => void;
  /**
   * Clears the chosen picture and the previous ranking.
   *
   * @returns Nothing.
   */
  clearImage: () => void;
  /**
   * Classifies the chosen picture.
   *
   * @returns A promise fulfilled when the run has completed or failed and its cost has been
   *   tracked.
   */
  classify: () => Promise<void>;
  /**
   * Stops waiting for the run in flight.
   *
   * @returns Nothing; the HTTP request is aborted.
   */
  cancel: () => void;
}

/**
 * Drives the Classify Image panel.
 *
 * @param options Catalogue models, injectable transport, and run-tracking options; see
 *   {@link UseClassifyImageOptions}.
 * @returns Reactive form state and actions; see {@link UseClassifyImageResult}.
 */
export function useClassifyImage(options: UseClassifyImageOptions): UseClassifyImageResult {
  const transport = options.classify ?? classifyImage;
  const run = useRun(options.runOptions);

  const image = shallowRef<PreparedImage | undefined>(undefined);
  const model = ref('');
  const topK = ref<number | undefined>(undefined);
  const minimumConfidence = ref<number | undefined>(undefined);

  const classifying = ref(false);
  const error = ref<string | null>(null);
  const labels = shallowRef<ClassificationLabel[] | undefined>(undefined);
  const totalLabels = ref<number | undefined>(undefined);
  const verified = shallowRef<VerifiedImageFacts | undefined>(undefined);
  const receipt = shallowRef<RunReceipt | undefined>(undefined);
  const applied = shallowRef<AppliedClassificationControls | undefined>(undefined);

  let controller: AbortController | undefined;

  const selectedModel = computed(() =>
    options.models.value.find((candidate) => candidate.id === model.value)
  );

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

  // Switching model resets both controls to that model's own declared defaults, because the ranges
  // are per model and a value valid for one may be out of range for another.
  watch(selectedModel, () => {
    topK.value = undefined;
    minimumConfidence.value = undefined;
  });

  const canClassify = computed(
    () => !classifying.value && image.value !== undefined && selectedModel.value !== undefined
  );

  /**
   * Builds the request from the form, including only controls the selected model declares.
   *
   * @param runId Identifier for this run.
   * @returns The request to send.
   */
  function buildRequest(runId: string): ClassifyImageRequest {
    const controls = selectedModel.value?.classificationControls;

    return {
      imageBase64: image.value?.base64 ?? '',
      model: model.value,
      runId,
      ...(controls?.topK !== undefined && topK.value !== undefined ? { topK: topK.value } : {}),
      ...(controls?.minimumConfidence !== undefined && minimumConfidence.value !== undefined
        ? { minimumConfidence: minimumConfidence.value }
        : {})
    };
  }

  /**
   * Discards the previous ranking.
   *
   * Called whenever the picture changes. A ranking left on screen beside a different picture is
   * worse than an empty space: it reads as a ranking _of_ the new picture.
   *
   * @returns Nothing.
   */
  function clearResult(): void {
    labels.value = undefined;
    totalLabels.value = undefined;
    verified.value = undefined;
    receipt.value = undefined;
    applied.value = undefined;
  }

  return {
    image,
    model,
    topK,
    minimumConfidence,
    selectedModel,
    classifying,
    error,
    labels,
    totalLabels,
    verified,
    receipt,
    metrics: run.metrics,
    costPending: run.costPending,
    applied,
    canClassify,
    selectFile: async (file: File): Promise<void> => {
      const outcome = await prepareImage(file);

      if (!outcome.ok) {
        error.value = outcome.message;
        return;
      }

      error.value = null;
      image.value = outcome.image;
      clearResult();
    },
    acceptHandoff: (handoff): void => {
      // Re-checked here even though the value came from the server's own byte-level sniff and
      // travelled only through an in-memory store. This function is what hands a media type to
      // the browser's `data:` URI parser, and that parser decides how the payload is treated, so
      // the check belongs at the point of use.
      if (!isAcceptedUploadType(handoff.mediaType)) {
        error.value = 'That picture is not in a format this panel can display.';
        return;
      }

      error.value = null;
      image.value = {
        base64: handoff.base64,
        previewUri: `data:${handoff.mediaType};base64,${handoff.base64}`,
        byteLength: handoff.byteLength,
        fileName: handoff.origin
      };
      clearResult();
    },
    clearImage: (): void => {
      image.value = undefined;
      error.value = null;
      clearResult();
    },
    classify: async (): Promise<void> => {
      if (!canClassify.value) {
        return;
      }

      const runId = crypto.randomUUID();

      error.value = null;
      classifying.value = true;
      controller = new AbortController();

      try {
        const result = await transport(buildRequest(runId), controller.signal);

        labels.value = result.labels;
        totalLabels.value = result.totalLabels;
        verified.value = result.image;
        receipt.value = result.receipt;
        applied.value = result.applied;
      } catch (cause) {
        // An abort is the visitor's own Cancel, not a failure, so it leaves no error message.
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          error.value =
            cause instanceof ApiError
              ? cause.message
              : 'The picture could not be classified. Check your connection and try again.';
        }
      } finally {
        classifying.value = false;
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
