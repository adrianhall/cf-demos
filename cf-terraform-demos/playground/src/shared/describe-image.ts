/**
 * @file The Describe Image panel's wire contract: the picture and question the browser sends, and
 *   the description the Worker returns. It sits at `src/` beside `tasks.ts`, `runs.ts`, `chat.ts`,
 *   and `images.ts` because both tiers need it. This panel inverts Create Image. There the request
 *   was small and the response was megabytes; here the request carries the megabytes and the answer
 *   is a paragraph. That reversal is the reason the interesting rules in this file are about
 *   _input_: how large a picture may be, how many pixels it may have, and what a model is allowed
 *   to be told about it. As in Create Image, no model descriptor appears here. The browser learns
 *   which vision models exist, and what each one requires, from `/api/catalogue`. The two reviewed
 *   models disagree about whether a question is optional and about what they call the field holding
 *   their answer, so capability stays server-side and is published per model.
 */

import type { RunReceipt } from './runs.ts';

/**
 * Longest question or instruction the panel accepts, in characters.
 *
 * Far below either model's documented ceiling — Llama 3.2 Vision allows 131,072 characters — on
 * purpose. This panel asks a question _about a picture_; a prompt longer than this is a different
 * use case, and the cap keeps the request dominated by the image rather than by prose.
 */
export const MAX_INSTRUCTION_CHARACTERS = 1_024;

/**
 * Largest picture the panel accepts, in bytes.
 *
 * This is the decoded size, not the size of the base64 text that carried it, and the number is
 * **measured rather than chosen**. Both reviewed models document their `image` field as an array of
 * integers — one JSON number per byte — and that expansion is brutally expensive: a V8 array of a
 * million small integers costs far more than the million bytes behind it.
 *
 * Peak resident memory for one request, measured end to end (decode, expand, serialise):
 *
 * | Picture | Peak    |
 * | ------- | ------- |
 * | 1 MiB   | ~55 MB  |
 * | 2 MiB   | ~80 MB  |
 * | 4 MiB   | ~234 MB |
 *
 * A Worker isolate has 128 MB. A 4 MiB ceiling would therefore let a _single_ ordinary request
 * exhaust the isolate and take unrelated requests down with it — not a theoretical concern but the
 * arithmetic of the contract. 1 MiB leaves headroom for concurrent requests on one isolate and
 * still accepts an ordinary photograph, which is all a vision model needs: both reviewed models
 * downscale heavily before they look at anything, so a larger upload buys resolution that is
 * discarded before inference.
 */
export const MAX_INPUT_IMAGE_BYTES = 1_024 * 1_024;

/**
 * Largest edge length accepted, in pixels.
 *
 * A byte limit alone is not enough, because the two bound genuinely different costs.
 * {@link MAX_INPUT_IMAGE_BYTES} bounds _this Worker's_ memory; this bounds the decode work the
 * _provider_ does on our behalf. A highly compressible image — a single flat colour — can be
 * enormous in pixels while staying well inside the byte limit, so neither check subsumes the other.
 * Reading the declared dimensions from the file header bounds it before the request is ever made,
 * and without decoding anything ourselves.
 */
export const MAX_IMAGE_EDGE_PIXELS = 4_096;

/**
 * Smallest edge length accepted, in pixels.
 *
 * Below this there is nothing for a vision model to see, so the request would spend credit to
 * produce a confident description of noise. Refusing early is kinder than charging for it.
 */
export const MIN_IMAGE_EDGE_PIXELS = 16;

/**
 * Which optional controls one vision model exposes.
 *
 * Published per model through the catalogue, exactly as {@link ImageControlSupport} is for Create
 * Image, and for the same reason: the reviewed models genuinely disagree, and the UI must render
 * only what the server will accept.
 */
export interface VisionControlSupport {
  /**
   * Whether the model _requires_ a question rather than merely accepting one.
   *
   * The sharpest disagreement between the two reviewed models. LLaVA's schema requires only an
   * image, so it will caption a picture with no question at all. Llama 3.2 Vision marks `prompt` as
   * required with `minLength: 1`, so the same empty-question request is simply invalid. The panel
   * therefore makes the question field mandatory or optional depending on the selection, rather
   * than inventing a placeholder question to paper over the difference.
   */
  instructionRequired: boolean;
  /**
   * Accepted range for the answer-length cap, with the model's own default.
   *
   * Both reviewed models expose this and default differently — 512 tokens against 256 — which is
   * visible to a visitor as one model answering at roughly twice the length of the other for the
   * same picture.
   */
  maxTokens?: NumericVisionRange;
}

/**
 * A numeric control a vision model exposes, with the range the server will accept.
 *
 * Structurally identical to Create Image's `NumericControlRange` but deliberately a separate type.
 * Sharing one type would couple the two panels' contracts, so a later change to an image-generation
 * control would silently alter what this panel advertises.
 */
export interface NumericVisionRange {
  /**
   * Lowest accepted value, inclusive.
   */
  min: number;
  /**
   * Highest accepted value, inclusive.
   */
  max: number;
  /**
   * Granularity for the UI control. Does not constrain validation.
   */
  step: number;
  /**
   * Value the model uses when the control is omitted.
   */
  default: number;
}

/**
 * Every control name a Describe Image request may carry.
 *
 * Used by validation to name the offending control in an error, and by tests to walk the full set
 * rather than a hand-written subset that could fall behind.
 */
export const VISION_CONTROL_NAMES = ['maxTokens'] as const;

/**
 * One optional Describe Image control; see {@link VISION_CONTROL_NAMES}.
 */
export type VisionControlName = (typeof VISION_CONTROL_NAMES)[number];

/**
 * What the browser posts to describe a picture.
 *
 * As with Chat and Create Image there is no identity field and no way to supply one: the actor
 * comes from the verified Access JWT alone, and the domain rejects a body that carries one rather
 * than ignoring it.
 */
export interface DescribeImageRequest {
  /**
   * The picture, base64-encoded.
   *
   * Carried in the JSON body rather than as `multipart/form-data`. The panel's other fields are
   * JSON already, and a single body shape means one validation path and one size limit instead of
   * two. The cost is roughly a third in transfer size, which is bounded by
   * {@link MAX_INPUT_IMAGE_BYTES}.
   *
   * No media type travels with it, and that is deliberate. The server identifies the format from
   * the bytes themselves; a declared type would be a value the browser chose, which is exactly the
   * thing this panel must not rely on.
   */
  imageBase64: string;
  /**
   * Reviewed model identifier, which must be registered against the `describe-image` panel.
   */
  model: string;
  /**
   * Opaque run identifier generated by the browser, so the UI can correlate its pending state with
   * the receipt.
   */
  runId: string;
  /**
   * What to ask about the picture. Required for a model that declares
   * {@link VisionControlSupport.instructionRequired}.
   */
  instruction?: string;
  /**
   * Longest answer to generate, within the selected model's declared range.
   */
  maxTokens?: number;
}

/**
 * Facts about the submitted picture, as the server verified them.
 *
 * Returned so the panel can state what it actually sent rather than what the browser believed it
 * was sending. When a visitor's file manager says "PNG" and the bytes say JPEG, this is where the
 * discrepancy becomes visible instead of silently resolving itself.
 */
export interface VerifiedImageFacts {
  /**
   * Media type determined by inspecting the bytes, never by trusting a declaration.
   */
  mediaType: string;
  /**
   * Decoded size in bytes.
   */
  byteLength: number;
  /**
   * Width in pixels, read from the file header.
   */
  width: number;
  /**
   * Height in pixels, read from the file header.
   */
  height: number;
}

/**
 * The settings one description was produced with.
 */
export interface AppliedVisionControls {
  /**
   * Model identifier that produced the description.
   */
  model: string;
  /**
   * The question as sent, after trimming. Absent when the model accepts a bare picture and the
   * visitor asked nothing.
   */
  instruction?: string;
  /**
   * Answer-length cap applied, including a model default the caller did not set.
   */
  maxTokens?: number;
}

/**
 * What the Describe Image endpoint returns on success.
 */
export interface DescribeImageResponse {
  /**
   * The model's description of the picture.
   */
  description: string;
  /**
   * What the server verified about the submitted picture; see {@link VerifiedImageFacts}.
   */
  image: VerifiedImageFacts;
  /**
   * The run receipt, whose `costStatus` is `pending` whenever a gateway log exists to poll for.
   */
  receipt: RunReceipt;
  /**
   * The controls the server actually applied, including the defaults it filled in.
   */
  applied: AppliedVisionControls;
}
