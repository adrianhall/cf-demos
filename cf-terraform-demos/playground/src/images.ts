/**
 * @file The Create Image panel's wire contract: the request the browser sends and the result the
 *   Worker returns. It sits at `src/` beside `tasks.ts`, `runs.ts`, and `chat.ts` because both
 *   tiers need it, and it carries no model descriptors — the browser learns which models exist, and
 *   which controls each one supports, from `/api/catalogue`. The asymmetry this panel exists to
 *   handle is real: the two reviewed models accept different parameters, with different names and
 *   different ranges, and return their image in different shapes. A request shape shared between
 *   the tiers is useful; a _control list_ shared between them would let the browser decide what the
 *   server accepts, so that stays server-side and is published per model.
 */

import type { RunReceipt } from './runs.ts';

/**
 * Longest prompt the panel accepts, in characters.
 *
 * Set to the tighter of the two reviewed models' documented limits rather than to each model's own,
 * so the editor's counter means the same thing whichever model is selected. The server still
 * validates per request — a browser limit is a courtesy, never a control.
 */
export const MAX_PROMPT_CHARACTERS = 2_048;

/**
 * Longest negative prompt accepted, for the models that support one.
 */
export const MAX_NEGATIVE_PROMPT_CHARACTERS = 2_048;

/**
 * Largest image the Worker will relay back to the browser, in bytes.
 *
 * A generated image is held in memory and base64-encoded into a JSON response, which inflates it by
 * about a third. The cap bounds that inflation and gives a clear failure instead of an isolate
 * running out of memory on a pathological provider response.
 */
export const MAX_IMAGE_BYTES = 12 * 1_024 * 1_024;

/**
 * Media types the panel will render.
 *
 * An allowlist rather than a check for "looks like an image". The browser renders this value in a
 * `data:` URI, so an unexpected type here would be a content type of the provider's choosing —
 * `image/svg+xml` in particular is a scripting context, not a picture.
 */
export const RENDERABLE_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/**
 * One media type the panel will render; see {@link RENDERABLE_IMAGE_MEDIA_TYPES}.
 */
export type ImageMediaType = (typeof RENDERABLE_IMAGE_MEDIA_TYPES)[number];

/**
 * Reports whether a value is a media type this panel renders.
 *
 * @param value Candidate media type, typically sniffed from provider bytes.
 * @returns `true` when the type is in the allowlist.
 */
export function isRenderableImageMediaType(value: string): value is ImageMediaType {
  return (RENDERABLE_IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}

/**
 * File extension to offer when downloading each media type.
 *
 * Derived from the _sniffed_ type rather than from anything the provider declared, so a download's
 * name cannot disagree with its actual bytes.
 */
export const IMAGE_FILE_EXTENSIONS: Readonly<Record<ImageMediaType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
};

/**
 * A numeric control a model exposes, with the range the server will accept.
 *
 * Published per model through the catalogue so the UI can render a slider with correct bounds and
 * the server can validate against the same numbers. One definition means a control cannot offer a
 * value the API then rejects.
 */
export interface NumericControlRange {
  /**
   * Lowest accepted value, inclusive.
   */
  min: number;
  /**
   * Highest accepted value, inclusive.
   */
  max: number;
  /**
   * Granularity for the UI control. Does not constrain validation: a value between steps is still
   * within range, and refusing it would be a presentation detail masquerading as a rule.
   */
  step: number;
  /**
   * Value the model uses when the control is omitted, shown in the UI as the default.
   */
  default: number;
}

/**
 * Which optional controls one model supports.
 *
 * Every field is optional or boolean-false by default, so a model supports nothing it has not
 * explicitly declared. That direction matters: the failure mode of an allowlist is a control the UI
 * does not offer, which is visible and harmless. The failure mode of a denylist is a parameter
 * forwarded to a provider that never agreed to accept it.
 */
export interface ImageControlSupport {
  /**
   * Whether the model accepts text describing what to avoid.
   */
  negativePrompt: boolean;
  /**
   * Whether the model accepts a seed for reproducible output.
   */
  seed: boolean;
  /**
   * Accepted pixel range for width and height, when the model lets the caller choose. Absent for a
   * model that only emits its native size.
   */
  dimensions?: NumericControlRange;
  /**
   * Accepted diffusion-step range. The two reviewed models differ sharply here — one caps at 8 and
   * the other at 20 — which is exactly why the range is published rather than assumed.
   */
  steps?: NumericControlRange;
  /**
   * Accepted prompt-adherence range, for models that expose guidance.
   */
  guidance?: NumericControlRange;
}

/**
 * Every control name a Create Image request may carry.
 *
 * Used by validation to name the offending control in an error, and by tests to walk the full set
 * rather than a hand-written subset that could fall behind.
 */
export const IMAGE_CONTROL_NAMES = [
  'negativePrompt',
  'seed',
  'width',
  'height',
  'steps',
  'guidance'
] as const;

/**
 * One optional Create Image control; see {@link IMAGE_CONTROL_NAMES}.
 */
export type ImageControlName = (typeof IMAGE_CONTROL_NAMES)[number];

/**
 * What the browser posts to generate an image.
 *
 * As with Chat, there is no identity field and no way to supply one: the actor comes from the
 * verified Access JWT alone, and the domain rejects a body that carries one rather than ignoring
 * it.
 */
export interface CreateImageRequest {
  /**
   * Description of the image to generate.
   */
  prompt: string;
  /**
   * Reviewed model identifier, which must be registered against the `create-image` panel.
   */
  model: string;
  /**
   * Opaque run identifier generated by the browser, so the UI can correlate its pending state with
   * the receipt.
   */
  runId: string;
  /**
   * Text describing elements to avoid. Only accepted by a model that declares support.
   */
  negativePrompt?: string;
  /**
   * Width in pixels, for a model that accepts dimensions.
   */
  width?: number;
  /**
   * Height in pixels, for a model that accepts dimensions.
   */
  height?: number;
  /**
   * Diffusion steps, within the selected model's declared range.
   */
  steps?: number;
  /**
   * Prompt-adherence strength, for a model that accepts guidance.
   */
  guidance?: number;
  /**
   * Seed for reproducible output, for a model that accepts one.
   */
  seed?: number;
}

/**
 * The image a run produced, as returned to the browser.
 */
export interface GeneratedImage {
  /**
   * The image bytes, base64-encoded for transport in a JSON body.
   *
   * Base64 in JSON rather than a second request for the bytes: the image is transient and is never
   * stored, so there is no URL that could serve it later. A follow-up endpoint would have to hold
   * the bytes somewhere, which is the retention decision this panel exists to avoid making.
   */
  base64: string;
  /**
   * Media type determined by inspecting the bytes, never by trusting what the provider declared.
   * Always one of {@link RENDERABLE_IMAGE_MEDIA_TYPES}.
   */
  mediaType: ImageMediaType;
  /**
   * Size of the decoded image in bytes, so the UI can state it without decoding the base64 itself.
   */
  byteLength: number;
}

/**
 * What the Create Image endpoint returns on success.
 */
export interface CreateImageResponse {
  /**
   * The generated image; see {@link GeneratedImage}.
   */
  image: GeneratedImage;
  /**
   * The run receipt, whose `costStatus` is `pending` whenever a gateway log exists to poll for.
   */
  receipt: RunReceipt;
  /**
   * The controls the server actually applied, including the defaults it filled in.
   *
   * Echoed rather than assumed, so the UI can show what produced this image even after the form has
   * moved on — which is what makes comparing two results in the gallery meaningful.
   */
  applied: AppliedImageControls;
}

/**
 * The settings one generated image was produced with.
 */
export interface AppliedImageControls {
  /**
   * Prompt as sent, after trimming.
   */
  prompt: string;
  /**
   * Model identifier that produced the image.
   */
  model: string;
  /**
   * Negative prompt, when the model supported one and the caller supplied it.
   */
  negativePrompt?: string;
  /**
   * Width in pixels, when the model accepts dimensions.
   */
  width?: number;
  /**
   * Height in pixels, when the model accepts dimensions.
   */
  height?: number;
  /**
   * Diffusion steps applied, including a model default the caller did not set.
   */
  steps?: number;
  /**
   * Guidance applied, when the model accepts it.
   */
  guidance?: number;
  /**
   * Seed applied, when the model accepts one and the caller supplied it.
   */
  seed?: number;
}
