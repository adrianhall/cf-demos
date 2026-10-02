/**
 * @file Transcribe Audio request validation and model-input construction. The untrusted input here
 *   is a _file_, so everything the browser said about it is ignored: the format comes from the
 *   bytes, the duration comes from the container where one is declared, and both are checked before
 *   anything reaches a provider. That much this panel shares with Describe Image. What is new is
 *   that **the size limit depends on the selected model**. Earlier panels validated a control
 *   against the selected model's declared range; here the _payload itself_ is validated against a
 *   per-model figure, because the three reviewed models demand the same bytes in three different
 *   encodings and one of those encodings is far more expensive than the others. A model whose
 *   schema takes `{ audio: number[] }` turns a 4 MiB file into four million JSON numbers, and the
 *   measurements recorded for Describe Image show that exhausting a 128 MB isolate with a single
 *   ordinary request is arithmetic rather than a theoretical concern. So the same file can be
 *   accepted for one model and refused for another, and the refusal names both the model and its
 *   limit — because "too large" without saying "for this model" would read as a bug. The language
 *   hint carries the second lesson. Whisper takes ISO 639-1, Nova 3 takes BCP-47, and the original
 *   Whisper takes no language parameter at all. `en-GB` is therefore valid for exactly one reviewed
 *   model. A panel that normalised those into one list would be inventing a standard none of the
 *   providers agreed to.
 */

import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';
import {
  estimateTranscriptionCostUsd,
  MAX_CONTEXT_PROMPT_CHARACTERS,
  MAX_INPUT_AUDIO_BYTES,
  MAX_INPUT_AUDIO_SECONDS,
  MIN_INPUT_AUDIO_BYTES,
  type AppliedTranscriptionControls,
  type TranscriptionControlName,
  type VerifiedAudioFacts
} from '../../shared/transcribe-audio';
import { readInputAudioDurationSeconds, sniffInputAudioMediaType } from './audio-bytes';
import { isPlausibleRunId } from './chat';
import { decodeBase64 } from './image-bytes';
import { findModelForTask, type ModelDescriptor } from './models';

/**
 * A Transcribe Audio request that has passed validation.
 *
 * As with every other panel this is a distinct type from the untrusted wire shape, so a function
 * requiring it cannot be handed unvalidated input. The audio is carried as verified bytes together
 * with the facts established about them, so no later tier needs to re-derive either.
 */
export interface ValidatedTranscribeAudioRequest {
  /**
   * The decoded audio, already confirmed to be an accepted format of acceptable size and duration
   * _for the selected model_.
   */
  audioBytes: Uint8Array;
  /**
   * What the server established about the audio; see {@link VerifiedAudioFacts}.
   */
  audioFacts: VerifiedAudioFacts;
  /**
   * The reviewed descriptor the requested identifier resolved to.
   */
  model: ModelDescriptor;
  /**
   * Opaque run identifier supplied by the browser.
   */
  runId: string;
  /**
   * Language hint, present only for a model that declares one.
   */
  language?: string;
  /**
   * Whether to ask the model to detect the language.
   */
  detectLanguage?: boolean;
  /**
   * Whether to ask the model to label speakers.
   */
  diarize?: boolean;
  /**
   * Whether to ask the model to punctuate.
   */
  punctuate?: boolean;
  /**
   * Trimmed context prompt, present only for a model that accepts one.
   */
  contextPrompt?: string;
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
 * Fields that would let a caller describe the audio rather than let the server determine it.
 *
 * Rejected rather than ignored, as the image panels do. A caller who sends `mediaType` believes it
 * matters; accepting and discarding it would teach them it worked. It matters more here than it
 * looks: Nova 3's schema _requires_ a `contentType`, so this value is a real field of the outgoing
 * request rather than only a safety check — and it must come from the bytes rather than from the
 * caller.
 */
const SELF_DESCRIBED_AUDIO_FIELDS: readonly string[] = [
  'mediaType',
  'contentType',
  'mimeType',
  'durationSeconds',
  'duration',
  'fileName'
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
 * Refuses a control the selected model does not support.
 *
 * @param control Control the caller supplied.
 * @param model Model it was requested against.
 * @returns Never; it always throws.
 * @throws {ProblemDetailsError} `badRequest()` (400) naming both the control and the model, so the
 *   caller learns which model to switch to rather than only that something was wrong.
 */
function unsupported(control: TranscriptionControlName, model: ModelDescriptor): never {
  throw badRequest({
    detail:
      `${model.name} does not support "${control}". Choose a model that offers that control, or `
      + 'remove it from the request.'
  });
}

/**
 * Validates an optional boolean control against a model's declared support.
 *
 * @param value Untrusted value, possibly absent.
 * @param control Control being validated, used in error messages.
 * @param supported Whether the model declares this control.
 * @param model Model the request was made against.
 * @returns The value, or `undefined` when the caller omitted it.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the model does not declare the control,
 *   or when the value is not a boolean.
 */
function validateFlag(
  value: unknown,
  control: TranscriptionControlName,
  supported: boolean | undefined,
  model: ModelDescriptor
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (supported !== true) {
    unsupported(control, model);
  }

  if (typeof value !== 'boolean') {
    throw badRequest({ detail: `"${control}" must be true or false.` });
  }

  return value;
}

/**
 * Formats a byte count as whole mebibytes for an error message.
 *
 * @param bytes Size to describe.
 * @returns A string such as `"4 MB"`.
 */
function formatMebibytes(bytes: number): string {
  return `${Math.round(bytes / (1_024 * 1_024))} MB`;
}

/**
 * Decodes and verifies the submitted audio against the selected model's own limit.
 *
 * Every check here is on content rather than on a claim, and the order is cheapest-first: an
 * oversized base64 string is refused before anything is allocated, the size is checked before the
 * signature is read, and the duration is read only once the format is known.
 *
 * The model is a parameter rather than a detail because the limit is a property of _its_ contract.
 * The same file is legitimately accepted for one reviewed model and refused for another, which is
 * the substance of this panel.
 *
 * @param value The untrusted `audioBase64` field.
 * @param model The resolved model, whose declared ceiling the size is checked against.
 * @returns The decoded bytes and the facts established about them.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the field is absent or not a string, is
 *   not valid base64, is empty or implausibly small, exceeds the model's declared ceiling, is not
 *   an accepted audio format, or declares a duration beyond {@link MAX_INPUT_AUDIO_SECONDS}.
 */
function validateAudio(
  value: unknown,
  model: ModelDescriptor
): { bytes: Uint8Array; facts: VerifiedAudioFacts } {
  if (typeof value !== 'string') {
    throw badRequest({ detail: 'Request body must contain an "audioBase64" string.' });
  }

  if (value === '') {
    throw badRequest({ detail: 'Choose an audio file to transcribe.' });
  }

  // The ceiling the model itself declares, falling back to the panel's own only if a descriptor
  // were ever incomplete. Reading it from the descriptor is what makes the limit per-model rather
  // than per-panel.
  const limit = model.transcriptionControls?.maxAudioBytes ?? MAX_INPUT_AUDIO_BYTES;

  // Checked before decoding. Base64 inflates by about a third, so bounding the encoded length
  // first means an oversized payload is refused without allocating the decoded buffer for it.
  if (value.length > Math.ceil(limit / 3) * 4 + 4) {
    throw oversized(model, limit);
  }

  const bytes = decodeBase64(value);
  if (bytes === undefined || bytes.length === 0) {
    throw badRequest({
      detail: 'That audio could not be read. Upload it again, or try a different file.'
    });
  }

  if (bytes.length > limit) {
    throw oversized(model, limit);
  }

  if (bytes.length < MIN_INPUT_AUDIO_BYTES) {
    throw badRequest({
      detail:
        'That file is too short to contain speech. Choose a recording with something spoken in it.'
    });
  }

  // The declared type is never consulted — the panel does not even send one. A file whose name and
  // content type say MP3 while its bytes say WAV is identified by its bytes, which matters
  // concretely here because Nova 3's schema *requires* a `contentType` and this is the value sent.
  const mediaType = sniffInputAudioMediaType(bytes);
  if (mediaType === undefined) {
    throw badRequest({
      detail:
        'That file is not audio this panel accepts. Use an MP3, WAV, Ogg, WebM, or MP4 recording.'
    });
  }

  const durationSeconds = readInputAudioDurationSeconds(bytes, mediaType);

  // Enforced only where the duration is genuinely knowable, which is why this is not an `else`
  // branch refusing the unknown case: for a compressed file the byte limit is the only bound, and
  // claiming a duration check we do not perform would be worse than stating the limitation.
  if (durationSeconds !== undefined && durationSeconds > MAX_INPUT_AUDIO_SECONDS) {
    throw badRequest({
      detail:
        `That recording is ${Math.round(durationSeconds / 60)} minutes long, and this panel `
        + `accepts up to ${MAX_INPUT_AUDIO_SECONDS / 60}. Trim it and try again.`
    });
  }

  return {
    bytes,
    facts: {
      mediaType,
      byteLength: bytes.length,
      ...(durationSeconds === undefined ? {} : { durationSeconds })
    }
  };
}

/**
 * Builds the refusal for a file beyond a model's declared ceiling.
 *
 * Names the model and, when its limit is below the panel's ceiling, says _why_ it is lower. A bare
 * "too large" would leave a visitor who just succeeded with the same file on another model
 * believing the panel was broken.
 *
 * @param model The model the file was submitted against.
 * @param limit That model's declared ceiling in bytes.
 * @returns A `400` problem-details error.
 */
function oversized(model: ModelDescriptor, limit: number): ReturnType<typeof badRequest> {
  const constrained = limit < MAX_INPUT_AUDIO_BYTES;

  return badRequest({
    detail:
      `That recording is larger than the ${formatMebibytes(limit)} limit for ${model.name}.`
      + (constrained
        ? ` This model's contract requires the audio as a JSON array of byte values, which costs `
          + `far more memory than the file itself, so its limit is lower than the `
          + `${formatMebibytes(MAX_INPUT_AUDIO_BYTES)} other models accept. Choose a different `
          + 'model, or use a shorter recording.'
        : ' Use a shorter recording.')
  });
}

/**
 * Validates an untrusted Transcribe Audio request body.
 *
 * @param body Parsed JSON request body, of unknown shape.
 * @returns The validated request with its model resolved and its audio verified; see
 *   {@link ValidatedTranscribeAudioRequest}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is not an object; when it
 *   carries an identity field or a self-described audio field; when `runId` is malformed; when
 *   `model` is not a reviewed model registered against this panel; when a control is unsupported by
 *   that model or not one of its declared values; when both a language hint and language detection
 *   are asked for; or when the audio is missing, undecodable, too small, beyond that model's
 *   ceiling, not an accepted format, or longer than the duration limit.
 */
export function validateTranscribeAudioRequest(body: unknown): ValidatedTranscribeAudioRequest {
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

  for (const field of SELF_DESCRIBED_AUDIO_FIELDS) {
    if (Object.hasOwn(source, field)) {
      throw badRequest({
        detail:
          `Request body must not contain "${field}". The server determines the recording\u2019s `
          + 'format and duration from its bytes.'
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
  const model = findModelForTask('transcribe-audio', modelId);
  if (model === undefined) {
    throw badRequest({
      detail: 'That model is not one of the reviewed models available for Transcribe Audio.'
    });
  }

  const controls = model.transcriptionControls;
  if (controls === undefined) {
    throw badRequest({ detail: 'That model has no reviewed transcription controls.' });
  }

  const rawLanguage = property(source, 'language');
  let language: string | undefined;

  if (rawLanguage !== undefined) {
    if (controls.languages === undefined) {
      unsupported('language', model);
    }

    if (typeof rawLanguage !== 'string') {
      throw badRequest({ detail: '"language" must be a string.' });
    }

    // Compared exactly rather than case-insensitively, and against this model's own list. `en-GB`
    // is a legitimate value for exactly one reviewed model, because one takes BCP-47 tags and the
    // other takes ISO 639-1 codes. Normalising them into a single list would invent a standard no
    // provider agreed to, and would move a clear refusal here into an opaque failure upstream.
    if (!controls.languages.includes(rawLanguage)) {
      throw badRequest({
        detail:
          `"${rawLanguage}" is not a language ${model.name} accepts. Each model declares its own `
          + 'list, and they do not use the same style of code.'
      });
    }

    language = rawLanguage;
  }

  const detectLanguage = validateFlag(
    property(source, 'detectLanguage'),
    'detectLanguage',
    controls.supportsLanguageDetection,
    model
  );

  // Mutually exclusive by meaning rather than by schema. Both fields are individually legal for
  // Nova 3, but asking it to detect the language *and* telling it the language is a contradictory
  // request, and the provider would silently honour one of them. Refusing is more honest than
  // picking a winner on the visitor's behalf.
  if (detectLanguage === true && language !== undefined) {
    throw badRequest({
      detail:
        'Choose either a language hint or language detection, not both. Detection ignores the '
        + 'hint, so sending both would hide which one took effect.'
    });
  }

  const diarize = validateFlag(
    property(source, 'diarize'),
    'diarize',
    controls.supportsDiarization,
    model
  );
  const punctuate = validateFlag(
    property(source, 'punctuate'),
    'punctuate',
    controls.supportsPunctuation,
    model
  );

  const rawContextPrompt = property(source, 'contextPrompt');
  let contextPrompt: string | undefined;

  if (rawContextPrompt !== undefined) {
    if (controls.supportsContextPrompt !== true) {
      unsupported('contextPrompt', model);
    }

    if (typeof rawContextPrompt !== 'string') {
      throw badRequest({ detail: '"contextPrompt" must be a string.' });
    }

    const trimmed = rawContextPrompt.trim();
    // Counted in code points rather than UTF-16 units, matching every other panel's limit, so a
    // non-BMP character counts once rather than twice.
    if ([...trimmed].length > MAX_CONTEXT_PROMPT_CHARACTERS) {
      throw badRequest({
        detail:
          `The context prompt exceeds the ${MAX_CONTEXT_PROMPT_CHARACTERS.toLocaleString()}-`
          + 'character limit.'
      });
    }

    // An empty prompt is treated as absent rather than sent as an empty string, which the provider
    // would take as a real instruction to bias towards nothing.
    contextPrompt = trimmed === '' ? undefined : trimmed;
  }

  // Validated last, because it is by far the most expensive check and there is no reason to decode
  // megabytes of audio for a request that was already going to be refused for naming an unknown
  // model or an unsupported control.
  const audio = validateAudio(property(source, 'audioBase64'), model);

  return {
    audioBytes: audio.bytes,
    audioFacts: audio.facts,
    model,
    runId,
    ...(language === undefined ? {} : { language }),
    ...(detectLanguage === undefined ? {} : { detectLanguage }),
    ...(diarize === undefined ? {} : { diarize }),
    ...(punctuate === undefined ? {} : { punctuate }),
    ...(contextPrompt === undefined ? {} : { contextPrompt })
  };
}

/**
 * Encodes bytes as base64 for a model whose schema takes a string.
 *
 * Built in 8 KiB chunks rather than one spread call, for the same reason the image encoder is:
 * `String.fromCharCode(...bytes)` on a multi-megabyte buffer exceeds the argument limit and throws
 * a `RangeError`, turning a large but valid file into an unexplained failure.
 *
 * @param bytes Audio to encode.
 * @returns The base64 representation.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 8_192;
  let binary = '';

  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }

  return btoa(binary);
}

/**
 * Builds the model input for a validated Transcribe Audio request.
 *
 * The audio takes whichever encoding the selected model's schema demands — three genuinely
 * different shapes for the same bytes — and only fields that model declared are included. A model
 * that receives only the fields it accepts cannot reject the request for an undeclared property.
 *
 * @param request A validated request.
 * @returns The provider-shaped input payload.
 */
export function buildTranscribeAudioInput(
  request: ValidatedTranscribeAudioRequest
): Record<string, unknown> {
  const controls = request.model.transcriptionControls;
  const input: Record<string, unknown> = {};

  if (controls === undefined) {
    return input;
  }

  switch (controls.audioEncoding) {
    case 'base64': {
      input['audio'] = toBase64(request.audioBytes);
      break;
    }
    case 'body-object': {
      // Nova 3 requires both properties. The content type is the one the server sniffed, never one
      // the caller supplied — which is why the self-described fields are refused rather than
      // ignored: this value is a real field of the outgoing request.
      input['audio'] = {
        body: toBase64(request.audioBytes),
        contentType: request.audioFacts.mediaType
      };
      break;
    }
    case 'byte-array': {
      // One JSON number per byte, which is what the original Whisper's schema documents. Wasteful,
      // and what the contract specifies — so the reviewed descriptor follows the schema rather
      // than an assumption about what the binding might also accept, and declares a smaller size
      // ceiling to make it safe.
      input['audio'] = [...request.audioBytes];
      break;
    }
  }

  if (request.language !== undefined) {
    input['language'] = request.language;
  }
  if (request.detectLanguage !== undefined) {
    input['detect_language'] = request.detectLanguage;
  }
  if (request.diarize !== undefined) {
    input['diarize'] = request.diarize;
  }
  if (request.punctuate !== undefined) {
    input['punctuate'] = request.punctuate;
  }
  if (request.contextPrompt !== undefined) {
    input['initial_prompt'] = request.contextPrompt;
  }

  return input;
}

/**
 * Describes the settings a transcript was actually produced with.
 *
 * A control the model does not support is left absent rather than reported with an invented value,
 * and the context prompt is reported as a flag rather than echoed — the browser already has the
 * text, and returning it would put the visitor's content in one more place for no benefit.
 *
 * @param request A validated request.
 * @returns The applied controls, including the pre-request cost estimate where the duration made
 *   one possible; see {@link AppliedTranscriptionControls}.
 */
export function describeAppliedTranscriptionControls(
  request: ValidatedTranscribeAudioRequest
): AppliedTranscriptionControls {
  const estimatedCostUsd = estimateTranscriptionCostUsd(
    request.audioFacts.durationSeconds,
    request.model.transcriptionControls?.pricePerAudioMinuteUsd
  );

  return {
    model: request.model.id,
    ...(request.language === undefined ? {} : { language: request.language }),
    ...(request.detectLanguage === undefined ? {} : { detectLanguage: request.detectLanguage }),
    ...(request.diarize === undefined ? {} : { diarize: request.diarize }),
    ...(request.punctuate === undefined ? {} : { punctuate: request.punctuate }),
    ...(request.contextPrompt === undefined ? {} : { contextPromptUsed: true }),
    // Absent rather than zero when the duration is unknown. A zero would read as "free", which is
    // the one thing a cost figure must never do.
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd })
  };
}
