/**
 * @file Classify Text request validation and model-input construction. Two rules shape this module,
 *   and they pull in opposite directions from the panel next door. **The caller cannot supply
 *   labels.** This panel is fixed-label classification: the categories belong to the model, and a
 *   request that tries to name one, add a criterion, or ask a question is refused rather than
 *   ignored. That is the boundary between this panel and Evaluate Choices, and refusing is what
 *   makes it a boundary rather than a convention — a body carrying `labels` would otherwise be
 *   silently dropped and the caller would believe it took effect. See
 *   {@link CALLER_DEFINED_CRITERIA_FIELDS}. **A control is validated against the selected model's
 *   declared capability**, as in every other panel, and here that distinction is unusually sharp:
 *   one reviewed model scores its labels and the other does not score anything at all. Asking a
 *   verdict model for a confidence floor is not a slightly-wrong request a provider will ignore —
 *   there is no score in its output to compare against. Refusing with a message naming both the
 *   control and the reason is more useful than dropping it, because dropping teaches a visitor that
 *   the floor was applied and found nothing.
 */

import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';
import {
  MAX_CLASSIFICATION_TEXT_CHARACTERS,
  MAX_TEXT_CLASSIFICATION_LABELS,
  type AppliedTextClassificationControls,
  type NumericTextClassificationRange,
  type ScoredClassificationLabel,
  type TextClassificationControlName
} from '../../shared/classify-text';
import { isPlausibleRunId } from './chat';
import { findModelForTask, type ModelDescriptor } from './models';

/**
 * A Classify Text request that has passed validation.
 *
 * A distinct type from the untrusted wire shape, as in every other panel, so a function requiring
 * it cannot be handed unvalidated input.
 */
export interface ValidatedClassifyTextRequest {
  /**
   * The text to classify, as submitted.
   */
  text: string;
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
 * Identical in purpose to every other panel's list: the actor comes from the verified Access
 * identity, so a body carrying one of these is attempting to choose who the request is attributed
 * to, and is rejected rather than quietly corrected.
 */
const FORBIDDEN_FIELDS: readonly string[] = ['user', 'email', 'actor', 'sub'];

/**
 * Fields through which a caller might try to define their own classification criteria.
 *
 * **The regression guard that keeps this panel distinct from Evaluate Choices.** A fixed-label
 * classifier's categories are a property of the trained model; they are not negotiable, and an API
 * that appeared to accept them would be teaching the opposite of what this panel exists to show.
 *
 * Refused rather than ignored, and with a message that points at the panel which _does_ take
 * caller-defined questions. Someone sending `labels` has a real need — they have simply arrived at
 * the wrong endpoint, and silently dropping the field would leave them believing their categories
 * were applied and that the model chose none of them.
 *
 * The list covers the plausible spellings rather than one, because this is a semantic boundary
 * rather than a schema detail: a future caller reaching for `categories` is making exactly the same
 * mistake as one reaching for `labels`.
 */
const CALLER_DEFINED_CRITERIA_FIELDS: readonly string[] = [
  'labels',
  'label',
  'categories',
  'category',
  'classes',
  'candidateLabels',
  'candidate_labels',
  'criteria',
  'question',
  'questions',
  'choices',
  'taxonomy',
  'hypothesis'
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
 * Validates one optional numeric control against the selected model's declared range.
 *
 * @param value Raw value from the request body.
 * @param name Control name, used in the error message.
 * @param range The model's declared range, or `undefined` when it does not support the control.
 * @param model The model the control was requested against.
 * @param unsupportedReason Why this model has no such control, stated so the refusal is actionable.
 * @returns The validated number, or `undefined` when the caller omitted it.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the model does not support the control,
 *   or when the value is not a finite number inside the declared range.
 */
function validateControl(
  value: unknown,
  name: TextClassificationControlName,
  range: NumericTextClassificationRange | undefined,
  model: ModelDescriptor,
  unsupportedReason: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (range === undefined) {
    throw badRequest({
      detail: `${model.name} does not accept "${name}". ${unsupportedReason}`
    });
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badRequest({ detail: `"${name}" must be a finite number.` });
  }

  if (value < range.min || value > range.max) {
    throw badRequest({
      detail: `"${name}" must be between ${range.min} and ${range.max} for ${model.name}.`
    });
  }

  return value;
}

/**
 * Validates an untrusted Classify Text request body.
 *
 * @param body Parsed JSON request body, of unknown shape.
 * @returns The validated request with its model resolved; see
 * {@link ValidatedClassifyTextRequest}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is not an object; when it
 *   carries an identity field; when it tries to supply its own labels, categories, or questions;
 *   when `runId` is malformed; when `model` is not a reviewed model registered against this panel;
 *   when the text is absent, empty, or longer than {@link MAX_CLASSIFICATION_TEXT_CHARACTERS}; or
 *   when a ranking control is supplied to a model that reports no scores, or falls outside the
 *   selected model's declared range.
 */
export function validateClassifyTextRequest(body: unknown): ValidatedClassifyTextRequest {
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

  // Checked before anything else about the request's content, because this is the panel's defining
  // boundary rather than a field-level detail. The message names Evaluate Choices, since a caller
  // sending these has a real need and simply wants a different task.
  for (const field of CALLER_DEFINED_CRITERIA_FIELDS) {
    if (Object.hasOwn(source, field)) {
      throw badRequest({
        detail:
          `Request body must not contain "${field}". This panel runs fixed-label classification: `
          + 'the labels belong to the trained model and cannot be supplied by the caller. Use '
          + 'Evaluate Choices for caller-defined questions and criteria.'
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

  // Resolved against this panel specifically. Looking a model up by identifier alone is how a
  // narrow task API becomes a generic `{ model, input }` proxy.
  const model = findModelForTask('classify-text', modelId);
  if (model === undefined) {
    throw badRequest({
      detail: 'That model is not one of the reviewed models available for Classify Text.'
    });
  }

  const controls = model.textClassificationControls;
  if (controls === undefined) {
    throw badRequest({ detail: 'That model has no reviewed classification controls.' });
  }

  const text = property(source, 'text');
  if (typeof text !== 'string') {
    throw badRequest({ detail: 'Request body must contain a "text" string to classify.' });
  }

  if (text.trim() === '') {
    throw badRequest({ detail: 'Enter some text to classify.' });
  }

  // Counted in code points rather than UTF-16 units, matching every other panel's limit, so a
  // non-BMP character counts once rather than twice.
  if ([...text].length > MAX_CLASSIFICATION_TEXT_CHARACTERS) {
    throw badRequest({
      detail:
        `The text exceeds the ${MAX_CLASSIFICATION_TEXT_CHARACTERS.toLocaleString()}-character `
        + 'limit for this panel. The limit keeps the text inside the smallest reviewed model\u2019s '
        + 'context window, because a model that truncates returns a confident score for only the '
        + 'part it read.'
    });
  }

  // Both ranking controls are refused for a verdict model with the same reason, because it is the
  // same reason: there is no score in its output for either control to act on.
  const scoreless =
    `It reports a ${controls.outcomeKind === 'verdict' ? 'verdict' : 'result'} with no confidence `
    + 'score for anything, so there is nothing to rank or filter.';

  const topK = validateControl(property(source, 'topK'), 'topK', controls.topK, model, scoreless);
  const minimumConfidence = validateControl(
    property(source, 'minimumConfidence'),
    'minimumConfidence',
    controls.minimumConfidence,
    model,
    scoreless
  );

  return {
    text,
    model,
    runId,
    ...(topK === undefined ? {} : { topK }),
    ...(minimumConfidence === undefined ? {} : { minimumConfidence })
  };
}

/**
 * Builds the model input for one classification.
 *
 * The shape comes from the reviewed descriptor rather than from a branch on the model identifier: a
 * conventional classifier takes `{ text }`, while Llama Guard is a chat model underneath and takes
 * a `messages[]` array. Nothing else is sent — neither reviewed model has a ranking field in its
 * schema, so the controls are applied to the response instead.
 *
 * **No system prompt and no instruction accompany the text**, even for the chat-shaped model. Llama
 * Guard applies its own taxonomy; adding an instruction would be exactly the caller-defined
 * criteria this panel refuses, smuggled in by the application rather than by the caller.
 *
 * @param request A validated request.
 * @returns The provider-shaped input payload.
 */
export function buildClassifyTextInput(
  request: ValidatedClassifyTextRequest
): Record<string, unknown> {
  const controls = request.model.textClassificationControls;

  if (controls?.inputShape === 'messages') {
    return {
      messages: [{ role: 'user', content: request.text }],
      // Without this, Llama Guard answers with the *string* branch of its output schema — the
      // literal text "\n\nsafe" — rather than `{ safe, categories }`. The schema declares both
      // branches and does not say what selects between them; verified against the live model,
      // `response_format` is what does. Omitting it made every run of that model fail, because
      // this application correctly refuses to parse a safety verdict out of prose.
      ...(controls.requiresJsonResponseFormat === true
        ? { response_format: { type: 'json_object' } }
        : {})
    };
  }

  return { text: request.text };
}

/**
 * Ranks, filters, and truncates the labels a scoring classifier returned.
 *
 * In the domain rather than in a component because ordering, truncation, and the confidence floor
 * all decide what a visitor is told about the model's output. Implemented once here, every
 * transport gets the same behaviour; implemented in a Vue component, a second caller would
 * re-invent them differently.
 *
 * The scores are passed through untouched. Nothing rescales or renormalises them after filtering: a
 * set of scores that no longer sums to 1 is the honest consequence of hiding some, and adjusting
 * them to compensate would be inventing output the model did not produce.
 *
 * @param labels The usable labels read from the provider response.
 * @param request The validated request, whose controls decide the floor and the limit.
 * @returns The surviving labels, highest score first, each with its rank and reviewed name.
 */
export function rankTextClassificationLabels(
  labels: readonly { label: string; score: number }[],
  request: ValidatedClassifyTextRequest
): ScoredClassificationLabel[] {
  const controls = request.model.textClassificationControls;
  const floor = request.minimumConfidence ?? controls?.minimumConfidence?.default ?? 0;
  const limit = Math.min(
    request.topK ?? controls?.topK?.default ?? MAX_TEXT_CLASSIFICATION_LABELS,
    MAX_TEXT_CLASSIFICATION_LABELS
  );

  return (
    labels
      .filter((entry) => entry.score >= floor)
      // Ties broken by label name so the ordering is deterministic. Two labels at identical scores
      // is not hypothetical for a binary classifier given neutral text.
      .toSorted((left, right) =>
        right.score === left.score
          ? left.label.localeCompare(right.label)
          : right.score - left.score
      )
      .slice(0, limit)
      .map((entry, index) => ({
        rank: index + 1,
        label: entry.label,
        // Named from the reviewed label set, never from the response, so a model emitting an
        // unexpected code cannot put arbitrary text on the page. An unknown code shows as itself,
        // which is informative rather than alarming.
        name: findReviewedLabelName(request.model, entry.label),
        score: entry.score
      }))
  );
}

/**
 * Finds the published name for a label code the model emitted.
 *
 * @param model The reviewed descriptor whose label set to search.
 * @param code The code as the model reported it.
 * @returns The reviewed name, or the code itself when it is not one the model declared.
 */
export function findReviewedLabelName(model: ModelDescriptor, code: string): string {
  const match = model.textClassificationControls?.labelSet.find(
    (candidate) => candidate.code === code
  );
  return match?.name ?? code;
}

/**
 * Describes the settings a classification was actually produced with.
 *
 * Model defaults are filled in for controls the caller omitted, so the panel can report what
 * produced a result rather than only what was explicitly chosen. The label set name travels with
 * them because a result is not interpretable without it: "Negative" from a sentiment model and "S10
 * Hate" from a safety model are not points on the same scale.
 *
 * @param request A validated request.
 * @returns The applied controls; see {@link AppliedTextClassificationControls}.
 */
export function describeAppliedTextClassificationControls(
  request: ValidatedClassifyTextRequest
): AppliedTextClassificationControls {
  const controls = request.model.textClassificationControls;
  const topK = controls?.topK === undefined ? undefined : (request.topK ?? controls.topK.default);
  const minimumConfidence =
    controls?.minimumConfidence === undefined
      ? undefined
      : (request.minimumConfidence ?? controls.minimumConfidence.default);

  return {
    model: request.model.id,
    labelSetName: controls?.labelSetName ?? 'unknown',
    ...(topK === undefined ? {} : { topK }),
    ...(minimumConfidence === undefined ? {} : { minimumConfidence }),
    characterCount: [...request.text].length
  };
}
