/**
 * Stateful client orchestration for FLUX.2 reference-image editing.
 */
import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import type { VerifiedImageFacts } from '../../../shared/describe-image';
import type { GeneratedImage } from '../../../shared/images';
import type { AppliedRemixImageControls, RemixImageRequest } from '../../../shared/remix-image';
import type { RunMetrics, RunReceipt } from '../../../shared/runs';
import {
  isAcceptedUploadType,
  prepareImage,
  type PreparedImage
} from '../../components/media/image-input';
import { useRun, type UseRunOptions } from '../../composables/useRun';
import { ApiError, remixImage } from '../../services/playground-api';
import type { CatalogueModel } from '../../stores/catalogue';
import type { HandoffImage } from '../../stores/handoff';
import { referenceImageBase64 } from './reference-image';

/**
 * Options for {@link useRemixImage}.
 */
export interface UseRemixImageOptions {
  /**
   * Reactive reviewed Remix Image descriptors.
   */
  models: Ref<CatalogueModel[]>;
  /**
   * Injectable endpoint transport.
   */
  remix?: typeof remixImage;
  /**
   * Injectable run polling options.
   */
  runOptions?: UseRunOptions;
}

/**
 * Reactive panel state and actions.
 */
export interface UseRemixImageResult {
  /**
   * Current source image.
   */
  source: Ref<PreparedImage | undefined>;
  /**
   * Editing instruction.
   */
  instruction: Ref<string>;
  /**
   * Selected model identifier.
   */
  model: Ref<string>;
  /**
   * Optional seed.
   */
  seed: Ref<number | undefined>;
  /**
   * Selected reviewed descriptor.
   */
  selectedModel: Ref<CatalogueModel | undefined>;
  /**
   * Whether a request is pending.
   */
  remixing: Ref<boolean>;
  /**
   * Last safe error.
   */
  error: Ref<string | null>;
  /**
   * Current successful edited image.
   */
  result: Ref<GeneratedImage | undefined>;
  /**
   * Server-verified source facts from the successful run.
   */
  verifiedSource: Ref<VerifiedImageFacts | undefined>;
  /**
   * Receipt of the successful run.
   */
  receipt: Ref<RunReceipt | undefined>;
  /**
   * Gateway metrics.
   */
  metrics: Ref<RunMetrics | undefined>;
  /**
   * Whether cost lookup remains pending.
   */
  costPending: Ref<boolean>;
  /**
   * Controls applied by the server.
   */
  applied: Ref<AppliedRemixImageControls | undefined>;
  /**
   * Whether all required input is ready.
   */
  canRemix: Ref<boolean>;
  /**
   * Prepares a source file.
   */
  selectSource: (file: File) => Promise<void>;
  /**
   * Accepts a transient server-verified handoff.
   */
  acceptHandoff: (image: HandoffImage) => void;
  /**
   * Clears source and current result.
   */
  clearSource: () => void;
  /**
   * Starts an edit.
   */
  remix: () => Promise<void>;
  /**
   * Aborts browser waiting.
   */
  cancel: () => void;
}

/**
 * Provides Remix Image state while retaining source and prior output across an unsuccessful rerun.
 *
 * @param options Reactive descriptor list and optional test seams.
 * @returns Typed state and panel actions.
 */
export function useRemixImage(options: UseRemixImageOptions): UseRemixImageResult {
  const transport = options.remix ?? remixImage;
  const run = useRun(options.runOptions);
  const source = shallowRef<PreparedImage | undefined>();
  const instruction = ref('');
  const model = ref('');
  const seed = ref<number | undefined>();
  const remixing = ref(false);
  const error = ref<string | null>(null);
  const result = shallowRef<GeneratedImage | undefined>();
  const verifiedSource = shallowRef<VerifiedImageFacts | undefined>();
  const receipt = shallowRef<RunReceipt | undefined>();
  const applied = shallowRef<AppliedRemixImageControls | undefined>();
  let controller: AbortController | undefined;

  const selectedModel = computed(() =>
    options.models.value.find((candidate) => candidate.id === model.value)
  );
  watch(
    options.models,
    (available) => {
      if (model.value === '' && available[0] !== undefined) model.value = available[0].id;
    },
    { immediate: true }
  );
  watch(selectedModel, () => {
    seed.value = undefined;
  });
  const canRemix = computed(
    () =>
      !remixing.value
      && source.value !== undefined
      && selectedModel.value !== undefined
      && instruction.value.trim() !== ''
  );

  /**
   * Builds the descriptor-approved request.
   */
  function request(runId: string, imageBase64: string): RemixImageRequest {
    return {
      imageBase64,
      instruction: instruction.value.trim(),
      model: model.value,
      runId,
      ...(seed.value === undefined ? {} : { seed: seed.value })
    };
  }

  return {
    source,
    instruction,
    model,
    seed,
    selectedModel,
    remixing,
    error,
    result,
    verifiedSource,
    receipt,
    metrics: run.metrics,
    costPending: run.costPending,
    applied,
    canRemix,
    selectSource: async (file) => {
      const prepared = await prepareImage(file);
      if (!prepared.ok) {
        error.value = prepared.message;
        return;
      }
      error.value = null;
      source.value = prepared.image;
      result.value = undefined;
      receipt.value = undefined;
    },
    acceptHandoff: (image) => {
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
    clearSource: () => {
      if (!remixing.value) {
        source.value = undefined;
        result.value = undefined;
        receipt.value = undefined;
      }
    },
    remix: async () => {
      if (!canRemix.value) return;
      const runId = crypto.randomUUID();
      error.value = null;
      remixing.value = true;
      controller = new AbortController();
      try {
        const selectedSource = source.value;
        if (selectedSource === undefined) return;
        const preparedBase64 = await referenceImageBase64(
          selectedSource,
          selectedModel.value?.remixImageControls?.maxInputEdge
        );
        const response = await transport(request(runId, preparedBase64), controller.signal);
        result.value = response.image;
        verifiedSource.value = response.source;
        receipt.value = response.receipt;
        applied.value = response.applied;
        void run.trackRun(response.receipt);
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          error.value =
            cause instanceof ApiError
              ? cause.message
              : 'The image could not be remixed. Try again.';
        }
      } finally {
        remixing.value = false;
        controller = undefined;
      }
    },
    cancel: () => controller?.abort()
  };
}
