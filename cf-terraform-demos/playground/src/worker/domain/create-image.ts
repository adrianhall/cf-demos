/**
 * @file Create Image request validation and model-input construction. The interesting rule here,
 *   and the one the phase exists to demonstrate, is that a control is validated against the
 *   _selected model's_ declared capability rather than against a fixed schema for the panel. Asking
 *   FLUX.1 for a negative prompt is not a slightly-wrong request that a provider will quietly
 *   ignore; its input schema sets `additionalProperties: false`, so the request is simply invalid.
 *   Asking for 20 steps is within range for Stable Diffusion XL and outside it for FLUX, whose
 *   ceiling is 8. Refusing an unsupported control with a message that names both the control and
 *   the model is therefore more useful than silently dropping it: dropping teaches a visitor that
 *   the control did nothing, when the truth is that this model does not have it.
 */

import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';
import {
  MAX_NEGATIVE_PROMPT_CHARACTERS,
  MAX_PROMPT_CHARACTERS,
  type AppliedImageControls,
  type ImageControlName,
  type NumericControlRange
} from '../../shared/images';
import { isPlausibleRunId } from './chat';
import { findModelForTask, type ModelDescriptor } from './models';

/**
 * A Create Image request that has passed validation.
 *
 * As with Chat, this is a distinct type from the untrusted wire shape, so a function requiring it
 * cannot be handed unvalidated input. Every optional field present here has been checked against
 * the resolved model's declared support.
 */
export interface ValidatedCreateImageRequest {
  /**
   * Trimmed prompt.
   */
  prompt: string;
  /**
   * The reviewed descriptor the requested identifier resolved to.
   */
  model: ModelDescriptor;
  /**
   * Opaque run identifier supplied by the browser.
   */
  runId: string;
  /**
   * Trimmed negative prompt, present only for a model that supports one.
   */
  negativePrompt?: string;
  /**
   * Width in pixels, within the model's declared range.
   */
  width?: number;
  /**
   * Height in pixels, within the model's declared range.
   */
  height?: number;
  /**
   * Diffusion steps, within the model's declared range.
   */
  steps?: number;
  /**
   * Guidance, within the model's declared range.
   */
  guidance?: number;
  /**
   * Seed, present only for a model that accepts one.
   */
  seed?: number;
}

/**
 * Largest seed accepted.
 *
 * Bounded to a 32-bit unsigned value: providers treat a seed as an integer, and a number beyond
 * `Number.MAX_SAFE_INTEGER` would lose precision in JSON and silently reproduce a different image
 * from the one a visitor thought they had pinned.
 */
export const MAX_SEED = 4_294_967_295;

/**
 * Fields a request body must not contain.
 *
 * Identical in purpose to Chat's list: the actor comes from the verified Access identity, so a body
 * carrying one of these is attempting to choose who the request is attributed to, and is rejected
 * rather than quietly corrected.
 */
const FORBIDDEN_FIELDS: readonly string[] = ['user', 'email', 'actor', 'sub'];

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
 * Refuses a control the selected model does not support.
 *
 * @param control Control the caller supplied.
 * @param model Model it was requested against.
 * @returns Never; it always throws.
 * @throws {ProblemDetailsError} `badRequest()` (400) naming both the control and the model, so the
 *   caller learns which model to switch to rather than only that something was wrong.
 */
function unsupported(control: ImageControlName, model: ModelDescriptor): never {
  throw badRequest({
    detail:
      `${model.name} does not support "${control}". Choose a model that offers that control, or `
      + 'remove it from the request.'
  });
}

/**
 * Validates an optional integer control against a model's declared range.
 *
 * @param value Untrusted value, possibly absent.
 * @param control Control being validated, used in error messages.
 * @param range The model's declared range, or `undefined` when it does not expose this control.
 * @param model Model the request was made against.
 * @param integerOnly Whether a fractional value should be refused. Steps and dimensions are
 *   integers in both providers' schemas; guidance is not.
 * @returns The value, or `undefined` when the caller omitted it.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the model does not support the control,
 *   when the value is not a finite number, when a fractional value is given for an integer control,
 *   or when it falls outside the declared range.
 */
function validateControl(
  value: unknown,
  control: ImageControlName,
  range: NumericControlRange | undefined,
  model: ModelDescriptor,
  integerOnly: boolean
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (range === undefined) {
    unsupported(control, model);
  }

  // `NaN` and `Infinity` both serialise to `null` in JSON and would reach the provider as an absent
  // option, making a rejected value look accepted.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badRequest({ detail: `"${control}" must be a number.` });
  }

  if (integerOnly && !Number.isInteger(value)) {
    throw badRequest({ detail: `"${control}" must be a whole number.` });
  }

  if (value < range.min || value > range.max) {
    throw badRequest({
      detail:
        `"${control}" must be between ${range.min} and ${range.max} for ${model.name}. `
        + 'Each model declares its own range.'
    });
  }

  return value;
}

/**
 * Validates a text control.
 *
 * @param value Untrusted value, possibly absent.
 * @param control Control being validated.
 * @param supported Whether the model accepts it.
 * @param maxCharacters Longest accepted length.
 * @param model Model the request was made against.
 * @returns The trimmed text, or `undefined` when absent or empty after trimming.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the model does not support the control,
 *   when the value is not a string, or when it is too long.
 */
function validateText(
  value: unknown,
  control: ImageControlName,
  supported: boolean,
  maxCharacters: number,
  model: ModelDescriptor
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!supported) {
    unsupported(control, model);
  }

  if (typeof value !== 'string') {
    throw badRequest({ detail: `"${control}" must be a string.` });
  }

  const trimmed = value.trim();
  // An empty negative prompt is the same as not having one. Treating it as absent avoids sending a
  // provider a blank string to interpret.
  if (trimmed === '') {
    return undefined;
  }

  if ([...trimmed].length > maxCharacters) {
    throw badRequest({
      detail: `"${control}" exceeds the ${maxCharacters.toLocaleString()}-character limit.`
    });
  }

  return trimmed;
}

/**
 * Validates an untrusted Create Image request body.
 *
 * @param body Parsed JSON request body, of unknown shape.
 * @returns The validated request with its model resolved to a reviewed descriptor; see
 *   {@link ValidatedCreateImageRequest}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is not an object; when it
 *   carries an identity field; when the prompt is absent, empty, or over-long; when `runId` is
 *   malformed; when `model` is not a reviewed model registered against the Create Image panel; or
 *   when any control is unsupported by that model or outside its declared range.
 */
export function validateCreateImageRequest(body: unknown): ValidatedCreateImageRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest({ detail: 'Request body must be a JSON object.' });
  }

  const source = body as Record<string, unknown>;

  for (const field of FORBIDDEN_FIELDS) {
    if (Object.hasOwn(source, field)) {
      throw badRequest({
        detail:
          `Request body must not contain "${field}". The user is taken from the verified `
          + 'Cloudflare Access identity.'
      });
    }
  }

  const rawPrompt = property(source, 'prompt');
  if (typeof rawPrompt !== 'string') {
    throw badRequest({ detail: 'Request body must contain a "prompt" string.' });
  }

  const prompt = rawPrompt.trim();
  if (prompt === '') {
    throw badRequest({ detail: 'Describe the image you want to generate.' });
  }

  if ([...prompt].length > MAX_PROMPT_CHARACTERS) {
    throw badRequest({
      detail: `The prompt exceeds the ${MAX_PROMPT_CHARACTERS.toLocaleString()}-character limit.`
    });
  }

  const runId = property(source, 'runId');
  if (typeof runId !== 'string' || !isPlausibleRunId(runId)) {
    throw badRequest({
      detail:
        'Request body must contain a "runId" of 8 to 64 characters, using letters, digits, '
        + 'hyphens, and underscores only.'
    });
  }

  const modelId = property(source, 'model');
  if (typeof modelId !== 'string') {
    throw badRequest({ detail: 'Request body must contain a "model" identifier.' });
  }

  // Resolved against this panel specifically. Looking a model up by identifier alone is how a
  // narrow task API becomes a generic `{ model, input }` proxy.
  const model = findModelForTask('create-image', modelId);
  if (model === undefined) {
    throw badRequest({
      detail: 'That model is not one of the reviewed models available for Create Image.'
    });
  }

  // A text-to-image descriptor without declared controls would mean the reviewed list was filled in
  // incompletely. Failing loudly beats forwarding an unvalidated request.
  const controls = model.imageControls;
  if (controls === undefined) {
    throw badRequest({ detail: 'That model has no reviewed image controls.' });
  }

  const negativePrompt = validateText(
    property(source, 'negativePrompt'),
    'negativePrompt',
    controls.negativePrompt,
    MAX_NEGATIVE_PROMPT_CHARACTERS,
    model
  );

  const width = validateControl(
    property(source, 'width'),
    'width',
    controls.dimensions,
    model,
    true
  );
  const height = validateControl(
    property(source, 'height'),
    'height',
    controls.dimensions,
    model,
    true
  );
  const steps = validateControl(property(source, 'steps'), 'steps', controls.steps, model, true);
  const guidance = validateControl(
    property(source, 'guidance'),
    'guidance',
    controls.guidance,
    model,
    false
  );
  const seed = validateControl(
    property(source, 'seed'),
    'seed',
    controls.seed ? { min: 0, max: MAX_SEED, step: 1, default: 0 } : undefined,
    model,
    true
  );

  return {
    prompt,
    model,
    runId,
    ...(negativePrompt === undefined ? {} : { negativePrompt }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(steps === undefined ? {} : { steps }),
    ...(guidance === undefined ? {} : { guidance }),
    ...(seed === undefined ? {} : { seed })
  };
}

/**
 * Builds the model input for a validated Create Image request.
 *
 * Only fields the model declared are included, and the step parameter takes the name that model's
 * own schema uses — `steps` for FLUX, `num_steps` for Stable Diffusion XL. A model that forbids
 * undeclared properties therefore receives exactly the two fields it accepts.
 *
 * @param request A validated request.
 * @returns The provider-shaped input payload.
 */
export function buildCreateImageInput(
  request: ValidatedCreateImageRequest
): Record<string, unknown> {
  const controls = request.model.imageControls;
  const input: Record<string, unknown> = { prompt: request.prompt };

  if (controls === undefined) {
    return input;
  }

  if (request.negativePrompt !== undefined && controls.negativePrompt) {
    input['negative_prompt'] = request.negativePrompt;
  }

  if (controls.dimensions !== undefined) {
    if (request.width !== undefined) {
      input['width'] = request.width;
    }
    if (request.height !== undefined) {
      input['height'] = request.height;
    }
  }

  if (request.steps !== undefined && controls.steps !== undefined) {
    input[request.model.stepsParameterName ?? 'steps'] = request.steps;
  }

  if (request.guidance !== undefined && controls.guidance !== undefined) {
    input['guidance'] = request.guidance;
  }

  if (request.seed !== undefined && controls.seed) {
    input['seed'] = request.seed;
  }

  return input;
}

/**
 * Describes the settings an image was actually generated with.
 *
 * Model defaults are filled in for controls the caller omitted, so the gallery can show what
 * produced a result rather than only what was explicitly typed. A control the model does not
 * support is left absent rather than reported as a default of zero.
 *
 * @param request A validated request.
 * @returns The applied controls; see {@link AppliedImageControls}.
 */
export function describeAppliedControls(
  request: ValidatedCreateImageRequest
): AppliedImageControls {
  const controls = request.model.imageControls;

  /**
   * Resolves one numeric control to the value the provider will have used.
   *
   * @param supplied Value the caller sent, if any.
   * @param range The model's declared range, when it exposes this control.
   * @returns The supplied value, the model's documented default, or `undefined` when the model has
   *   no such control.
   */
  const resolve = (
    supplied: number | undefined,
    range: NumericControlRange | undefined
  ): number | undefined => {
    if (range === undefined) {
      return undefined;
    }
    return supplied ?? range.default;
  };

  return {
    prompt: request.prompt,
    model: request.model.id,
    ...(request.negativePrompt === undefined ? {} : { negativePrompt: request.negativePrompt }),
    ...(() => {
      const width = resolve(request.width, controls?.dimensions);
      return width === undefined ? {} : { width };
    })(),
    ...(() => {
      const height = resolve(request.height, controls?.dimensions);
      return height === undefined ? {} : { height };
    })(),
    ...(() => {
      const steps = resolve(request.steps, controls?.steps);
      return steps === undefined ? {} : { steps };
    })(),
    ...(() => {
      const guidance = resolve(request.guidance, controls?.guidance);
      return guidance === undefined ? {} : { guidance };
    })(),
    // A seed has no meaningful default: an omitted seed means the provider picks a random one, and
    // reporting a default of 0 would claim reproducibility the run does not have.
    ...(request.seed === undefined ? {} : { seed: request.seed })
  };
}
