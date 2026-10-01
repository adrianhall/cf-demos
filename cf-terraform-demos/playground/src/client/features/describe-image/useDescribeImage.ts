/**
 * @file Stateful composable behind the Describe Image panel: choosing a picture, asking a question
 *   about it, running the model, and handing the completed run to {@link useRun} for cost
 *   resolution. The form's shape follows the selected model, as it does in Create Image, but the
 *   variable here is more fundamental than a slider range: one reviewed model requires a question
 *   and the other does not. Switching between them changes whether the panel can be submitted at
 *   all, so `canDescribe` reads the model's declaration rather than assuming a question is always
 *   needed.
 */

import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import {
  MAX_INSTRUCTION_CHARACTERS,
  type DescribeImageRequest,
  type VerifiedImageFacts
} from '../../../describe-image';
import type { RunMetrics, RunReceipt } from '../../../runs';
import { useRun, type UseRunOptions } from '../../composables/useRun';
import { ApiError, describeImage } from '../../services/playground-api';
import type { CatalogueModel } from '../../stores/catalogue';
import { isAcceptedUploadType, prepareImage, type PreparedImage } from './image-input';

/**
 * Options for {@link useDescribeImage}.
 */
export interface UseDescribeImageOptions {
  /**
   * Reviewed models for this panel, as reported by the catalogue. Reactive, because the catalogue
   * is fetched after mount and the form has to settle once it arrives.
   */
  models: Ref<CatalogueModel[]>;
  /**
   * Description transport, injected so tests drive outcomes directly instead of over HTTP.
   */
  describe?: typeof describeImage;
  /**
   * Options forwarded to {@link useRun}, so a test can poll without real delays.
   */
  runOptions?: UseRunOptions;
}

/**
 * What the Describe Image panel binds to.
 */
export interface UseDescribeImageResult {
  /**
   * The chosen picture, or `undefined` before one is selected.
   */
  image: Ref<PreparedImage | undefined>;
  /**
   * The question to ask about the picture.
   */
  instruction: Ref<string>;
  /**
   * Selected model identifier.
   */
  model: Ref<string>;
  /**
   * Requested answer-length cap, or `undefined` to use the model default.
   */
  maxTokens: Ref<number | undefined>;
  /**
   * The selected model's descriptor, so the view can render only its declared controls.
   */
  selectedModel: Ref<CatalogueModel | undefined>;
  /**
   * Whether the selected model requires a question rather than merely accepting one.
   */
  instructionRequired: Ref<boolean>;
  /**
   * Whether a description is in flight.
   */
  describing: Ref<boolean>;
  /**
   * Message from the most recent failure, or `null`.
   */
  error: Ref<string | null>;
  /**
   * The most recent description, or `undefined`.
   */
  description: Ref<string | undefined>;
  /**
   * What the server verified about the described picture, or `undefined`.
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
   * Whether the panel can be submitted.
   */
  canDescribe: Ref<boolean>;
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
  acceptHandoff: (handoff: {
    base64: string;
    mediaType: string;
    byteLength: number;
    origin: string;
  }) => void;
  /**
   * Clears the chosen picture and the previous answer.
   *
   * @returns Nothing.
   */
  clearImage: () => void;
  /**
   * Describes the chosen picture.
   *
   * @returns A promise fulfilled when the run has completed or failed and its cost has been
   *   tracked.
   */
  describe: () => Promise<void>;
  /**
   * Stops waiting for the run in flight.
   *
   * @returns Nothing; the HTTP request is aborted.
   */
  cancel: () => void;
}

/**
 * Drives the Describe Image panel.
 *
 * @param options Catalogue models, injectable transport, and run-tracking options; see
 *   {@link UseDescribeImageOptions}.
 * @returns Reactive form state and actions; see {@link UseDescribeImageResult}.
 */
export function useDescribeImage(options: UseDescribeImageOptions): UseDescribeImageResult {
  const transport = options.describe ?? describeImage;
  const run = useRun(options.runOptions);

  const image = shallowRef<PreparedImage | undefined>(undefined);
  const instruction = ref('');
  const model = ref('');
  const maxTokens = ref<number | undefined>(undefined);

  const describing = ref(false);
  const error = ref<string | null>(null);
  const description = ref<string | undefined>(undefined);
  const verified = shallowRef<VerifiedImageFacts | undefined>(undefined);
  const receipt = shallowRef<RunReceipt | undefined>(undefined);

  let controller: AbortController | undefined;

  const selectedModel = computed(() =>
    options.models.value.find((candidate) => candidate.id === model.value)
  );

  const instructionRequired = computed(
    () => selectedModel.value?.visionControls?.instructionRequired === true
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

  // Switching model resets the answer-length cap to that model's own default. The question is
  // deliberately *kept*: unlike a step count, it is the visitor's own words, and discarding it
  // when they compare two models on the same question would be actively unhelpful.
  watch(selectedModel, () => {
    maxTokens.value = undefined;
  });

  const canDescribe = computed(() => {
    if (describing.value || image.value === undefined || selectedModel.value === undefined) {
      return false;
    }

    if ([...instruction.value].length > MAX_INSTRUCTION_CHARACTERS) {
      return false;
    }

    // The contract difference, enforced before a request is made rather than after a `400` comes
    // back. The server still refuses it — that is the authority — but a disabled button with a
    // visible reason is a better explanation than a rejected request.
    return !instructionRequired.value || instruction.value.trim() !== '';
  });

  /**
   * Builds the request from the form, including only controls the selected model declares.
   *
   * @param runId Identifier for this run.
   * @returns The request to send.
   */
  function buildRequest(runId: string): DescribeImageRequest {
    const controls = selectedModel.value?.visionControls;
    const trimmed = instruction.value.trim();

    return {
      imageBase64: image.value?.base64 ?? '',
      model: model.value,
      runId,
      ...(trimmed === '' ? {} : { instruction: trimmed }),
      ...(controls?.maxTokens !== undefined && maxTokens.value !== undefined
        ? { maxTokens: maxTokens.value }
        : {})
    };
  }

  /**
   * Discards the previous answer.
   *
   * Called whenever the picture changes. A description left on screen beside a different picture is
   * worse than an empty space: it reads as a description _of_ the new picture.
   *
   * @returns Nothing.
   */
  function clearAnswer(): void {
    description.value = undefined;
    verified.value = undefined;
    receipt.value = undefined;
  }

  return {
    image,
    instruction,
    model,
    maxTokens,
    selectedModel,
    instructionRequired,
    describing,
    error,
    description,
    verified,
    receipt,
    metrics: run.metrics,
    costPending: run.costPending,
    canDescribe,
    selectFile: async (file: File): Promise<void> => {
      const outcome = await prepareImage(file);

      if (!outcome.ok) {
        error.value = outcome.message;
        return;
      }

      error.value = null;
      image.value = outcome.image;
      clearAnswer();
    },
    acceptHandoff: (handoff): void => {
      // Re-checked here even though the value came from the server's own byte-level sniff and
      // travelled only through an in-memory store. This function is what hands a media type to
      // the browser's `data:` URI parser, and that parser decides how the payload is treated —
      // so the check belongs at the point of use, exactly as Create Image's `toDataUri` argues.
      // Without it, a future path that staged a handoff from somewhere else would skip the one
      // guard that matters.
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
      clearAnswer();
    },
    clearImage: (): void => {
      image.value = undefined;
      error.value = null;
      clearAnswer();
    },
    describe: async (): Promise<void> => {
      if (!canDescribe.value) {
        return;
      }

      const runId = crypto.randomUUID();

      error.value = null;
      clearAnswer();
      describing.value = true;
      controller = new AbortController();

      try {
        const result = await transport(buildRequest(runId), controller.signal);

        description.value = result.description;
        verified.value = result.image;
        receipt.value = result.receipt;
      } catch (cause) {
        // An abort is the visitor's own Cancel, not a failure, so it leaves no error message.
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          error.value =
            cause instanceof ApiError
              ? cause.message
              : 'The picture could not be described. Check your connection and try again.';
        }
      } finally {
        describing.value = false;
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
