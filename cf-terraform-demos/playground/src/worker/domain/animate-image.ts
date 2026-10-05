/**
 * @file Animate Image request validation, model-input construction, and cost estimation. Create
 *   Video taught that two models can expose the same control under different names. This panel
 *   pushes that further in two directions, and both are the phase's teaching point rather than
 *   incidental friction. **The source image has four different wire names.** `image`,
 *   `first_frame_image`, `image_uri`, and `image_input` — one concept, four spellings, across four
 *   reviewed models. A panel with a hardcoded request shape could drive exactly one of them. The
 *   visitor supplies "a picture", and {@link buildAnimateImageInput} reads the spelling from the
 *   descriptor at the last moment, in precisely the way Create Video reads `quality` against
 *   `resolution`. **Two models price in genuinely incompatible shapes.** Alibaba charges a flat
 *   per-second rate, so cost is a multiplication. MiniMax publishes $0.28 for six seconds and $0.56
 *   for ten at the same resolution — 4.67¢ and 5.6¢ a second — which does not reduce to a rate at
 *   all. Estimation therefore reads whichever shape the descriptor declares, and **refuses to
 *   interpolate**: an unpublished combination is reported as unknown rather than guessed, because a
 *   confidently wrong price is worse than an admitted gap in a panel whose subject is honest cost.
 *   The source picture is validated with the **shared byte-authoritative rules** every other image
 *   panel uses (`./input-image.ts`), with one extra ceiling of this panel's own: the picture has to
 *   fit inside a Workflow event parameter. See {@link MAX_ANIMATE_SOURCE_BYTES}.
 */

import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';
import {
  MAX_ANIMATE_SOURCE_BYTES,
  MAX_MOTION_PROMPT_CHARACTERS,
  priceCombinationKey,
  type AnimateControlName,
  type AnimateImageControlSupport,
  type AppliedAnimateImageControls
} from '../../shared/animate-image';
import { isPlausibleRunId } from './chat';
import { encodeBase64 } from './image-bytes';
import { validateInputImage, type ValidatedInputImage } from './input-image';
import { findModelForTask, type ModelDescriptor } from './models';

/**
 * An Animate Image request that has passed validation.
 *
 * A distinct type from the untrusted wire shape, as in every other panel, so a function requiring
 * it cannot be handed unvalidated input. Every control is resolved here rather than left optional:
 * the model's defaults are filled in during validation, so the request builder and the cost
 * estimate both work from one settled set of values rather than each re-deriving the defaults.
 */
export interface ValidatedAnimateImageRequest {
  /**
   * The verified source picture: its bytes, and the facts read from those bytes.
   */
  source: ValidatedInputImage;
  /**
   * The reviewed descriptor the requested identifier resolved to.
   */
  model: ModelDescriptor;
  /**
   * The model's declared animation controls, resolved from the descriptor so callers need not
   * re-check that an image-to-video descriptor carries them.
   */
  controls: AnimateImageControlSupport;
  /**
   * Opaque run identifier supplied by the browser.
   */
  runId: string;
  /**
   * Resolution to apply, guaranteed to be one of the model's declared values.
   */
  resolution: string;
  /**
   * Duration in seconds to apply, guaranteed to satisfy the model's range or choice set.
   */
  duration: number;
  /**
   * Trimmed motion prompt, when one was supplied or the model requires one.
   */
  motionPrompt?: string;
  /**
   * Trimmed negative prompt, when the model supports one and the caller supplied it.
   */
  negativePrompt?: string;
  /**
   * Seed, when the model accepts one and the caller supplied it.
   */
  seed?: number;
}

/**
 * Fields a request body must not contain.
 *
 * Identical in purpose to the other panels' lists: the actor comes from the verified Access
 * identity, so a body carrying one of these is attempting to choose who the request — and the
 * charge — is attributed to, and is rejected rather than quietly corrected.
 */
const FORBIDDEN_FIELDS: readonly string[] = ['user', 'email', 'actor', 'sub'];

/**
 * Fields that would let a caller name their own job or reach another visitor's.
 *
 * The job's identifier is derived from the verified identity and the run ID, never supplied. A body
 * carrying one of these is either confused about the contract or probing it, and both deserve an
 * explicit refusal rather than a silently ignored field.
 */
const FORBIDDEN_JOB_FIELDS: readonly string[] = ['jobId', 'instanceId', 'workflowId', 'videoKey'];

/**
 * Fields that would let a caller name the picture's location rather than supply its bytes.
 *
 * **This refusal is specific to this panel and is a security boundary rather than tidiness.** Every
 * reviewed model types its source image as a URI, so a caller who could set that field directly
 * would be choosing a URL for a third-party provider to fetch — turning this demo into an open
 * redirector for someone else's crawler, and pointing it at an internal address if they chose one.
 * The picture is supplied as bytes, verified from those bytes, and re-encoded by this demo; the URI
 * is never caller-controlled.
 */
const FORBIDDEN_IMAGE_SOURCE_FIELDS: readonly string[] = [
  'image',
  'imageUrl',
  'image_url',
  'imageUri',
  'image_uri',
  'first_frame_image',
  'image_input'
];

/**
 * Reads a plain object property without inheriting from the prototype chain.
 *
 * @param source Parsed JSON object.
 * @param key Property to read.
 * @returns The value, or `undefined` when the property is absent.
 */
function property(source: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

/**
 * Rejects a control the selected model does not support.
 *
 * @param control Control the caller tried to set.
 * @param model Model the request was made against.
 * @returns Never; always throws.
 * @throws {ProblemDetailsError} `badRequest()` (400) naming the control and the model.
 */
function unsupported(control: AnimateControlName, model: ModelDescriptor): never {
  throw badRequest({
    detail: `${model.name} does not accept ${control}. Remove it or choose a model that supports it.`
  });
}

/**
 * Validates the requested resolution against the model's declared values.
 *
 * Compared exactly rather than case-insensitively, deliberately. The reviewed models spell their
 * resolutions differently — `720P` against `768P` — and accepting a near-miss here would mean
 * forwarding a value the provider's own enum rejects, turning a clear client error into an opaque
 * provider one.
 *
 * @param value Untrusted value, possibly absent.
 * @param controls The model's declared animation controls.
 * @param model Model the request was made against.
 * @returns The chosen resolution, or the model's default.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the value is not a string or is not one
 *   of the declared values.
 */
function validateResolution(
  value: unknown,
  controls: AnimateImageControlSupport,
  model: ModelDescriptor
): string {
  if (value === undefined) {
    return controls.defaultResolution;
  }
  if (typeof value !== 'string' || !controls.resolutions.includes(value)) {
    throw badRequest({
      detail: `resolution must be one of ${controls.resolutions.join(', ')} for ${model.name}.`
    });
  }
  return value;
}

/**
 * Validates the duration against whichever form the model declares.
 *
 * A model declares either a continuous range or a fixed set of permitted lengths, never both, so
 * this handles each form separately rather than trying to express one in terms of the other. The
 * fixed-set form is not hypothetical here: MiniMax accepts exactly six or ten seconds, and a
 * request for eight is refused by its validator.
 *
 * @param value Untrusted value, possibly absent.
 * @param controls The model's declared animation controls.
 * @param model Model the request was made against.
 * @returns The duration in seconds to apply.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the value is not a whole number, falls
 *   outside a declared range, or is not among a declared set.
 */
function validateDuration(
  value: unknown,
  controls: AnimateImageControlSupport,
  model: ModelDescriptor
): number {
  if (value === undefined) {
    return controls.defaultDuration;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw badRequest({ detail: 'duration must be a whole number of seconds.' });
  }

  const { durationChoices, durationRange } = controls;
  if (durationChoices !== undefined) {
    if (!durationChoices.includes(value)) {
      throw badRequest({
        detail: `${model.name} accepts a duration of ${durationChoices.join(' or ')} seconds.`
      });
    }
    return value;
  }

  if (durationRange !== undefined) {
    if (value < durationRange.min || value > durationRange.max) {
      throw badRequest({
        detail: `duration must be between ${durationRange.min} and ${durationRange.max} seconds for ${model.name}.`
      });
    }
    return value;
  }

  return unsupported('duration', model);
}

/**
 * Validates an optional seed.
 *
 * @param value Untrusted value, possibly absent.
 * @param controls The model's declared animation controls.
 * @param model Model the request was made against.
 * @returns The seed, or `undefined` when the caller omitted it.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the model accepts no seed, or the value
 *   is not a whole number within the catalogue's documented bounds.
 */
function validateSeed(
  value: unknown,
  controls: AnimateImageControlSupport,
  model: ModelDescriptor
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!controls.seed) {
    return unsupported('seed', model);
  }
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value < 0
    || value > 2_147_483_647
  ) {
    throw badRequest({ detail: 'seed must be a whole number between 0 and 2147483647.' });
  }
  return value;
}

/**
 * Validates one optional free-text control.
 *
 * @param value Untrusted value, possibly absent.
 * @param label Control name used in error messages.
 * @returns The trimmed text, or `undefined` when absent or empty after trimming.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the value is not a string or exceeds
 *   {@link MAX_MOTION_PROMPT_CHARACTERS}.
 */
function validateText(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw badRequest({ detail: `${label} must be text.` });
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_MOTION_PROMPT_CHARACTERS) {
    throw badRequest({
      detail: `The ${label} must be ${MAX_MOTION_PROMPT_CHARACTERS} characters or fewer.`
    });
  }
  // An empty string is treated as absent rather than forwarded: a provider is entitled to treat
  // `""` as a meaningful value distinct from an omitted field.
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Validates an Animate Image request body.
 *
 * @param body Parsed, untrusted JSON body.
 * @returns A validated request with every control resolved; see
 *   {@link ValidatedAnimateImageRequest}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is not an object, carries an
 *   identity, job-naming, or image-location field, names an unknown or wrong-panel model, omits or
 *   oversizes the picture, supplies a picture this panel will not accept, supplies an implausible
 *   run identifier, omits a motion prompt the model requires, or sets a control the model does not
 *   support or whose value falls outside the model's declared values.
 * @throws {Error} When the resolved descriptor is registered for this panel but declares no
 *   animation controls, which is a repository fault rather than a caller fault.
 */
export function validateAnimateImageRequest(body: unknown): ValidatedAnimateImageRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest({ detail: 'The request body must be a JSON object.' });
  }

  const source = body as Record<string, unknown>;

  for (const field of FORBIDDEN_FIELDS) {
    if (property(source, field) !== undefined) {
      throw badRequest({
        detail: `The request must not carry ${field}. The signed-in identity is taken from the verified Access token.`
      });
    }
  }

  for (const field of FORBIDDEN_JOB_FIELDS) {
    if (property(source, field) !== undefined) {
      throw badRequest({
        detail: `The request must not carry ${field}. A job's identifier is derived from the verified identity and the run identifier, never supplied by the caller.`
      });
    }
  }

  for (const field of FORBIDDEN_IMAGE_SOURCE_FIELDS) {
    if (property(source, field) !== undefined) {
      throw badRequest({
        detail: `The request must not carry ${field}. Send the picture's bytes as imageBase64; this panel never fetches a picture from a location a caller named.`
      });
    }
  }

  const modelId = property(source, 'model');
  if (typeof modelId !== 'string' || modelId.trim() === '') {
    throw badRequest({ detail: 'A model identifier is required.' });
  }

  // Resolved against this panel's registered models, so a descriptor belonging to another panel is
  // rejected rather than silently driven with the wrong request shape. In particular a Create Video
  // model is refused here, because a text-to-video model has nowhere to put a picture.
  const model = findModelForTask('animate-image', modelId);
  if (model === undefined) {
    throw badRequest({ detail: `${modelId} is not a model this panel can use.` });
  }

  const controls = model.animateImageControls;
  if (controls === undefined) {
    // A reviewed image-to-video descriptor without controls is a repository fault rather than a
    // caller fault, and saying so plainly beats a misleading 400 about the request.
    throw new Error(`${model.id} is registered for animate-image but declares no controls.`);
  }

  // The shared byte-authoritative rules every image panel uses: the format and dimensions come from
  // the bytes' own headers, never from what the browser said about the file.
  const picture = validateInputImage(property(source, 'imageBase64'), 'imageBase64', 'animate');

  // This panel's own extra ceiling, applied after the shared rules rather than instead of them. The
  // picture has to survive a Workflow event parameter, which caps at 1 MiB *after* base64
  // expansion — so a picture the shared rules would accept can still be one this panel cannot
  // start a job with. Refusing it here, with the reason, beats a job that fails at creation.
  if (picture.bytes.length > MAX_ANIMATE_SOURCE_BYTES) {
    throw badRequest({
      detail: `That picture is ${Math.round(picture.bytes.length / 1_024)} KB, and this panel accepts up to ${Math.round(MAX_ANIMATE_SOURCE_BYTES / 1_024)} KB. The picture travels inside the generation job, which has a smaller payload limit than an ordinary request. Scale it down and try again.`
    });
  }

  const runId = property(source, 'runId');
  if (typeof runId !== 'string' || !isPlausibleRunId(runId)) {
    throw badRequest({ detail: 'A valid run identifier is required.' });
  }

  const motionPrompt = validateText(property(source, 'motionPrompt'), 'motion prompt');
  if (controls.motionPromptRequired && motionPrompt === undefined) {
    throw badRequest({
      detail: `${model.name} requires a motion prompt describing what should happen in the clip.`
    });
  }

  const negativePromptValue = property(source, 'negativePrompt');
  let negativePrompt: string | undefined;
  if (negativePromptValue !== undefined) {
    if (!controls.negativePrompt) {
      return unsupported('negativePrompt', model);
    }
    negativePrompt = validateText(negativePromptValue, 'negative prompt');
  }

  const seed = validateSeed(property(source, 'seed'), controls, model);

  return {
    source: picture,
    model,
    controls,
    runId,
    resolution: validateResolution(property(source, 'resolution'), controls, model),
    duration: validateDuration(property(source, 'duration'), controls, model),
    ...(motionPrompt === undefined ? {} : { motionPrompt }),
    ...(negativePrompt === undefined ? {} : { negativePrompt }),
    ...(seed === undefined ? {} : { seed })
  };
}

/**
 * What a request is expected to cost, and whether that figure is actually known.
 *
 * A pair rather than a bare number, because this panel has a third possible answer that Create
 * Video did not: not "cheap" or "expensive" but **"the provider has not published a price for this
 * combination"**. Returning `0` alone would make that indistinguishable from free.
 */
export interface AnimateCostEstimate {
  /**
   * Estimated cost in US dollars, or `0` when no published price covers the combination.
   */
  costUsd: number;
  /**
   * Whether a published price actually covered the requested combination.
   */
  known: boolean;
}

/**
 * Estimates what a request will cost, in US dollars.
 *
 * Reads whichever pricing shape the descriptor declares, and **never converts between them**. A
 * per-second model is a multiplication. A per-combination model is a table lookup, and a
 * combination the provider has not published is reported as unknown rather than interpolated from
 * the two it has — MiniMax's own figures imply 4.67¢ a second at six seconds and 5.6¢ at ten, so
 * any interpolation would be this demo inventing a number and presenting it as the provider's.
 *
 * Deliberately not reconciled with the gateway's figure afterwards. It exists so a visitor knows
 * the order of magnitude before spending it; the authoritative number always comes from the AI
 * Gateway log, and the UI labels this one an estimate wherever it appears.
 *
 * @param request A validated request, whose duration and resolution are already settled.
 * @returns The estimate and whether it is known; see {@link AnimateCostEstimate}.
 */
export function estimateAnimateCost(request: ValidatedAnimateImageRequest): AnimateCostEstimate {
  const { controls, resolution, duration } = request;

  const perSecond = controls.pricePerSecondUsd?.[resolution];
  if (perSecond !== undefined) {
    return { costUsd: perSecond * duration, known: true };
  }

  const exact = controls.priceByCombinationUsd?.[priceCombinationKey(resolution, duration)];
  if (exact !== undefined) {
    return { costUsd: exact, known: true };
  }

  return { costUsd: 0, known: false };
}

/**
 * Builds the model input for a validated request.
 *
 * This is where this demo's control vocabulary becomes the selected model's, and where the panel's
 * central disagreement is resolved: the source image's wire name comes from the reviewed descriptor
 * rather than from a conditional on the model identifier, so adding a fifth spelling means filling
 * in a descriptor rather than editing this function.
 *
 * The picture is re-encoded from the **verified bytes** into a `data:` URI whose media type is the
 * one sniffed from those bytes. Nothing the caller declared about the file reaches the provider,
 * and no URL the caller could name is ever fetched.
 *
 * Only declared controls are ever included. A model that declares no negative prompt has no such
 * field in its request rather than one set to an empty string — these schemas reject an undeclared
 * field outright, as every live probe confirmed.
 *
 * @param request A validated request.
 * @returns The provider payload, using the model's own parameter names.
 * @throws {Error} When the model declares a delivery mode other than `data-uri`, which would mean
 *   publishing the visitor's picture at a fetchable URL — something this panel does not do, and a
 *   descriptor fault rather than a caller fault.
 */
export function buildAnimateImageInput(
  request: ValidatedAnimateImageRequest
): Record<string, unknown> {
  const { controls } = request;

  if (controls.imageDelivery !== 'data-uri') {
    throw new Error(
      `${request.model.id} requires a fetchable HTTPS image URL, which this panel does not publish.`
    );
  }

  // Built from the sniffed media type and the verified bytes, so the provider receives exactly what
  // this demo inspected. See `domain/image-bytes.ts` for why the type is never the declared one.
  const sourceUri = `data:${request.source.facts.mediaType};base64,${encodeBase64(request.source.bytes)}`;

  const input: Record<string, unknown> = {
    [controls.imageParameterName]: sourceUri,
    resolution: request.resolution,
    duration: request.duration
  };

  if (request.motionPrompt !== undefined) {
    input['prompt'] = request.motionPrompt;
  }
  if (request.negativePrompt !== undefined) {
    input['negative_prompt'] = request.negativePrompt;
  }
  if (request.seed !== undefined) {
    input['seed'] = request.seed;
  }

  return input;
}

/**
 * Describes the controls a request will be run with, for echoing back to the browser.
 *
 * @param request A validated request.
 * @returns The applied controls including filled-in defaults, the verified source facts, and the
 *   cost estimate; see {@link AppliedAnimateImageControls}.
 */
export function describeAppliedAnimateControls(
  request: ValidatedAnimateImageRequest
): AppliedAnimateImageControls {
  const estimate = estimateAnimateCost(request);

  return {
    model: request.model.id,
    resolution: request.resolution,
    duration: request.duration,
    source: request.source.facts,
    ...(request.motionPrompt === undefined ? {} : { motionPrompt: request.motionPrompt }),
    ...(request.negativePrompt === undefined ? {} : { negativePrompt: request.negativePrompt }),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    estimatedCostUsd: estimate.costUsd,
    estimateKnown: estimate.known
  };
}
