/**
 * @file Generate Music request validation, model-input construction, and cost estimation. The
 *   panels before this one taught that models disagree about which controls exist and about how
 *   those controls are spelled. This one teaches something harder to paper over: two models can
 *   disagree about **what is being bought**. ElevenLabs sells seconds of audio and lets the caller
 *   choose how many; MiniMax sells a track, decides its length itself, and rejects any field that
 *   tries to set one. A single hardcoded form could not drive both, and — more importantly — a
 *   single cost calculation could not describe both. Cost estimation therefore lives here, as it
 *   does for Create Video, and for the same reason: this panel bills against prepaid credits, so a
 *   visitor who learns the price only afterwards learns it too late. The estimate is computed in
 *   the domain so every transport quotes the same number, and it is labelled an estimate everywhere
 *   it appears. What it is never derived from is tokens. Neither reviewed model reports a token
 *   count, and a figure assembled from one would be exactly the misreading this panel exists to
 *   correct. One validation rule here is a reimplementation of a provider refusal rather than a
 *   demo-chosen restriction, and that is deliberate. MiniMax rejects a vocal track with neither
 *   supplied nor generated lyrics, answering "When 'is_instrumental' is false and
 *   'lyrics_optimizer' is false, 'lyrics' must be provided". Checking it locally turns an opaque
 *   provider error into a message naming the three ways out of it, and does so **before the request
 *   is paid for** — which on a per-track model is the difference between a free refusal and fifteen
 *   cents.
 */

import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';
import {
  describeMusicCostBasis,
  estimateMusicCostUsd,
  MAX_MUSIC_LYRICS_CHARACTERS,
  MAX_MUSIC_PROMPT_CHARACTERS,
  type AppliedMusicControls,
  type MusicControlName,
  type MusicControlSupport,
  type MusicLyricsSource
} from '../../shared/generate-music';
import { isPlausibleRunId } from './chat';
import { findModelForTask, type ModelDescriptor } from './models';

/**
 * A Generate Music request that has passed validation.
 *
 * A distinct type from the untrusted wire shape, as in every other panel, so a function requiring
 * it cannot be handed unvalidated input. Every control is resolved here rather than left optional:
 * the model's defaults are filled in during validation, so the request builder, the cost estimate,
 * and the applied-controls summary all work from one settled set of values rather than each
 * re-deriving the defaults and risking a different answer.
 */
export interface ValidatedGenerateMusicRequest {
  /**
   * Trimmed style prompt.
   */
  prompt: string;
  /**
   * The reviewed descriptor the requested identifier resolved to.
   */
  model: ModelDescriptor;
  /**
   * The model's declared music controls, resolved from the descriptor so callers need not re-check
   * that a music descriptor carries them.
   */
  controls: MusicControlSupport;
  /**
   * Opaque run identifier supplied by the browser.
   */
  runId: string;
  /**
   * Whether an instrumental track was requested, with the panel's default filled in.
   *
   * Always resolved rather than optional, because it decides whether the lyrics rule applies and a
   * `undefined` would leave that rule with two readings.
   */
  instrumental: boolean;
  /**
   * Trimmed lyrics, when the model accepts them and the caller supplied any.
   */
  lyrics?: string;
  /**
   * Whether the model was asked to write its own lyrics.
   */
  generateLyrics: boolean;
  /**
   * Requested length in seconds, guaranteed to be within the model's declared range.
   *
   * Absent for a model with no length control, which is a capability difference rather than a
   * missing value.
   */
  lengthSeconds?: number;
  /**
   * Output format to apply, guaranteed to be one of the model's declared values.
   */
  format: string;
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
 * charge — is attributed to, and is rejected rather than quietly corrected. That matters more on
 * this panel than on most, because every model here spends prepaid credit.
 */
const FORBIDDEN_FIELDS: readonly string[] = ['user', 'email', 'actor', 'sub'];

/**
 * Fields that would describe the _output_ rather than the request.
 *
 * The server establishes all of these from the bytes the provider returned: the media type from the
 * signature, the duration from the container, the size by measuring. A body carrying one is either
 * confused about the contract or probing it, and both deserve an explicit refusal rather than a
 * silently ignored field. `audio` and `audioUrl` are included because they are the obvious shape of
 * an attempt to have this Worker fetch an arbitrary URL — the one thing its host allowlist exists
 * to prevent.
 */
const FORBIDDEN_OUTPUT_FIELDS: readonly string[] = [
  'audio',
  'audioUrl',
  'mediaType',
  'byteLength',
  'durationSeconds',
  'sourceHost'
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
 * @throws {ProblemDetailsError} `badRequest()` (400) naming the control and the model, so the
 *   caller learns which model to switch to rather than only that something was wrong.
 */
function unsupported(control: MusicControlName, model: ModelDescriptor): never {
  throw badRequest({
    detail:
      `${model.name} does not accept "${control}". Remove it, or choose a model that supports `
      + 'that control.'
  });
}

/**
 * Validates the output format against the model's declared values.
 *
 * Compared exactly rather than case-insensitively, deliberately, and the reviewed models make the
 * reason unusually stark: their format enums share no value at all. `mp3` is valid for MiniMax and
 * invalid for ElevenLabs, which wants `mp3_44100_128`. Normalising or loosening the comparison here
 * would mean forwarding a value the provider's own enum rejects, turning a clear client error into
 * an opaque provider one — and on a per-track model, one that may already have been charged for.
 *
 * @param value Untrusted value, possibly absent.
 * @param controls The model's declared music controls.
 * @param model Model the request was made against.
 * @returns The chosen format, or the model's declared default.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the value is not a string or is not one
 *   of the declared values.
 */
function validateFormat(
  value: unknown,
  controls: MusicControlSupport,
  model: ModelDescriptor
): string {
  if (value === undefined) {
    return controls.defaultFormat;
  }

  if (typeof value !== 'string' || !controls.formats.includes(value)) {
    throw badRequest({
      detail:
        `"format" must be one of ${controls.formats.join(', ')} for ${model.name}. Each model `
        + 'declares its own list, and the reviewed models share no format name.'
    });
  }

  return value;
}

/**
 * Validates the requested track length against whichever form the model declares.
 *
 * The interesting branch is the one that refuses. A model with no `lengthSeconds` range has no
 * length field in its schema, so a supplied length is not slightly wrong — it is a property the
 * provider will reject outright, since both reviewed schemas set `additionalProperties: false`.
 * Saying that plainly is more useful than dropping the value, which would teach a visitor that the
 * control did nothing when the truth is that this model chooses the length itself.
 *
 * @param value Untrusted value, possibly absent.
 * @param controls The model's declared music controls.
 * @param model Model the request was made against.
 * @returns The length in seconds to apply, or `undefined` for a model with no length control.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the model declares no length control, or
 *   the value is not a whole number within the declared range.
 */
function validateLength(
  value: unknown,
  controls: MusicControlSupport,
  model: ModelDescriptor
): number | undefined {
  const range = controls.lengthSeconds;

  if (range === undefined) {
    if (value !== undefined) {
      unsupported('lengthSeconds', model);
    }
    return undefined;
  }

  if (value === undefined) {
    return range.default;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw badRequest({ detail: '"lengthSeconds" must be a whole number of seconds.' });
  }

  if (value < range.min || value > range.max) {
    throw badRequest({
      detail:
        `"lengthSeconds" must be between ${range.min} and ${range.max} seconds for `
        + `${model.name}.`
    });
  }

  return value;
}

/**
 * Validates an optional seed.
 *
 * @param value Untrusted value, possibly absent.
 * @param controls The model's declared music controls.
 * @param model Model the request was made against.
 * @returns The seed, or `undefined` when the caller omitted it.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the model accepts no seed, or the value
 *   is not a whole number within the bounds the model's schema declares.
 */
function validateSeed(
  value: unknown,
  controls: MusicControlSupport,
  model: ModelDescriptor
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!controls.seed) {
    unsupported('seed', model);
  }

  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value < 0
    // ElevenLabs declares `maximum: 4294967295` — an unsigned 32-bit range, which is wider than the
    // signed bound Create Video's models use. The number is the provider's rather than this demo's.
    || value > 4_294_967_295
  ) {
    throw badRequest({ detail: '"seed" must be a whole number between 0 and 4294967295.' });
  }

  return value;
}

/**
 * Validates the lyrics controls together, because the models constrain them together.
 *
 * Kept as one function rather than two validators on one field each, since the rule that matters is
 * a relationship between three values: whether the track is instrumental, whether lyrics were
 * supplied, and whether the model was asked to write them. Checking each field alone would accept
 * every combination the provider refuses.
 *
 * @param rawLyrics Untrusted lyrics value, possibly absent.
 * @param rawGenerate Untrusted lyrics-writing flag, possibly absent.
 * @param instrumental Whether an instrumental track was requested.
 * @param controls The model's declared music controls.
 * @param model Model the request was made against.
 * @returns The trimmed lyrics where supplied, and whether the model should write its own.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the model accepts no lyrics, when lyrics
 *   are not text or are over-long, when lyrics are supplied for an instrumental track, when lyrics
 *   are both supplied and requested, or when a vocal track would reach a model that refuses one
 *   with no lyrics.
 */
function validateLyrics(
  rawLyrics: unknown,
  rawGenerate: unknown,
  instrumental: boolean,
  controls: MusicControlSupport,
  model: ModelDescriptor
): { lyrics?: string; generateLyrics: boolean } {
  if (controls.lyrics === 'unsupported') {
    if (rawLyrics !== undefined) {
      unsupported('lyrics', model);
    }
    if (rawGenerate !== undefined) {
      unsupported('generateLyrics', model);
    }
    return { generateLyrics: false };
  }

  let generateLyrics = false;
  if (rawGenerate !== undefined) {
    if (controls.lyricsOptimizerParameterName === undefined) {
      unsupported('generateLyrics', model);
    }
    if (typeof rawGenerate !== 'boolean') {
      throw badRequest({ detail: '"generateLyrics" must be true or false.' });
    }
    generateLyrics = rawGenerate;
  }

  let lyrics: string | undefined;
  if (rawLyrics !== undefined) {
    if (typeof rawLyrics !== 'string') {
      throw badRequest({ detail: '"lyrics" must be text.' });
    }
    const trimmed = rawLyrics.trim();
    // Counted in code points rather than UTF-16 units, matching every other panel's limit, so a
    // non-BMP character counts once rather than twice.
    if ([...trimmed].length > MAX_MUSIC_LYRICS_CHARACTERS) {
      throw badRequest({
        detail:
          `The lyrics must be ${MAX_MUSIC_LYRICS_CHARACTERS.toLocaleString()} characters or `
          + 'fewer.'
      });
    }
    // Empty lyrics are treated as absent rather than forwarded as an empty string: the provider's
    // own schema declares `minLength: 1`, so `""` is a value it refuses.
    lyrics = trimmed === '' ? undefined : trimmed;
  }

  if (lyrics !== undefined && instrumental) {
    throw badRequest({
      detail:
        'An instrumental track has no vocals, so it cannot carry lyrics. Turn off the '
        + 'instrumental setting, or remove the lyrics.'
    });
  }

  if (lyrics !== undefined && generateLyrics) {
    throw badRequest({
      detail:
        'Choose one: supply the lyrics, or ask the model to write them. Asking for both is a '
        + 'request with two answers, and writing lyrics is charged for separately.'
    });
  }

  if (generateLyrics && instrumental) {
    throw badRequest({
      detail:
        'An instrumental track has no vocals, so there are no lyrics to write. Writing lyrics is '
        + 'charged for separately, so this is refused rather than ignored.'
    });
  }

  if (
    controls.requiresLyricsForVocals === true
    && !instrumental
    && lyrics === undefined
    && !generateLyrics
  ) {
    // The provider's own refusal, reimplemented so it happens before the charge. On a per-track
    // model that is the difference between a free `400` and fifteen cents spent on nothing.
    throw badRequest({
      detail:
        `${model.name} will not sing without words. Supply lyrics, ask the model to write them, `
        + 'or generate an instrumental track instead.'
    });
  }

  return { ...(lyrics === undefined ? {} : { lyrics }), generateLyrics };
}

/**
 * Validates a Generate Music request body.
 *
 * @param body Parsed, untrusted JSON body.
 * @returns A validated request with every control resolved; see
 *   {@link ValidatedGenerateMusicRequest}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is not an object, carries an
 *   identity or output-describing field, names an unknown or wrong-panel model, omits or oversizes
 *   the prompt, supplies an implausible run identifier, or sets a control the model does not
 *   support or whose value falls outside the model's declared values — including the lyrics
 *   combinations the reviewed models refuse.
 * @throws {Error} When a descriptor registered for this panel declares no music controls, which is
 *   a repository fault rather than a caller fault.
 */
export function validateGenerateMusicRequest(body: unknown): ValidatedGenerateMusicRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest({ detail: 'The request body must be a JSON object.' });
  }

  const source = body as Record<string, unknown>;

  for (const field of FORBIDDEN_FIELDS) {
    if (property(source, field) !== undefined) {
      throw badRequest({
        detail:
          `The request must not carry "${field}". The signed-in identity is taken from the `
          + 'verified Access token.'
      });
    }
  }

  for (const field of FORBIDDEN_OUTPUT_FIELDS) {
    if (property(source, field) !== undefined) {
      throw badRequest({
        detail:
          `The request must not carry "${field}". The server establishes the track's location, `
          + 'format, and length from the bytes the model returned.'
      });
    }
  }

  const modelId = property(source, 'model');
  if (typeof modelId !== 'string' || modelId.trim() === '') {
    throw badRequest({ detail: 'A model identifier is required.' });
  }

  // Resolved against this panel's registered models, so a descriptor belonging to another panel is
  // rejected rather than silently driven with the wrong request shape.
  const model = findModelForTask('generate-music', modelId);
  if (model === undefined) {
    throw badRequest({ detail: `${modelId} is not a model this panel can use.` });
  }

  const controls = model.musicControls;
  if (controls === undefined) {
    // A reviewed music descriptor without controls is a repository fault rather than a caller fault,
    // and saying so plainly beats a misleading 400 about the request.
    throw new Error(`${model.id} is registered for generate-music but declares no musicControls.`);
  }

  const promptValue = property(source, 'prompt');
  if (typeof promptValue !== 'string') {
    throw badRequest({ detail: 'A prompt describing the music is required.' });
  }
  const prompt = promptValue.trim();
  if (prompt === '') {
    throw badRequest({ detail: 'A prompt describing the music is required.' });
  }
  if ([...prompt].length > MAX_MUSIC_PROMPT_CHARACTERS) {
    throw badRequest({
      detail: `The prompt must be ${MAX_MUSIC_PROMPT_CHARACTERS.toLocaleString()} characters or fewer.`
    });
  }

  const runId = property(source, 'runId');
  if (typeof runId !== 'string' || !isPlausibleRunId(runId)) {
    throw badRequest({ detail: 'A valid run identifier is required.' });
  }

  const instrumentalValue = property(source, 'instrumental');
  if (instrumentalValue !== undefined && typeof instrumentalValue !== 'boolean') {
    throw badRequest({ detail: '"instrumental" must be true or false.' });
  }
  // Defaults to `false` rather than being left undefined, matching both models' own schema defaults
  // and giving the lyrics rule one unambiguous reading.
  const instrumental = instrumentalValue === true;

  const { lyrics, generateLyrics } = validateLyrics(
    property(source, 'lyrics'),
    property(source, 'generateLyrics'),
    instrumental,
    controls,
    model
  );

  const lengthSeconds = validateLength(property(source, 'lengthSeconds'), controls, model);
  const seed = validateSeed(property(source, 'seed'), controls, model);

  return {
    prompt,
    model,
    controls,
    runId,
    instrumental,
    generateLyrics,
    format: validateFormat(property(source, 'format'), controls, model),
    ...(lyrics === undefined ? {} : { lyrics }),
    ...(lengthSeconds === undefined ? {} : { lengthSeconds }),
    ...(seed === undefined ? {} : { seed })
  };
}

/**
 * Builds the model input for a validated request.
 *
 * This is where this demo's control vocabulary becomes the selected model's. The wire names come
 * from the reviewed descriptor rather than from a conditional on the model identifier, so adding a
 * third model means filling in a descriptor rather than editing this function.
 *
 * Only declared controls are ever included, and that is a harder rule here than elsewhere: both
 * reviewed schemas set `additionalProperties: false`, so an undeclared field is a request the
 * provider is entitled to reject outright. A required flag is the mirror image — MiniMax lists
 * `is_instrumental` and `lyrics_optimizer` among its required properties, so both are always sent
 * for that model even when they are `false`, because omitting a required boolean is a malformed
 * request rather than a defaulted one.
 *
 * @param request A validated request.
 * @returns The provider payload, using the model's own parameter names and units.
 */
export function buildGenerateMusicInput(
  request: ValidatedGenerateMusicRequest
): Record<string, unknown> {
  const { controls } = request;

  const input: Record<string, unknown> = {
    prompt: request.prompt,
    [controls.formatParameterName]: request.format
  };

  if (controls.instrumentalParameterRequired || request.instrumental) {
    input[controls.instrumentalParameterName] = request.instrumental;
  }

  if (controls.lyricsOptimizerParameterName !== undefined) {
    if (controls.lyricsOptimizerRequired === true || request.generateLyrics) {
      input[controls.lyricsOptimizerParameterName] = request.generateLyrics;
    }
  }

  if (controls.lyricsParameterName !== undefined && request.lyrics !== undefined) {
    input[controls.lyricsParameterName] = request.lyrics;
  }

  if (
    controls.lengthParameterName !== undefined
    && request.lengthSeconds !== undefined
    // Converted at the last moment, from the unit the descriptor declares. The panel works in whole
    // seconds because that is what a person chooses; the provider wants milliseconds.
    && controls.lengthUnit === 'milliseconds'
  ) {
    input[controls.lengthParameterName] = request.lengthSeconds * 1_000;
  }

  if (request.seed !== undefined) {
    input['seed'] = request.seed;
  }

  return input;
}

/**
 * Reports where the lyrics of a request's track will have come from.
 *
 * Three outcomes rather than a boolean, because the `model` case is the one a visitor most needs
 * explained: MiniMax writes its own words, charges separately for doing so, and does not return
 * them. The panel states that rather than rendering an empty lyrics panel.
 *
 * @param request A validated request.
 * @returns The provenance; see {@link MusicLyricsSource}.
 */
export function musicLyricsSource(request: ValidatedGenerateMusicRequest): MusicLyricsSource {
  if (request.instrumental) {
    return 'none';
  }
  if (request.lyrics !== undefined) {
    return 'caller';
  }
  return request.generateLyrics ? 'model' : 'none';
}

/**
 * Estimates what a request will cost, in US dollars.
 *
 * Deliberately **not** reconciled with the gateway's figure afterwards. It exists so a visitor
 * knows what a click costs before spending it; the authoritative number always comes from the AI
 * Gateway log, and the UI labels this one an estimate wherever it appears.
 *
 * Both branches are exact rather than approximate, which is unusual and is the comparison this
 * panel exists to make: the per-second model's billable quantity is a duration the caller just
 * chose, and the per-track model's is one track. Neither is a token, and neither is derived from
 * one.
 *
 * @param request A validated request, whose length and lyrics decisions are already settled.
 * @returns The estimated cost in US dollars.
 */
export function estimateMusicCostForRequest(request: ValidatedGenerateMusicRequest): number {
  return estimateMusicCostUsd(
    request.controls.pricing,
    request.lengthSeconds,
    request.generateLyrics
  );
}

/**
 * Describes the controls a request will be run with, for echoing back to the browser.
 *
 * The lyrics themselves are deliberately absent: the browser already has them, and a server that
 * returned a visitor's words back to them would put the content in one more place for no benefit.
 * Their length and provenance are reported instead, which is what the panel actually renders.
 *
 * @param request A validated request.
 * @returns The applied controls including filled-in defaults, the pricing unit, the cost estimate,
 *   and the sentence explaining how the estimate was reached; see {@link AppliedMusicControls}.
 */
export function describeAppliedMusicControls(
  request: ValidatedGenerateMusicRequest
): AppliedMusicControls {
  const { pricing } = request.controls;
  const lyricsCharacterCount =
    request.lyrics === undefined ? undefined : [...request.lyrics].length;

  return {
    model: request.model.id,
    prompt: request.prompt,
    instrumental: request.instrumental,
    lyricsSource: musicLyricsSource(request),
    ...(lyricsCharacterCount === undefined ? {} : { lyricsCharacterCount }),
    ...(request.lengthSeconds === undefined ? {} : { lengthSeconds: request.lengthSeconds }),
    format: request.format,
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    pricingUnit: pricing.unit,
    estimatedCostUsd: estimateMusicCostForRequest(request),
    costBasis: describeMusicCostBasis(pricing, request.lengthSeconds, request.generateLyrics)
  };
}
