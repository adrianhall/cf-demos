/**
 * @file Create Video request validation, model-input construction, and cost estimation. The panels
 *   before this one taught that models disagree about which controls exist. This one teaches
 *   something narrower and more irritating: two models can expose the _same_ control under
 *   different names, with differently spelled values. PixVerse takes `quality: "720p"`; Alibaba
 *   takes `resolution: "720P"`. A single hardcoded form would have to pick one and be wrong for the
 *   other, so the visitor's choice is expressed in this demo's own vocabulary and translated into
 *   the selected model's wire names here, from the descriptor, at the last moment. Cost estimation
 *   lives here too, which is a departure worth stating. Every other panel shows cost only _after_
 *   the gateway reports it, and that remains the authoritative figure. But this panel bills per
 *   second of output at rates that vary thirtyfold by resolution, so a visitor who learns the price
 *   only afterwards learns it too late. The estimate is computed in the domain so every transport
 *   quotes the same number, and it is labelled an estimate everywhere it appears.
 */

import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';
import {
  MAX_VIDEO_PROMPT_CHARACTERS,
  type AppliedVideoControls,
  type VideoControlName,
  type VideoControlSupport
} from '../../shared/create-video';
import { isPlausibleRunId } from './chat';
import { findModelForTask, type ModelDescriptor } from './models';

/**
 * A Create Video request that has passed validation.
 *
 * A distinct type from the untrusted wire shape, as in every other panel, so a function requiring
 * it cannot be handed unvalidated input. Every control is resolved here rather than left optional:
 * the model's defaults are filled in during validation, so the request builder and the cost
 * estimate both work from one settled set of values rather than each re-deriving the defaults.
 */
export interface ValidatedCreateVideoRequest {
  /**
   * Trimmed prompt.
   */
  prompt: string;
  /**
   * The reviewed descriptor the requested identifier resolved to.
   */
  model: ModelDescriptor;
  /**
   * The model's declared video controls, resolved from the descriptor so callers need not re-check
   * that a text-to-video descriptor carries them.
   */
  controls: VideoControlSupport;
  /**
   * Opaque run identifier supplied by the browser.
   */
  runId: string;
  /**
   * Resolution to apply, guaranteed to be one of the model's declared values.
   */
  resolution: string;
  /**
   * Aspect ratio to apply, guaranteed to be one of the model's declared values.
   */
  aspectRatio: string;
  /**
   * Duration in seconds to apply, guaranteed to satisfy the model's range or choice set.
   */
  duration: number;
  /**
   * Trimmed negative prompt, when the model supports one and the caller supplied it.
   */
  negativePrompt?: string;
  /**
   * Seed, when the model accepts one and the caller supplied it.
   */
  seed?: number;
  /**
   * Whether to generate audio, when the model can.
   */
  generateAudio?: boolean;
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
function unsupported(control: VideoControlName, model: ModelDescriptor): never {
  throw badRequest({
    detail: `${model.name} does not accept ${control}. Remove it or choose a model that supports it.`
  });
}

/**
 * Validates an optional string control against the model's declared values.
 *
 * Compared exactly rather than case-insensitively, deliberately. The reviewed models spell their
 * resolutions differently — `720p` against `720P` — and accepting either spelling here would mean
 * forwarding a value the provider's own enum rejects, turning a clear client error into an opaque
 * provider one.
 *
 * @param value Untrusted value, possibly absent.
 * @param control Control being validated, used in error messages.
 * @param allowed The model's declared values.
 * @param fallback Value to use when the caller omitted the control.
 * @param model Model the request was made against.
 * @returns The chosen value, or the fallback.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the value is not a string or is not one
 *   of the declared values.
 */
function validateChoice(
  value: unknown,
  control: VideoControlName,
  allowed: readonly string[],
  fallback: string,
  model: ModelDescriptor
): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw badRequest({
      detail: `${control} must be one of ${allowed.join(', ')} for ${model.name}.`
    });
  }
  return value;
}

/**
 * Validates the duration against whichever form the model declares.
 *
 * A model declares either a continuous range or a fixed set of permitted lengths, never both, so
 * this handles each form separately rather than trying to express one in terms of the other.
 *
 * @param value Untrusted value, possibly absent.
 * @param controls The model's declared video controls.
 * @param model Model the request was made against.
 * @returns The duration in seconds to apply.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the value is not a whole number, falls
 *   outside a declared range, or is not among a declared set.
 */
function validateDuration(
  value: unknown,
  controls: VideoControlSupport,
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
        detail: `${model.name} accepts a duration of ${durationChoices.join(', ')} seconds.`
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
 * @param controls The model's declared video controls.
 * @param model Model the request was made against.
 * @returns The seed, or `undefined` when the caller omitted it.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the model accepts no seed, or the value
 *   is not a whole number within the catalogue's documented bounds.
 */
function validateSeed(
  value: unknown,
  controls: VideoControlSupport,
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
 * Validates a Create Video request body.
 *
 * @param body Parsed, untrusted JSON body.
 * @returns A validated request with every control resolved; see
 *   {@link ValidatedCreateVideoRequest}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is not an object, carries an
 *   identity or job-naming field, names an unknown or wrong-panel model, omits or oversizes the
 *   prompt, supplies an implausible run identifier, or sets a control the model does not support or
 *   whose value falls outside the model's declared values.
 */
export function validateCreateVideoRequest(body: unknown): ValidatedCreateVideoRequest {
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

  const modelId = property(source, 'model');
  if (typeof modelId !== 'string' || modelId.trim() === '') {
    throw badRequest({ detail: 'A model identifier is required.' });
  }

  // Resolved against this panel's registered models, so a descriptor belonging to another panel is
  // rejected rather than silently driven with the wrong request shape.
  const model = findModelForTask('create-video', modelId);
  if (model === undefined) {
    throw badRequest({ detail: `${modelId} is not a model this panel can use.` });
  }

  const controls = model.videoControls;
  if (controls === undefined) {
    // A reviewed text-to-video descriptor without controls is a repository fault rather than a
    // caller fault, and saying so plainly beats a misleading 400 about the request.
    throw new Error(`${model.id} is registered for create-video but declares no videoControls.`);
  }

  const promptValue = property(source, 'prompt');
  if (typeof promptValue !== 'string') {
    throw badRequest({ detail: 'A prompt is required.' });
  }
  const prompt = promptValue.trim();
  if (prompt === '') {
    throw badRequest({ detail: 'A prompt is required.' });
  }
  if (prompt.length > MAX_VIDEO_PROMPT_CHARACTERS) {
    throw badRequest({
      detail: `The prompt must be ${MAX_VIDEO_PROMPT_CHARACTERS} characters or fewer.`
    });
  }

  const runId = property(source, 'runId');
  if (typeof runId !== 'string' || !isPlausibleRunId(runId)) {
    throw badRequest({ detail: 'A valid run identifier is required.' });
  }

  const negativePromptValue = property(source, 'negativePrompt');
  let negativePrompt: string | undefined;
  if (negativePromptValue !== undefined) {
    if (!controls.negativePrompt) {
      return unsupported('negativePrompt', model);
    }
    if (typeof negativePromptValue !== 'string') {
      throw badRequest({ detail: 'negativePrompt must be text.' });
    }
    const trimmed = negativePromptValue.trim();
    if (trimmed.length > MAX_VIDEO_PROMPT_CHARACTERS) {
      throw badRequest({
        detail: `The negative prompt must be ${MAX_VIDEO_PROMPT_CHARACTERS} characters or fewer.`
      });
    }
    // An empty negative prompt is treated as absent rather than forwarded as an empty string: a
    // provider is entitled to treat `""` as a meaningful value.
    negativePrompt = trimmed === '' ? undefined : trimmed;
  }

  const audioValue = property(source, 'generateAudio');
  let generateAudio: boolean | undefined;
  if (audioValue !== undefined) {
    if (controls.audioParameterName === undefined) {
      return unsupported('generateAudio', model);
    }
    if (typeof audioValue !== 'boolean') {
      throw badRequest({ detail: 'generateAudio must be true or false.' });
    }
    generateAudio = audioValue;
  }

  const seed = validateSeed(property(source, 'seed'), controls, model);

  return {
    prompt,
    model,
    controls,
    runId,
    resolution: validateChoice(
      property(source, 'resolution'),
      'resolution',
      controls.resolutions,
      controls.defaultResolution,
      model
    ),
    aspectRatio: validateChoice(
      property(source, 'aspectRatio'),
      'aspectRatio',
      controls.aspectRatios,
      controls.defaultAspectRatio,
      model
    ),
    duration: validateDuration(property(source, 'duration'), controls, model),
    ...(negativePrompt === undefined ? {} : { negativePrompt }),
    ...(seed === undefined ? {} : { seed }),
    ...(generateAudio === undefined ? {} : { generateAudio })
  };
}

/**
 * Estimates what a request will cost, in US dollars.
 *
 * Deliberately a plain multiplication of the model's published per-second price by the requested
 * duration, and deliberately _not_ reconciled with the gateway's figure afterwards. It exists so a
 * visitor knows the order of magnitude before spending it; the authoritative number always comes
 * from the AI Gateway log, and the UI labels this one an estimate wherever it appears.
 *
 * Audio, where a model supports it, is charged at a higher rate than the silent price list quoted
 * here, so an estimate for a run with audio is a floor rather than a prediction. That is stated in
 * the UI rather than papered over with a second price table this demo has not reviewed.
 *
 * @param request A validated request, whose duration and resolution are already settled.
 * @returns The estimated cost in US dollars, or `0` when the model published no price for the
 *   selected resolution — an unknown price is reported as unknown by the caller rather than
 *   guessed.
 */
export function estimateVideoCostUsd(request: ValidatedCreateVideoRequest): number {
  const perSecond = request.controls.pricePerSecondUsd[request.resolution];
  if (perSecond === undefined) {
    return 0;
  }
  return perSecond * request.duration;
}

/**
 * Builds the model input for a validated request.
 *
 * This is where this demo's control vocabulary becomes the selected model's. The wire names come
 * from the reviewed descriptor rather than from a conditional on the model identifier, so adding a
 * third model means filling in a descriptor rather than editing this function.
 *
 * Only declared controls are ever included. A model that declares no audio parameter has no audio
 * field in its request, rather than one set to `false` — several of these schemas set
 * `additionalProperties: false`, which makes an undeclared field a request the provider is entitled
 * to reject outright.
 *
 * @param request A validated request.
 * @returns The provider payload, using the model's own parameter names.
 */
export function buildCreateVideoInput(
  request: ValidatedCreateVideoRequest
): Record<string, unknown> {
  const { controls } = request;

  const input: Record<string, unknown> = {
    prompt: request.prompt,
    [controls.resolutionParameterName]: request.resolution,
    [controls.aspectParameterName]: request.aspectRatio,
    duration: request.duration
  };

  if (request.negativePrompt !== undefined) {
    input['negative_prompt'] = request.negativePrompt;
  }
  if (request.seed !== undefined) {
    input['seed'] = request.seed;
  }
  if (controls.audioParameterName !== undefined && request.generateAudio !== undefined) {
    input[controls.audioParameterName] = request.generateAudio;
  }

  return input;
}

/**
 * Describes the controls a request will be run with, for echoing back to the browser.
 *
 * @param request A validated request.
 * @returns The applied controls including filled-in defaults and the cost estimate; see
 *   {@link AppliedVideoControls}.
 */
export function describeAppliedVideoControls(
  request: ValidatedCreateVideoRequest
): AppliedVideoControls {
  return {
    prompt: request.prompt,
    model: request.model.id,
    resolution: request.resolution,
    aspectRatio: request.aspectRatio,
    duration: request.duration,
    ...(request.negativePrompt === undefined ? {} : { negativePrompt: request.negativePrompt }),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    ...(request.generateAudio === undefined ? {} : { generateAudio: request.generateAudio }),
    estimatedCostUsd: estimateVideoCostUsd(request)
  };
}
