/**
 * @file Translate Text request validation, segmentation, and model-input construction. The rule
 *   every panel shares — validate a control against the _selected model's_ declared capability —
 *   takes a sharper form here than anywhere else, because one reviewed model does not have the
 *   control at all. M2M100 takes a source language; IndicTrans2 translates from English only and
 *   declares no source field. Sending one is not a slightly-wrong request a provider will ignore;
 *   it is a field the schema does not have. Refusing it names both the control and the model, which
 *   is more useful than dropping it: dropping teaches a visitor that the choice took effect. The
 *   substance of this module, though, is **segmentation**, and it is here rather than in the
 *   service because it is pure logic over plain data with a cost consequence. A translation model
 *   is trained on sentences, and handing it a multi-line passage as one string gets the newlines
 *   collapsed or re-ordered — which would quietly break the one formatting promise this panel
 *   makes. So the text is split on line boundaries, blank lines are held back as structure, and the
 *   content lines are sent as the model's contract wants them: one array for a model that batches,
 *   one call per line for a model that does not. That last distinction is why
 *   {@link MAX_TRANSLATION_SEGMENTS} exists. For a non-batching model each line is a separate paid
 *   call, so the limit that protects a visitor is a count of segments rather than a count of
 *   characters.
 */

import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';
import {
  MAX_TRANSLATION_CHARACTERS,
  MAX_TRANSLATION_SEGMENTS,
  splitTranslationSegments,
  type AppliedTranslationControls,
  type TranslationControlName,
  type TranslationLanguage
} from '../../shared/translate-text';
import { isPlausibleRunId } from './chat';
import { findModelForTask, type ModelDescriptor } from './models';

/**
 * A Translate Text request that has passed validation.
 *
 * As with every other panel this is a distinct type from the untrusted wire shape, so a function
 * requiring it cannot be handed unvalidated input. The segmentation is carried out here rather than
 * left to the service, so the number of paid calls is fixed at validation time and cannot differ
 * from the number the request was checked against.
 */
export interface ValidatedTranslateTextRequest {
  /**
   * The source text, with its line endings normalised to `\n`.
   *
   * Normalised rather than raw so the reassembled translation has the same line structure
   * regardless of which editor the text was pasted from.
   */
  text: string;
  /**
   * Every line of the source, in order, including blank ones.
   */
  lines: readonly string[];
  /**
   * The indices of {@link ValidatedTranslateTextRequest.lines} that carry translatable content.
   *
   * Held as indices rather than as a filtered list of strings because the translations have to be
   * put back in their original positions. Reassembling by consuming a filtered list in order would
   * work until a blank line appeared anywhere but the end.
   */
  contentLineIndices: readonly number[];
  /**
   * The reviewed descriptor the requested identifier resolved to.
   */
  model: ModelDescriptor;
  /**
   * Opaque run identifier supplied by the browser.
   */
  runId: string;
  /**
   * Language to translate from, present only for a model that has the control.
   */
  sourceLanguage?: string;
  /**
   * Language to translate into.
   */
  targetLanguage: string;
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
 * Finds a declared language by its code.
 *
 * @param languages The model's declared list.
 * @param code Candidate code from an untrusted request.
 * @returns The matching language, or `undefined` when the code is not declared.
 */
function findLanguage(
  languages: readonly TranslationLanguage[],
  code: string
): TranslationLanguage | undefined {
  // Compared exactly rather than case-insensitively. The two reviewed models use different
  // standards — `hi` against `hin_Deva` — and normalising case would not reconcile them while
  // implying that some normalisation is happening.
  return languages.find((language) => language.code === code);
}

/**
 * Refuses a control the selected model does not have.
 *
 * @param control Control the caller supplied.
 * @param model Model it was requested against.
 * @param reason Why the model does not accept it, stated so the message is actionable.
 * @returns Never; it always throws.
 * @throws {ProblemDetailsError} `badRequest()` (400) naming the control, the model, and the reason.
 */
function unsupported(
  control: TranslationControlName,
  model: ModelDescriptor,
  reason: string
): never {
  throw badRequest({ detail: `${model.name} does not accept "${control}". ${reason}` });
}

/**
 * Validates an untrusted Translate Text request body.
 *
 * @param body Parsed JSON request body, of unknown shape.
 * @returns The validated request with its model resolved and its text segmented; see
 *   {@link ValidatedTranslateTextRequest}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is not an object; when it
 *   carries an identity field; when `runId` is malformed; when `model` is not a reviewed model
 *   registered against this panel; when the text is absent, empty, or longer than
 *   {@link MAX_TRANSLATION_CHARACTERS}; when it has more translatable lines than
 *   {@link MAX_TRANSLATION_SEGMENTS}; when a source language is supplied to a model whose source is
 *   fixed; when either language is not one the selected model declares; or when the source and
 *   target languages are the same.
 */
export function validateTranslateTextRequest(body: unknown): ValidatedTranslateTextRequest {
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
  const model = findModelForTask('translate-text', modelId);
  if (model === undefined) {
    throw badRequest({
      detail: 'That model is not one of the reviewed models available for Translate Text.'
    });
  }

  const controls = model.translationControls;
  if (controls === undefined) {
    throw badRequest({ detail: 'That model has no reviewed translation controls.' });
  }

  const rawText = property(source, 'text');
  if (typeof rawText !== 'string') {
    throw badRequest({ detail: 'Request body must contain a "text" string to translate.' });
  }

  if (rawText.trim() === '') {
    throw badRequest({ detail: 'Enter some text to translate.' });
  }

  // Counted in code points rather than UTF-16 units, matching every other panel's limit, so a
  // non-BMP character counts once rather than twice. That matters more here than elsewhere: the
  // target languages include scripts well outside the BMP, so a translation's own output would
  // otherwise be measured differently from the source that produced it.
  if ([...rawText].length > MAX_TRANSLATION_CHARACTERS) {
    throw badRequest({
      detail:
        `The text exceeds the ${MAX_TRANSLATION_CHARACTERS.toLocaleString()}-character limit for `
        + 'this panel.'
    });
  }

  // Normalised before splitting, so text pasted from a Windows editor is not treated as one
  // enormous line — which would defeat the line preservation this panel exists to demonstrate.
  const lines = splitTranslationSegments(rawText);
  const contentLineIndices = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => entry.line.trim() !== '')
    .map((entry) => entry.index);

  // A segment cap rather than only a character cap, because for a non-batching model each line is
  // a separate paid call. A pasted list of two hundred short lines passes the character limit
  // comfortably and would be two hundred charges from one click.
  if (contentLineIndices.length > MAX_TRANSLATION_SEGMENTS) {
    throw badRequest({
      detail:
        `That text has ${contentLineIndices.length} lines, and this panel translates up to `
        + `${MAX_TRANSLATION_SEGMENTS} at a time. Some models translate each line as a separate `
        + 'paid request, so the limit is on lines rather than length. Translate it in smaller '
        + 'pieces.'
    });
  }

  const rawSource = property(source, 'sourceLanguage');
  let sourceLanguage: string | undefined;

  if (rawSource !== undefined) {
    // Refused rather than ignored. The field does not exist in IndicTrans2's schema, so a caller
    // who sends it has formed a belief about the request that is simply wrong — and silently
    // dropping it would leave them thinking they had chosen a source language.
    if (controls.sourceLanguages === undefined) {
      unsupported(
        'sourceLanguage',
        model,
        `It translates from ${controls.fixedSourceLanguage?.name ?? 'one fixed language'} only, `
          + 'and its contract has no source-language field at all.'
      );
    }

    if (typeof rawSource !== 'string') {
      throw badRequest({ detail: '"sourceLanguage" must be a string.' });
    }

    if (findLanguage(controls.sourceLanguages, rawSource) === undefined) {
      throw badRequest({
        detail:
          `"${rawSource}" is not a source language ${model.name} accepts. Each model declares its `
          + 'own list, and they do not use the same style of code.'
      });
    }

    sourceLanguage = rawSource;
  }

  const rawTarget = property(source, 'targetLanguage');
  if (typeof rawTarget !== 'string') {
    throw badRequest({ detail: 'Request body must contain a "targetLanguage".' });
  }

  if (findLanguage(controls.targetLanguages, rawTarget) === undefined) {
    throw badRequest({
      detail:
        `"${rawTarget}" is not a target language ${model.name} accepts. Each model declares its `
        + 'own list, and they do not use the same style of code.'
    });
  }

  // The effective source: the caller's choice, the model's default, or its fixed language. Resolved
  // here so the same-language check below works for a fixed-source model too — asking IndicTrans2
  // to translate English into English is as pointless as asking M2M100 to, and only one of the two
  // has a control the visitor could have set wrongly.
  const effectiveSource =
    sourceLanguage ?? controls.defaultSourceLanguage ?? controls.fixedSourceLanguage?.code;

  if (effectiveSource === rawTarget) {
    throw badRequest({
      detail:
        'The source and target languages are the same, so there is nothing to translate. Choose a '
        + 'different target language.'
    });
  }

  return {
    text: lines.join('\n'),
    lines,
    contentLineIndices,
    model,
    runId,
    ...(sourceLanguage === undefined ? {} : { sourceLanguage }),
    targetLanguage: rawTarget
  };
}

/**
 * Builds the model input for one unit of translation work.
 *
 * Called once for a model that batches, carrying every content line, and once per line for a model
 * that does not. The caller decides which, because the decision is the model's declared
 * `batchesSegments` and the service is what loops.
 *
 * Only fields the model declared are included, so a model cannot reject the request for a property
 * its schema does not have. The source language is omitted entirely for a fixed-source model rather
 * than sent under a guessed field name.
 *
 * @param request A validated request.
 * @param texts The line or lines this call should translate.
 * @returns The provider-shaped input payload.
 */
export function buildTranslateTextInput(
  request: ValidatedTranslateTextRequest,
  texts: readonly string[]
): Record<string, unknown> {
  const controls = request.model.translationControls;
  const input: Record<string, unknown> = {};

  if (controls === undefined) {
    return input;
  }

  // An array only for a model that declared it accepts one. A model taking a plain string would
  // reject an array outright, and a model taking an array given a bare string would return a
  // different output shape than its descriptor promises.
  input['text'] = controls.batchesSegments ? [...texts] : (texts[0] ?? '');

  // Written under the model's own spelling — `target_lang` or `target_language` — read from the
  // reviewed descriptor rather than chosen by a conditional here.
  input[controls.targetParameterName] = request.targetLanguage;

  if (controls.sourceParameterName !== undefined) {
    // The default is filled in rather than omitted. M2M100 documents a default of `en`, and relying
    // on a provider's default means the applied controls this panel reports would be a guess about
    // what the provider did.
    const resolved = request.sourceLanguage ?? controls.defaultSourceLanguage;
    if (resolved !== undefined) {
      input[controls.sourceParameterName] = resolved;
    }
  }

  return input;
}

/**
 * Describes the settings a translation was actually produced with.
 *
 * The source language is always reported, including a fixed-source model's own language, because a
 * translation with an unstated source is not interpretable. The text itself is never echoed: the
 * browser already has it, and returning it would put the visitor's content in one more place for no
 * benefit.
 *
 * @param request A validated request.
 * @param inferenceCallCount How many calls the run actually made, passed in rather than recomputed
 *   so the reported figure is the one that really happened.
 * @returns The applied controls; see {@link AppliedTranslationControls}.
 */
export function describeAppliedTranslationControls(
  request: ValidatedTranslateTextRequest,
  inferenceCallCount: number
): AppliedTranslationControls {
  const controls = request.model.translationControls;

  return {
    model: request.model.id,
    sourceLanguage:
      request.sourceLanguage
      ?? controls?.defaultSourceLanguage
      ?? controls?.fixedSourceLanguage?.code
      ?? 'unknown',
    targetLanguage: request.targetLanguage,
    characterCount: [...request.text].length,
    inferenceCallCount
  };
}
