/**
 * @file Describe Image request validation and model-input construction. Create Image's lesson was
 *   that models disagree about _controls_. This panel's lesson is that they disagree about what is
 *   _required_: LLaVA will caption a bare picture, while Llama 3.2 Vision marks its prompt as
 *   required with `minLength: 1` and rejects a request without one. A panel that quietly supplied
 *   "Describe this image" for the second model would hide a real contract difference and silently
 *   put words in the visitor's mouth, so the question is required or optional according to the
 *   selected model's declaration. The other substance here is that the untrusted input is now a
 *   _file_. Everything a browser said about it is ignored: the format comes from the bytes, the
 *   dimensions come from the header, and both are checked before anything is sent to a provider. A
 *   declared content type is exactly the kind of value an attacker controls, so this tier never
 *   reads one.
 */

import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';
import {
  MAX_IMAGE_EDGE_PIXELS,
  MAX_INPUT_IMAGE_BYTES,
  MAX_INSTRUCTION_CHARACTERS,
  MIN_IMAGE_EDGE_PIXELS,
  type AppliedVisionControls,
  type NumericVisionRange,
  type VerifiedImageFacts,
  type VisionControlName
} from '../../describe-image';
import { isPlausibleRunId } from './chat';
import { decodeBase64, readImageDimensions, sniffImageMediaType } from './image-bytes';
import { findModelForTask, type ModelDescriptor } from './models';

/**
 * A Describe Image request that has passed validation.
 *
 * As with the other panels this is a distinct type from the untrusted wire shape, so a function
 * requiring it cannot be handed unvalidated input. The image is carried as verified bytes together
 * with the facts established about them, so no later tier needs to re-derive either.
 */
export interface ValidatedDescribeImageRequest {
  /**
   * The decoded picture, already confirmed to be a renderable raster format of acceptable size and
   * dimensions.
   */
  imageBytes: Uint8Array;
  /**
   * What the server established about the picture; see {@link VerifiedImageFacts}.
   */
  imageFacts: VerifiedImageFacts;
  /**
   * The reviewed descriptor the requested identifier resolved to.
   */
  model: ModelDescriptor;
  /**
   * Opaque run identifier supplied by the browser.
   */
  runId: string;
  /**
   * Trimmed question. Always present for a model that requires one.
   */
  instruction?: string;
  /**
   * Answer-length cap, within the model's declared range.
   */
  maxTokens?: number;
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
 * Rejected rather than ignored, which is the same choice this demo makes for identity fields and
 * for unsupported controls. A caller who sends `mediaType` believes it matters; accepting and
 * discarding it would teach them it worked. The server decides what the bytes are, and saying so
 * explicitly is more honest than silence.
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
 * @throws {ProblemDetailsError} `badRequest()` (400) naming both the control and the model.
 */
function unsupported(control: VisionControlName, model: ModelDescriptor): never {
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
 * @returns The value, or `undefined` when the caller omitted it.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the model does not support the control,
 *   when the value is not a finite whole number, or when it falls outside the declared range.
 */
function validateControl(
  value: unknown,
  control: VisionControlName,
  range: NumericVisionRange | undefined,
  model: ModelDescriptor
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

  if (!Number.isInteger(value)) {
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
 * Decodes and verifies the submitted picture.
 *
 * Every check here is on content rather than on a claim. The order matters and is cheapest-first: a
 * malformed base64 string is rejected before anything is allocated, the size is checked before the
 * header is parsed, and the dimensions are read only once the format is known.
 *
 * @param value The untrusted `imageBase64` field.
 * @returns The decoded bytes and the facts established about them.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the field is absent or not a string, is
 *   not valid base64, is empty, exceeds {@link MAX_INPUT_IMAGE_BYTES}, is not a PNG/JPEG/WebP, has
 *   an unreadable header, or falls outside the accepted pixel range.
 */
function validateImage(value: unknown): {
  bytes: Uint8Array;
  facts: VerifiedImageFacts;
} {
  if (typeof value !== 'string') {
    throw badRequest({ detail: 'Request body must contain an "imageBase64" string.' });
  }

  if (value === '') {
    throw badRequest({ detail: 'Choose a picture to describe.' });
  }

  // Checked before decoding. Base64 inflates by about a third, so bounding the encoded length
  // first means an oversized payload is refused without allocating the decoded buffer for it.
  if (value.length > Math.ceil(MAX_INPUT_IMAGE_BYTES / 3) * 4 + 4) {
    throw badRequest({
      detail: `That picture is larger than the ${formatMebibytes(MAX_INPUT_IMAGE_BYTES)} limit.`
    });
  }

  const bytes = decodeBase64(value);
  if (bytes === undefined || bytes.length === 0) {
    throw badRequest({
      detail: 'That picture could not be read. Upload it again, or try a different file.'
    });
  }

  if (bytes.length > MAX_INPUT_IMAGE_BYTES) {
    throw badRequest({
      detail: `That picture is larger than the ${formatMebibytes(MAX_INPUT_IMAGE_BYTES)} limit.`
    });
  }

  // The declared type is never consulted — the panel does not even send one. A file whose name and
  // content type say PNG while its bytes say something else is identified by its bytes.
  const mediaType = sniffImageMediaType(bytes);
  if (mediaType === undefined) {
    throw badRequest({
      detail: 'That file is not a picture this panel accepts. Use a PNG, JPEG, or WebP image.'
    });
  }

  const dimensions = readImageDimensions(bytes, mediaType);
  if (dimensions === undefined) {
    throw badRequest({
      detail: 'That picture\u2019s dimensions could not be read, so it may be damaged.'
    });
  }

  const longestEdge = Math.max(dimensions.width, dimensions.height);
  if (longestEdge > MAX_IMAGE_EDGE_PIXELS) {
    throw badRequest({
      detail:
        `That picture is ${dimensions.width}\u00d7${dimensions.height} pixels, and this panel `
        + `accepts up to ${MAX_IMAGE_EDGE_PIXELS} on its longest edge. Scale it down and try `
        + 'again.'
    });
  }

  if (Math.min(dimensions.width, dimensions.height) < MIN_IMAGE_EDGE_PIXELS) {
    throw badRequest({
      detail:
        `That picture is ${dimensions.width}\u00d7${dimensions.height} pixels, which is too small `
        + 'for a model to describe.'
    });
  }

  return {
    bytes,
    facts: {
      mediaType,
      byteLength: bytes.length,
      width: dimensions.width,
      height: dimensions.height
    }
  };
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
 * Validates an untrusted Describe Image request body.
 *
 * @param body Parsed JSON request body, of unknown shape.
 * @returns The validated request with its model resolved and its image verified; see
 *   {@link ValidatedDescribeImageRequest}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is not an object; when it
 *   carries an identity field or a self-described image field; when the image is missing,
 *   undecodable, oversized, not a supported format, or outside the pixel limits; when `runId` is
 *   malformed; when `model` is not a reviewed model registered against this panel; when a required
 *   question is absent or an over-long one is given; or when a control is unsupported by that model
 *   or outside its declared range.
 */
export function validateDescribeImageRequest(body: unknown): ValidatedDescribeImageRequest {
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
  const model = findModelForTask('describe-image', modelId);
  if (model === undefined) {
    throw badRequest({
      detail: 'That model is not one of the reviewed models available for Describe Image.'
    });
  }

  const controls = model.visionControls;
  if (controls === undefined) {
    throw badRequest({ detail: 'That model has no reviewed vision controls.' });
  }

  const rawInstruction = property(source, 'instruction');
  let instruction: string | undefined;

  if (rawInstruction !== undefined) {
    if (typeof rawInstruction !== 'string') {
      throw badRequest({ detail: '"instruction" must be a string.' });
    }

    const trimmed = rawInstruction.trim();
    if ([...trimmed].length > MAX_INSTRUCTION_CHARACTERS) {
      throw badRequest({
        detail:
          `Your question exceeds the ${MAX_INSTRUCTION_CHARACTERS.toLocaleString()}-character `
          + 'limit.'
      });
    }

    instruction = trimmed === '' ? undefined : trimmed;
  }

  // The contract difference this panel exists to show. Rather than substituting a default question
  // for a model that demands one, the request is refused and the message names the alternative —
  // so the visitor learns the models differ instead of having the difference hidden from them.
  if (controls.instructionRequired && instruction === undefined) {
    throw badRequest({
      detail:
        `${model.name} requires a question about the picture. Ask something, or choose a model `
        + 'that captions an image on its own.'
    });
  }

  const maxTokens = validateControl(
    property(source, 'maxTokens'),
    'maxTokens',
    controls.maxTokens,
    model
  );

  const image = validateImage(property(source, 'imageBase64'));

  return {
    imageBytes: image.bytes,
    imageFacts: image.facts,
    model,
    runId,
    ...(instruction === undefined ? {} : { instruction }),
    ...(maxTokens === undefined ? {} : { maxTokens })
  };
}

/**
 * Builds the model input for a validated Describe Image request.
 *
 * The image travels as an array of byte values, which is the form both reviewed models' schemas
 * document for the `image` field. It is a wasteful encoding — one JSON number per byte — and it is
 * what the contract specifies, so the reviewed descriptor follows the schema rather than an
 * assumption about what the binding might also accept.
 *
 * @param request A validated request.
 * @returns The provider-shaped input payload.
 */
export function buildDescribeImageInput(
  request: ValidatedDescribeImageRequest
): Record<string, unknown> {
  const controls = request.model.visionControls;
  const input: Record<string, unknown> = {
    image: [...request.imageBytes]
  };

  // Sent whenever the visitor asked something. For a model that requires a question validation has
  // already guaranteed one is present; for a model that does not, omitting the field is what makes
  // it caption the picture unprompted.
  if (request.instruction !== undefined) {
    input['prompt'] = request.instruction;
  }

  if (request.maxTokens !== undefined && controls?.maxTokens !== undefined) {
    input['max_tokens'] = request.maxTokens;
  }

  return input;
}

/**
 * Describes the settings a description was actually produced with.
 *
 * Model defaults are filled in for controls the caller omitted, so the panel can report what
 * produced an answer rather than only what was explicitly chosen.
 *
 * @param request A validated request.
 * @returns The applied controls; see {@link AppliedVisionControls}.
 */
export function describeAppliedVisionControls(
  request: ValidatedDescribeImageRequest
): AppliedVisionControls {
  const controls = request.model.visionControls;
  const maxTokens =
    controls?.maxTokens === undefined
      ? undefined
      : (request.maxTokens ?? controls.maxTokens.default);

  return {
    model: request.model.id,
    ...(request.instruction === undefined ? {} : { instruction: request.instruction }),
    ...(maxTokens === undefined ? {} : { maxTokens })
  };
}
