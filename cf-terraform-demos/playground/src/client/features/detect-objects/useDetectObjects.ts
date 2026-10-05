/**
 * @file Form state and run orchestration for Detect Objects. Separated from the view for the same
 *   reason every other panel is: the view then contains only markup, and this file can be tested
 *   without mounting anything. It also fixes a real hazard the inline version had — `useRun()`
 *   returns refs, and a view binding `run.costPending` straight into a child prop passes the `Ref`
 *   object rather than the boolean inside it, because template unwrapping applies to a setup
 *   binding and not to a property reached through one. Re-exporting the refs individually here is
 *   what makes the template see values.
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { VerifiedImageFacts } from '../../../shared/describe-image';
import type { Detection, DetectObjectsResponse } from '../../../shared/detect-objects';
import type { RunMetrics, RunReceipt } from '../../../shared/runs';
import { prepareImage, type PreparedImage } from '../../components/media/image-input';
import { useRun } from '../../composables/useRun';
import { ApiError, detectObjects } from '../../services/playground-api';
import { useCatalogueStore, type CatalogueModel } from '../../stores/catalogue';

/**
 * Reactive state and actions backing the Detect Objects panel.
 */
export interface UseDetectObjectsResult {
  /**
   * The picture to search, once one has been accepted.
   */
  image: Ref<PreparedImage | undefined>;
  /**
   * Identifier of the selected reviewed model.
   */
  model: Ref<string>;
  /**
   * Phrase the model is asked to locate.
   */
  target: Ref<string>;
  /**
   * Caller's chosen provider-side maximum, or `undefined` to use the model's default.
   */
  maxObjects: Ref<number | undefined>;
  /**
   * Reviewed models this panel offers.
   */
  models: ComputedRef<CatalogueModel[]>;
  /**
   * The currently selected model's descriptor, when the catalogue has loaded.
   */
  selectedModel: ComputedRef<CatalogueModel | undefined>;
  /**
   * Whether a detection request is in flight.
   */
  detecting: Ref<boolean>;
  /**
   * Visitor-facing failure message, or `null` when the last action succeeded.
   */
  error: Ref<string | null>;
  /**
   * Regions the last successful run returned, empty when it found none.
   */
  detections: Ref<Detection[]>;
  /**
   * Whether a run has completed, which distinguishes "found nothing" from "not run yet".
   */
  hasResult: Ref<boolean>;
  /**
   * Byte-verified facts about the searched picture.
   */
  verified: Ref<VerifiedImageFacts | undefined>;
  /**
   * Receipt of the last completed run.
   */
  receipt: Ref<RunReceipt | undefined>;
  /**
   * Controls actually applied, as the server reports them.
   */
  applied: Ref<DetectObjectsResponse['applied'] | undefined>;
  /**
   * Resolved gateway metrics for the most recent run, or `undefined` while unresolved.
   */
  metrics: Ref<RunMetrics | undefined>;
  /**
   * Whether a metrics poll is currently in flight.
   */
  costPending: Ref<boolean>;
  /**
   * Whether the form is complete enough to submit.
   */
  canDetect: ComputedRef<boolean>;
  /**
   * Accepts a picture, validating it in the browser before it can be submitted.
   *
   * @param file The chosen file.
   * @returns Nothing once the picture has been accepted or rejected with a message.
   */
  selectFile: (file: File) => Promise<void>;
  /**
   * Clears the selected picture and any result derived from it.
   *
   * @returns Nothing.
   */
  clearImage: () => void;
  /**
   * Runs object localisation against the selected model.
   *
   * @returns Nothing once the run has completed or failed. A failure is reported through
   *   {@link UseDetectObjectsResult.error} rather than thrown, because every caller is a template
   *   event handler with nowhere to catch it.
   */
  detect: () => Promise<void>;
}

/**
 * Creates the Detect Objects panel state.
 *
 * @returns Reactive state and actions; see {@link UseDetectObjectsResult}.
 */
export function useDetectObjects(): UseDetectObjectsResult {
  const catalogue = useCatalogueStore();
  const run = useRun();

  const image = ref<PreparedImage>();
  const model = ref('');
  const target = ref('person');
  const maxObjects = ref<number>();
  const detecting = ref(false);
  const error = ref<string | null>(null);
  const detections = ref<Detection[]>([]);
  const hasResult = ref(false);
  const verified = ref<VerifiedImageFacts>();
  const receipt = ref<RunReceipt>();
  const applied = ref<DetectObjectsResponse['applied']>();

  const models = computed(() => catalogue.modelsForTask('detect-objects'));
  const selectedModel = computed(() =>
    models.value.find((candidate) => candidate.id === model.value)
  );
  const canDetect = computed(
    () =>
      image.value !== undefined
      && model.value !== ''
      && target.value.trim() !== ''
      && !detecting.value
  );

  /**
   * Discards any result, so a stale answer cannot outlive the picture it describes.
   */
  function resetResult(): void {
    detections.value = [];
    hasResult.value = false;
    verified.value = undefined;
    receipt.value = undefined;
    applied.value = undefined;
  }

  return {
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
    verified,
    receipt,
    applied,
    metrics: run.metrics,
    costPending: run.costPending,
    canDetect,
    selectFile: async (file: File): Promise<void> => {
      const outcome = await prepareImage(file);

      if (!outcome.ok) {
        error.value = outcome.message;
        return;
      }

      error.value = null;
      image.value = outcome.image;
      resetResult();
    },
    clearImage: (): void => {
      image.value = undefined;
      error.value = null;
      resetResult();
    },
    detect: async (): Promise<void> => {
      if (!canDetect.value || image.value === undefined) {
        return;
      }

      detecting.value = true;
      error.value = null;

      try {
        const response = await detectObjects({
          imageBase64: image.value.base64,
          model: model.value,
          runId: crypto.randomUUID(),
          target: target.value.trim(),
          ...(maxObjects.value === undefined ? {} : { maxObjects: maxObjects.value })
        });

        detections.value = response.detections;
        verified.value = response.image;
        receipt.value = response.receipt;
        applied.value = response.applied;
        hasResult.value = true;

        await run.trackRun(response.receipt);
      } catch (cause) {
        // A provider or validation failure is a message, not a crash: the panel keeps the picture
        // so the visitor can adjust the target and try again.
        error.value =
          cause instanceof ApiError ? cause.message : 'The picture could not be analysed.';
      } finally {
        detecting.value = false;
      }
    }
  };
}
