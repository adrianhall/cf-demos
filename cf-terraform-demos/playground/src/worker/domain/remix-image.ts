/**
 * @file Validation and explicit provider-input construction for reviewed Remix Image models.
 */
import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';
import {
  MAX_REMIX_INSTRUCTION_CHARACTERS,
  type AppliedRemixImageControls
} from '../../shared/remix-image';
import { isPlausibleRunId } from './chat';
import { MAX_SEED } from './create-image';
import { encodeBase64 } from './image-bytes';
import { validateInputImage, type ValidatedInputImage } from './input-image';
import { findModelForTask, type ModelDescriptor } from './models';

/**
 * Validated Remix Image request.
 */
export interface ValidatedRemixImageRequest {
  /**
   * Server-verified source image.
   */
  source: ValidatedInputImage;
  /**
   * Reviewed selected model.
   */
  model: ModelDescriptor;
  /**
   * Browser-generated run identifier.
   */
  runId: string;
  /**
   * Trimmed required editing instruction.
   */
  instruction: string;
  /**
   * Optional reproducibility seed.
   */
  seed?: number;
}

const FORBIDDEN_FIELDS = ['user', 'email', 'actor', 'sub'] as const;
const SELF_DESCRIBED_IMAGE_FIELDS = [
  'mediaType',
  'contentType',
  'mimeType',
  'fileName',
  'width',
  'height'
] as const;
const RETIRED_INPAINTING_FIELDS = ['maskBase64', 'strength'] as const;

/**
 * Reads an own JSON property.
 */
function property(source: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

/**
 * Validates the narrow Remix Image request against the selected descriptor.
 *
 * @param body Untrusted parsed JSON request body.
 * @returns A request containing verified source bytes and descriptor-approved controls.
 * @throws {ProblemDetailsError} When identity, image, model, instruction, or seed is invalid.
 */
export function validateRemixImageRequest(body: unknown): ValidatedRemixImageRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest({ detail: 'Request body must be a JSON object.' });
  }
  const source = body as Record<string, unknown>;
  for (const field of [...FORBIDDEN_FIELDS, ...SELF_DESCRIBED_IMAGE_FIELDS]) {
    if (Object.hasOwn(source, field)) {
      throw badRequest({ detail: `Request body must not contain "${field}".` });
    }
  }
  for (const field of RETIRED_INPAINTING_FIELDS) {
    if (Object.hasOwn(source, field)) {
      throw badRequest({
        detail: `Request body must not contain "${field}". Remix Image uses reference-image editing, not inpainting.`
      });
    }
  }

  const runId = property(source, 'runId');
  if (typeof runId !== 'string' || !isPlausibleRunId(runId)) {
    throw badRequest({ detail: 'Request body must contain a valid "runId".' });
  }
  const modelId = property(source, 'model');
  if (typeof modelId !== 'string') {
    throw badRequest({ detail: 'Request body must contain a "model" identifier.' });
  }
  const model = findModelForTask('remix-image', modelId);
  const controls = model?.remixImageControls;
  if (model === undefined || controls === undefined) {
    throw badRequest({
      detail: 'That model is not one of the reviewed models available for Remix Image.'
    });
  }

  const rawInstruction = property(source, 'instruction');
  if (typeof rawInstruction !== 'string' || rawInstruction.trim() === '') {
    throw badRequest({ detail: 'Describe how you want to edit the picture.' });
  }
  const instruction = rawInstruction.trim();
  if ([...instruction].length > MAX_REMIX_INSTRUCTION_CHARACTERS) {
    throw badRequest({
      detail: `The instruction exceeds the ${MAX_REMIX_INSTRUCTION_CHARACTERS.toLocaleString()}-character limit.`
    });
  }

  const input = validateInputImage(property(source, 'imageBase64'), 'imageBase64', 'remix');
  const longestEdge = Math.max(input.facts.width, input.facts.height);
  if (controls.maxInputEdge !== undefined && longestEdge > controls.maxInputEdge) {
    throw badRequest({
      detail:
        `${model.name} accepts reference images up to ${controls.maxInputEdge}×${controls.maxInputEdge} pixels. `
        + `This source is ${input.facts.width}×${input.facts.height}; resize it or choose another model.`
    });
  }

  const seedValue = property(source, 'seed');
  let seed: number | undefined;
  if (seedValue !== undefined) {
    if (!controls.seed) {
      throw badRequest({ detail: `${model.name} does not support "seed".` });
    }
    if (
      typeof seedValue !== 'number'
      || !Number.isInteger(seedValue)
      || seedValue < 0
      || seedValue > MAX_SEED
    ) {
      throw badRequest({ detail: `"seed" must be a whole number between 0 and ${MAX_SEED}.` });
    }
    seed = seedValue;
  }
  return { source: input, model, runId, instruction, seed };
}

/**
 * Builds the exact reviewed provider payload selected by the descriptor.
 *
 * @param request Validated panel request.
 * @returns JSON or multipart binding payload with no unreviewed fields.
 */
export function buildRemixImageInput(request: ValidatedRemixImageRequest): Record<string, unknown> {
  const controls = request.model.remixImageControls;
  if (controls === undefined) {
    throw new Error('Validated Remix Image model has no control contract.');
  }
  const sourceUri = `data:${request.source.facts.mediaType};base64,${encodeBase64(request.source.bytes)}`;

  switch (controls.inputAdapter) {
    case 'flux-multipart':
      return fluxMultipartInput(request);
    case 'pruna-json':
      return {
        prompt: request.instruction,
        images: [sourceUri],
        turbo: true,
        aspect_ratio: 'match_input_image',
        disable_safety_checker: false,
        ...(request.seed === undefined ? {} : { seed: request.seed })
      };
    case 'nano-banana-json':
      return {
        prompt: request.instruction,
        image_input: [sourceUri],
        aspect_ratio: 'match_input_image',
        output_format: 'png',
        resolution: '1K'
      };
    default:
      return controls.inputAdapter satisfies never;
  }
}

/**
 * Builds FLUX.2 Dev's multipart binding envelope.
 */
function fluxMultipartInput(request: ValidatedRemixImageRequest): Record<string, unknown> {
  const form = new FormData();
  form.append('prompt', request.instruction);
  form.append(
    'input_image_0',
    new Blob([Uint8Array.from(request.source.bytes)], { type: request.source.facts.mediaType }),
    'source-image'
  );
  form.append('width', String(request.source.facts.width));
  form.append('height', String(request.source.facts.height));

  const serialised = new Response(form);
  const contentType = serialised.headers.get('content-type');
  if (serialised.body === null || contentType === null) {
    throw new Error('The runtime could not serialise the FLUX multipart request.');
  }
  return { multipart: { body: serialised.body, contentType } };
}

/**
 * Describes the controls actually applied.
 *
 * @param request Validated panel request.
 * @returns Safe applied-control metadata.
 */
export function describeAppliedRemixControls(
  request: ValidatedRemixImageRequest
): AppliedRemixImageControls {
  return {
    model: request.model.id,
    instruction: request.instruction,
    ...(request.seed === undefined ? {} : { seed: request.seed })
  };
}
