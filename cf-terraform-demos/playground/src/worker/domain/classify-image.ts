/**
 * @file Classify Image request validation, model-input construction, and response ranking. The
 *   previous panels' lesson was that models disagree about controls and about what is required.
 *   This panel's lesson is different: the reviewed classifier has _no_ controls at all. Its schema
 *   is the image and nothing else, so the top-k and confidence floor a visitor sets are applied
 *   here, to the response, and never forwarded as request fields. That makes the ranking step part
 *   of the domain rather than a presentation detail. Ordering, truncation, and the confidence floor
 *   all decide what a visitor is told about the model's output, so they are implemented and tested
 *   where every transport gets the same behaviour — rather than in a Vue component where a second
 *   caller would re-invent them differently. The scores themselves are passed through untouched.
 *   Nothing here rescales, normalises, or renormalises them after filtering: a set of scores that
 *   no longer sums to anything meaningful is the honest consequence of hiding some, and adjusting
 *   them to compensate would be inventing output the model did not produce.
 */

import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';
import {
  MAX_CLASSIFICATION_LABELS,
  type AppliedClassificationControls,
  type ClassificationControlName,
  type ClassificationLabel,
  type NumericClassificationRange
} from '../../shared/classify-image';
import { isPlausibleRunId } from './chat';
import { validateInputImage, type ValidatedInputImage } from './input-image';
import { findModelForTask, type ModelDescriptor } from './models';

/**
 * A Classify Image request that has passed validation.
 *
 * A distinct type from the untrusted wire shape, as in every other panel, so a function requiring
 * it cannot be handed unvalidated input.
 */
export interface ValidatedClassifyImageRequest {
  /**
   * The verified picture: decoded bytes plus the facts established about them.
   */
  source: ValidatedInputImage;
  /**
   * The reviewed descriptor the requested identifier resolved to.
   */
  model: ModelDescriptor;
  /**
   * Opaque run identifier supplied by the browser.
   */
  runId: string;
  /**
   * Number of labels to keep, within the model's declared range.
   */
  topK?: number;
  /**
   * Score floor to apply, within the model's declared range.
   */
  minimumConfidence?: number;
}

/**
 * Fields a request body must not contain.
 *
 * Identical in purpose to the other panels' lists: the actor comes from the verified Access
 * identity, so a body carrying one of these is attempting to choose who the request is attributed
 * to, and is rejected rather than quietly corrected.
 */
const FORBIDDEN_FIELDS: readonly string[] = ['user', 'email', 'actor', 'sub'];

/**
 * Fields that would let a caller describe the image rather than let the server determine it.
 *
 * Rejected rather than ignored, exactly as Describe Image rejects them. A caller who sends
 * `mediaType` believes it matters; accepting and discarding it would teach them it worked.
 */
const SELF_DESCRIBED_IMAGE_FIELDS: readonly string[] = [
  'mediaType',
  'contentType',
  'mimeType',
  'width',
  'height',
  'fileName'
];

/**
 * Fields that belong to a generative panel and have no meaning for a classifier.
 *
 * A classifier has nothing to be asked: it scores a picture against the fixed label set it was
 * trained on, and no prompt changes that. Refusing these explicitly, with a message saying so, is
 * more useful than silently ignoring them — a caller sending `instruction` has misunderstood what
 * this panel does, and an ignored field would let them keep believing it.
 */
const GENERATIVE_FIELDS: readonly string[] = [
  'instruction',
  'prompt',
  'question',
  'negativePrompt'
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
 * Validates an optional numeric control against a model's declared range.
 *
 * @param value Untrusted value, possibly absent.
 * @param control Control being validated, used in error messages.
 * @param range The model's declared range, or `undefined` when it does not expose this control.
 * @param model Model the request was made against.
 * @param wholeNumber Whether the control must be an integer. `topK` counts labels and must be; a
 *   confidence floor is a fraction and must not be.
 * @returns The value, or `undefined` when the caller omitted it.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the model does not support the control,
 *   when the value is not a finite number, when a whole-number control is fractional, or when it
 *   falls outside the declared range.
 */
function validateControl(
  value: unknown,
  control: ClassificationControlName,
  range: NumericClassificationRange | undefined,
  model: ModelDescriptor,
  wholeNumber: boolean
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (range === undefined) {
    throw badRequest({
      detail:
        `${model.name} does not support "${control}". Choose a model that offers that control, or `
        + 'remove it from the request.'
    });
  }

  // `NaN` and `Infinity` both serialise to `null` in JSON and would otherwise reach the ranking
  // step as a comparison that silently discards every label.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badRequest({ detail: `"${control}" must be a number.` });
  }

  if (wholeNumber && !Number.isInteger(value)) {
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
 * Validates an untrusted Classify Image request body.
 *
 * @param body Parsed JSON request body, of unknown shape.
 * @returns The validated request with its model resolved and its image verified; see
 *   {@link ValidatedClassifyImageRequest}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is not an object; when it
 *   carries an identity field, a self-described image field, or a generative field this panel has
 *   no use for; when `runId` is malformed; when `model` is not a reviewed model registered against
 *   this panel; when a control is unsupported by that model or outside its declared range; or when
 *   the picture is missing, undecodable, oversized, an unsupported format, or outside the pixel
 *   limits.
 */
export function validateClassifyImageRequest(body: unknown): ValidatedClassifyImageRequest {
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

  for (const field of SELF_DESCRIBED_IMAGE_FIELDS) {
    if (Object.hasOwn(source, field)) {
      throw badRequest({
        detail:
          `Request body must not contain "${field}". The server determines the picture\u2019s `
          + 'format and dimensions from its bytes.'
      });
    }
  }

  for (const field of GENERATIVE_FIELDS) {
    if (Object.hasOwn(source, field)) {
      throw badRequest({
        detail:
          `Request body must not contain "${field}". A classifier scores a picture against the `
          + 'fixed label set it was trained on; there is nothing to ask it.'
      });
    }
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

  // Resolved against this panel specifically. Accepting a model identifier without confirming it
  // belongs to this panel is how a narrow task API becomes a generic `{ model, input }` proxy.
  const model = findModelForTask('classify-image', modelId);
  if (model === undefined) {
    throw badRequest({
      detail: 'That model is not one of the reviewed models available for Classify Image.'
    });
  }

  const controls = model.classificationControls;
  if (controls === undefined) {
    throw badRequest({ detail: 'That model has no reviewed classification controls.' });
  }

  const topK = validateControl(property(source, 'topK'), 'topK', controls.topK, model, true);
  const minimumConfidence = validateControl(
    property(source, 'minimumConfidence'),
    'minimumConfidence',
    controls.minimumConfidence,
    model,
    false
  );

  const image = validateInputImage(property(source, 'imageBase64'), 'imageBase64', 'classify');

  return {
    source: image,
    model,
    runId,
    ...(topK === undefined ? {} : { topK }),
    ...(minimumConfidence === undefined ? {} : { minimumConfidence })
  };
}

/**
 * Builds the model input for a validated Classify Image request.
 *
 * The image travels as an array of byte values, which is the form the reviewed model's schema
 * documents for its `image` field. It is a wasteful encoding — one JSON number per byte — and it is
 * what the contract specifies, so the descriptor follows the schema rather than an assumption about
 * what the binding might also accept.
 *
 * Nothing else is sent. The schema declares `image` and no other property, so forwarding the
 * visitor's top-k would be sending a model a field it never agreed to accept.
 *
 * @param request A validated request.
 * @returns The provider-shaped input payload.
 */
export function buildClassifyImageInput(
  request: ValidatedClassifyImageRequest
): Record<string, unknown> {
  return { image: [...request.source.bytes] };
}

/**
 * Orders a classifier's labels and applies the result controls.
 *
 * Sorting is by descending score with the label name as a tiebreak. The tiebreak exists because a
 * classifier returning two identical scores is ordinary, and an unstable order would make the same
 * picture produce a different ranking between runs — which looks like model behaviour and is not.
 *
 * The floor is applied before the truncation, so "top 5 above 0.1" means the five best labels that
 * clear the floor rather than whatever survives the floor out of the best five. Both readings are
 * defensible; this one is the one a visitor expects when they raise a threshold and see the list
 * stay full.
 *
 * @param labels Labels as the provider reported them, in any order.
 * @param request The validated request, whose controls decide what survives.
 * @returns The surviving labels, highest score first, each carrying its rank. Empty when every
 *   label scored below the floor, which is an ordinary outcome rather than a failure.
 */
export function rankClassificationLabels(
  labels: readonly { label: string; score: number }[],
  request: ValidatedClassifyImageRequest
): ClassificationLabel[] {
  const controls = request.model.classificationControls;
  const floor = request.minimumConfidence ?? controls?.minimumConfidence?.default ?? 0;
  const limit = Math.min(
    request.topK ?? controls?.topK?.default ?? MAX_CLASSIFICATION_LABELS,
    MAX_CLASSIFICATION_LABELS
  );

  return labels
    .filter((entry) => entry.score >= floor)
    .toSorted((left, right) =>
      right.score === left.score ? left.label.localeCompare(right.label) : right.score - left.score
    )
    .slice(0, limit)
    .map((entry, index) => ({ rank: index + 1, label: entry.label, score: entry.score }));
}

/**
 * Describes the settings a classification was actually produced with.
 *
 * Model defaults are filled in for controls the caller omitted, so the panel can report what
 * produced a result rather than only what was explicitly chosen.
 *
 * @param request A validated request.
 * @returns The applied controls; see {@link AppliedClassificationControls}.
 */
export function describeAppliedClassificationControls(
  request: ValidatedClassifyImageRequest
): AppliedClassificationControls {
  const controls = request.model.classificationControls;
  const topK = controls?.topK === undefined ? undefined : (request.topK ?? controls.topK.default);
  const minimumConfidence =
    controls?.minimumConfidence === undefined
      ? undefined
      : (request.minimumConfidence ?? controls.minimumConfidence.default);

  return {
    model: request.model.id,
    ...(topK === undefined ? {} : { topK }),
    ...(minimumConfidence === undefined ? {} : { minimumConfidence })
  };
}
