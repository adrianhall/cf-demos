/**
 * @file Stateful composable behind the Create Image panel: the control form, generation,
 *   cancellation, the gallery, and handing each completed run to {@link useRun} for cost
 *   resolution. The form's shape is derived from the selected model's declared controls rather than
 *   fixed. That is the panel's whole point: switching from Stable Diffusion XL to FLUX.1 removes
 *   the negative prompt, the dimensions, the guidance, and the seed, and lowers the step ceiling
 *   from 20 to 8. Values that no longer apply are dropped from the request rather than carried
 *   along invisibly, so the panel cannot send a control the server would refuse.
 */

import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import { MAX_PROMPT_CHARACTERS, type CreateImageRequest } from '../../../images';
import type { RunMetrics, RunReceipt } from '../../../runs';
import { useRun, type UseRunOptions } from '../../composables/useRun';
import { ApiError, createImage } from '../../services/playground-api';
import type { CatalogueModel } from '../../stores/catalogue';
import { addToGallery, type GalleryEntry } from './gallery';

/**
 * Options for {@link useCreateImage}.
 */
export interface UseCreateImageOptions {
  /**
   * Reviewed models for this panel, as reported by the catalogue. Reactive, because the catalogue
   * is fetched after mount and the form has to settle once it arrives.
   */
  models: Ref<CatalogueModel[]>;
  /**
   * Generation transport, injected so tests drive outcomes directly instead of over HTTP.
   */
  generate?: typeof createImage;
  /**
   * Options forwarded to {@link useRun}, so a test can poll without real delays.
   */
  runOptions?: UseRunOptions;
}

/**
 * What the Create Image panel binds to.
 */
export interface UseCreateImageResult {
  /**
   * Prompt text.
   */
  prompt: Ref<string>;
  /**
   * Negative prompt text. Ignored unless the selected model supports one.
   */
  negativePrompt: Ref<string>;
  /**
   * Selected model identifier.
   */
  model: Ref<string>;
  /**
   * Requested width, or `undefined` to use the model default.
   */
  width: Ref<number | undefined>;
  /**
   * Requested height, or `undefined` to use the model default.
   */
  height: Ref<number | undefined>;
  /**
   * Requested diffusion steps, or `undefined` to use the model default.
   */
  steps: Ref<number | undefined>;
  /**
   * Requested guidance, or `undefined` to use the model default.
   */
  guidance: Ref<number | undefined>;
  /**
   * Requested seed, or `undefined` to let the provider choose one.
   */
  seed: Ref<number | undefined>;
  /**
   * The selected model's descriptor, so the view can render only its declared controls.
   */
  selectedModel: Ref<CatalogueModel | undefined>;
  /**
   * Whether a generation is in flight.
   */
  generating: Ref<boolean>;
  /**
   * Message from the most recent failure, or `null`.
   */
  error: Ref<string | null>;
  /**
   * Generated results, newest first.
   */
  gallery: Ref<GalleryEntry[]>;
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
   * Whether the prompt can be submitted.
   */
  canGenerate: Ref<boolean>;
  /**
   * Generates an image from the current form.
   *
   * @returns A promise fulfilled when the run has completed or failed and its cost has been
   *   tracked.
   */
  generate: () => Promise<void>;
  /**
   * Stops waiting for the run in flight.
   *
   * @returns Nothing; the HTTP request is aborted.
   */
  cancel: () => void;
}

/**
 * Drives the Create Image panel.
 *
 * @param options Catalogue models, injectable transport, and run-tracking options; see
 *   {@link UseCreateImageOptions}.
 * @returns Reactive form state, the gallery, and actions; see {@link UseCreateImageResult}.
 */
export function useCreateImage(options: UseCreateImageOptions): UseCreateImageResult {
  const transport = options.generate ?? createImage;
  const run = useRun(options.runOptions);

  const prompt = ref('');
  const negativePrompt = ref('');
  const model = ref('');
  const width = ref<number | undefined>(undefined);
  const height = ref<number | undefined>(undefined);
  const steps = ref<number | undefined>(undefined);
  const guidance = ref<number | undefined>(undefined);
  const seed = ref<number | undefined>(undefined);

  const generating = ref(false);
  const error = ref<string | null>(null);
  const gallery = ref<GalleryEntry[]>([]);
  // `shallowRef` because a receipt is replaced wholesale and never mutated field by field.
  const receipt = shallowRef<RunReceipt | undefined>(undefined);

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

  // Switching model resets every control to that model's own defaults. Carrying a value across is
  // the subtle failure this avoids: 20 steps is valid for Stable Diffusion XL and invalid for
  // FLUX.1, so a retained value would turn a model switch into a rejected request for no reason the
  // visitor could see.
  watch(selectedModel, () => {
    width.value = undefined;
    height.value = undefined;
    steps.value = undefined;
    guidance.value = undefined;
    seed.value = undefined;
    negativePrompt.value = '';
  });

  const canGenerate = computed(
    () =>
      !generating.value
      && prompt.value.trim() !== ''
      && [...prompt.value].length <= MAX_PROMPT_CHARACTERS
      && selectedModel.value !== undefined
  );

  /**
   * Builds the request from the form, including only controls the selected model declares.
   *
   * Filtering here as well as on the server is not duplicated validation: the server is the
   * authority and refuses an unsupported control, while this keeps the panel from ever sending one.
   * Without it, a control left set from a previous model would produce a `400` that looked like a
   * bug in the panel rather than a deliberate refusal.
   *
   * @param runId Identifier for this run.
   * @returns The request to send.
   */
  function buildRequest(runId: string): CreateImageRequest {
    const controls = selectedModel.value?.imageControls;
    const trimmedNegative = negativePrompt.value.trim();

    return {
      prompt: prompt.value.trim(),
      model: model.value,
      runId,
      ...(controls?.negativePrompt === true && trimmedNegative !== ''
        ? { negativePrompt: trimmedNegative }
        : {}),
      ...(controls?.dimensions !== undefined && width.value !== undefined
        ? { width: width.value }
        : {}),
      ...(controls?.dimensions !== undefined && height.value !== undefined
        ? { height: height.value }
        : {}),
      ...(controls?.steps !== undefined && steps.value !== undefined ? { steps: steps.value } : {}),
      ...(controls?.guidance !== undefined && guidance.value !== undefined
        ? { guidance: guidance.value }
        : {}),
      ...(controls?.seed === true && seed.value !== undefined ? { seed: seed.value } : {})
    };
  }

  return {
    prompt,
    negativePrompt,
    model,
    width,
    height,
    steps,
    guidance,
    seed,
    selectedModel,
    generating,
    error,
    gallery,
    receipt,
    metrics: run.metrics,
    costPending: run.costPending,
    canGenerate,
    generate: async (): Promise<void> => {
      if (!canGenerate.value) {
        return;
      }

      const runId = crypto.randomUUID();
      const modelName = selectedModel.value?.name ?? model.value;

      error.value = null;
      receipt.value = undefined;
      generating.value = true;
      controller = new AbortController();

      try {
        const result = await transport(buildRequest(runId), controller.signal);

        gallery.value = addToGallery(gallery.value, {
          runId: result.receipt.runId,
          image: result.image,
          applied: result.applied,
          modelName
        });
        receipt.value = result.receipt;
      } catch (cause) {
        // An abort is the visitor's own Cancel, not a failure, so it leaves no error message.
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          error.value =
            cause instanceof ApiError
              ? cause.message
              : 'The image could not be generated. Check your connection and try again.';
        }
      } finally {
        generating.value = false;
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
