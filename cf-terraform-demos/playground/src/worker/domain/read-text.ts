/**
 * @file Read Text request validation and model-input construction. The rule this panel exists to
 *   demonstrate is the same one Create Image demonstrates, but the reviewed models make it sharper:
 *   a control is validated against the _selected model's_ declared capability rather than against a
 *   fixed schema for the panel, and here the two reviewed families have **no overlapping controls
 *   at all**. Deepgram's Aura exposes forty named speakers and no language parameter. MeloTTS
 *   exposes a language and no speaker parameter. Asking Aura for a language, or MeloTTS for a
 *   voice, is not a slightly-wrong request a provider will quietly ignore — it is a field the
 *   schema does not declare. Refusing it with a message that names both the control and the model
 *   is therefore more useful than dropping it: dropping teaches a visitor that the control did
 *   nothing, when the truth is that this model does not have it. Rate and pitch are rejected for
 *   every reviewed model, because no reviewed model has them. That is a finding rather than an
 *   omission, and the error says so.
 */

import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';
import {
  isSpeechFormatName,
  MAX_SPEECH_CHARACTERS,
  type AppliedSpeechControls,
  type SpeechControlName,
  type SpeechFormatName
} from '../../shared/read-text';
import { estimateSpeechCostUsd } from '../../shared/read-text';
import { isPlausibleRunId } from './chat';
import { findModelForTask, type ModelDescriptor } from './models';

/**
 * A Read Text request that has passed validation.
 *
 * As with every other panel this is a distinct type from the untrusted wire shape, so a function
 * requiring it cannot be handed unvalidated input. Every optional field present here has been
 * checked against the resolved model's declared support.
 */
export interface ValidatedReadTextRequest {
  /**
   * Trimmed text to speak.
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
   * Voice, present only for a model that declares one.
   */
  voice?: string;
  /**
   * Language, present only for a model that declares one.
   */
  language?: string;
  /**
   * Output format, present only for a model that offers a choice.
   */
  format?: SpeechFormatName;
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
 * Refuses a control the selected model does not support.
 *
 * @param control Control the caller supplied.
 * @param model Model it was requested against.
 * @returns Never; it always throws.
 * @throws {ProblemDetailsError} `badRequest()` (400) naming both the control and the model, so the
 *   caller learns which model to switch to rather than only that something was wrong.
 */
function unsupported(control: SpeechControlName, model: ModelDescriptor): never {
  throw badRequest({
    detail:
      `${model.name} does not support "${control}". Choose a model that offers that control, or `
      + 'remove it from the request.'
  });
}

/**
 * Validates an optional control whose legal values are an enumerated list.
 *
 * Every control this panel accepts is of this shape — a voice name, a language code, a format name
 * — which is why there is one validator rather than three. The reviewed models disagree about
 * _which_ of these lists they publish, and that disagreement is expressed by the list being absent
 * rather than by a separate code path.
 *
 * @param value Untrusted value, possibly absent.
 * @param control Control being validated, used in error messages.
 * @param allowed The model's declared values, or `undefined` when it does not expose this control.
 * @param model Model the request was made against.
 * @returns The value, or `undefined` when the caller omitted it.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the model does not support the control,
 *   when the value is not a string, or when it is not one of the declared values.
 */
function validateChoice(
  value: unknown,
  control: SpeechControlName,
  allowed: readonly string[] | undefined,
  model: ModelDescriptor
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (allowed === undefined) {
    unsupported(control, model);
  }

  if (typeof value !== 'string') {
    throw badRequest({ detail: `"${control}" must be a string.` });
  }

  // Compared exactly rather than case-insensitively. A provider validating against an enum treats
  // `luna` and `Luna` as different strings, so normalising here would let a request through that
  // the provider then rejects — moving the failure from this clear message to an opaque `502`.
  if (!allowed.includes(value)) {
    throw badRequest({
      detail:
        `"${value}" is not a "${control}" value that ${model.name} accepts. Each model declares `
        + 'its own list.'
    });
  }

  return value;
}

/**
 * Refuses a control no reviewed model exposes.
 *
 * Rate and pitch are in the wire contract because the panel's brief asks for them "when supported",
 * and the reviewed answer is that none of the three hosted speech models support either. Rejecting
 * them explicitly — rather than letting them fall through as unrecognised fields — is what makes
 * that finding visible to a caller instead of silently discarding their request.
 *
 * @param value Untrusted value, possibly absent.
 * @param control Control being validated.
 * @param range The model's declared range, which is `undefined` for every reviewed model today.
 * @param model Model the request was made against.
 * @returns Nothing when the caller omitted the control.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the control was supplied and the model
 *   does not declare it.
 */
function rejectUnlessDeclared(
  value: unknown,
  control: SpeechControlName,
  range: { min: number; max: number } | undefined,
  model: ModelDescriptor
): void {
  if (value === undefined) {
    return;
  }

  if (range === undefined) {
    unsupported(control, model);
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badRequest({ detail: `"${control}" must be a number.` });
  }

  if (value < range.min || value > range.max) {
    throw badRequest({
      detail: `"${control}" must be between ${range.min} and ${range.max} for ${model.name}.`
    });
  }
}

/**
 * Validates an untrusted Read Text request body.
 *
 * @param body Parsed JSON request body, of unknown shape.
 * @returns The validated request with its model resolved to a reviewed descriptor; see
 *   {@link ValidatedReadTextRequest}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is not an object; when it
 *   carries an identity field; when the text is absent, empty, or over-long; when `runId` is
 *   malformed; when `model` is not a reviewed model registered against the Read Text panel; or when
 *   any control is unsupported by that model or not one of its declared values.
 */
export function validateReadTextRequest(body: unknown): ValidatedReadTextRequest {
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

  const rawText = property(source, 'text');
  if (typeof rawText !== 'string') {
    throw badRequest({ detail: 'Request body must contain a "text" string.' });
  }

  const text = rawText.trim();
  if (text === '') {
    throw badRequest({ detail: 'Enter some text to read aloud.' });
  }

  // Counted in code points rather than UTF-16 units, matching every other panel's limit, so an
  // emoji or a non-BMP character counts once rather than twice.
  if ([...text].length > MAX_SPEECH_CHARACTERS) {
    throw badRequest({
      detail: `The text exceeds the ${MAX_SPEECH_CHARACTERS.toLocaleString()}-character limit.`
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
  const model = findModelForTask('read-text', modelId);
  if (model === undefined) {
    throw badRequest({
      detail: 'That model is not one of the reviewed models available for Read Text.'
    });
  }

  // A text-to-speech descriptor without declared controls would mean the reviewed list was filled
  // in incompletely. Failing loudly beats forwarding an unvalidated request.
  const controls = model.speechControls;
  if (controls === undefined) {
    throw badRequest({ detail: 'That model has no reviewed speech controls.' });
  }

  const voice = validateChoice(property(source, 'voice'), 'voice', controls.voices, model);
  const language = validateChoice(
    property(source, 'language'),
    'language',
    controls.languages,
    model
  );

  const rawFormat = property(source, 'format');
  const format = validateChoice(rawFormat, 'format', controls.formats, model);
  // Narrowed separately from the membership check above. `validateChoice` proves the value is in the
  // model's declared list, but its return type is `string`; this re-check is what lets the result be
  // typed as the format union without a cast.
  if (format !== undefined && !isSpeechFormatName(format)) {
    throw badRequest({ detail: `"${format}" is not a reviewed output format.` });
  }

  rejectUnlessDeclared(property(source, 'rate'), 'rate', controls.rate, model);
  rejectUnlessDeclared(property(source, 'pitch'), 'pitch', controls.pitch, model);

  return {
    text,
    model,
    runId,
    ...(voice === undefined ? {} : { voice }),
    ...(language === undefined ? {} : { language }),
    ...(format === undefined ? {} : { format })
  };
}

/**
 * Builds the model input for a validated Read Text request.
 *
 * Only fields the model declared are included, and the text takes the name that model's own schema
 * uses — `text` for Aura, `prompt` for MeloTTS. A model that receives only the fields it accepts
 * cannot reject the request for an undeclared property.
 *
 * The format is expanded here from this demo's single name into the provider's two fields. Aura
 * spells an output choice as an `encoding` plus a `container`, and the legal pairings are described
 * in its prose rather than its schema, so the mapping lives in one reviewed place rather than being
 * assembled by a caller.
 *
 * @param request A validated request.
 * @returns The provider-shaped input payload.
 */
export function buildReadTextInput(request: ValidatedReadTextRequest): Record<string, unknown> {
  const controls = request.model.speechControls;
  const input: Record<string, unknown> = {};

  if (controls === undefined) {
    return input;
  }

  input[controls.textParameterName] = request.text;

  if (controls.voices !== undefined) {
    // The model's own default is sent explicitly rather than omitted. The applied controls reported
    // back to the browser name a voice, and a request that left the field out would be reporting a
    // default this demo believes rather than one the provider confirmed.
    const voice = request.voice ?? controls.defaultVoice;
    if (voice !== undefined) {
      input['speaker'] = voice;
    }
  }

  if (controls.languages !== undefined) {
    const language = request.language ?? controls.defaultLanguage;
    if (language !== undefined) {
      input['lang'] = language;
    }
  }

  if (controls.formats !== undefined) {
    const format = request.format ?? controls.defaultFormat;
    if (format === 'wav') {
      // Aura's linear16 encoding is raw PCM, which a browser will not play on its own; the `wav`
      // container is what makes it a file rather than a byte stream. The pair travels together for
      // exactly that reason.
      input['encoding'] = 'linear16';
      input['container'] = 'wav';
    } else if (format === 'mp3') {
      input['encoding'] = 'mp3';
    }
  }

  return input;
}

/**
 * Describes the settings speech was actually generated with.
 *
 * Model defaults are filled in for controls the caller omitted, so the panel can show what produced
 * a result rather than only what was explicitly chosen. A control the model does not support is
 * left absent rather than reported with an invented value.
 *
 * @param request A validated request.
 * @returns The applied controls, including the pre-request cost estimate where one is possible; see
 *   {@link AppliedSpeechControls}.
 */
export function describeAppliedSpeechControls(
  request: ValidatedReadTextRequest
): AppliedSpeechControls {
  const controls = request.model.speechControls;
  const characterCount = [...request.text].length;

  const voice =
    controls?.voices === undefined ? undefined : (request.voice ?? controls.defaultVoice);
  const language =
    controls?.languages === undefined ? undefined : (request.language ?? controls.defaultLanguage);
  const format =
    controls?.formats === undefined ? undefined : (request.format ?? controls.defaultFormat);

  const estimatedCostUsd = estimateSpeechCostUsd(
    characterCount,
    controls?.pricePerThousandCharactersUsd
  );

  return {
    model: request.model.id,
    characterCount,
    ...(voice === undefined ? {} : { voice }),
    ...(language === undefined ? {} : { language }),
    ...(format === undefined ? {} : { format }),
    // Absent rather than zero for a model billed per minute of audio. A zero would read as "free",
    // which is the one thing a cost figure must never do.
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd })
  };
}
