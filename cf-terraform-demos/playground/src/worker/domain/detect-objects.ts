import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';
import {
  MAX_DETECTION_TARGET_LENGTH,
  type AppliedDetectionControls
} from '../../shared/detect-objects';
import { isPlausibleRunId } from './chat';
import { validateInputImage, type ValidatedInputImage } from './input-image';
import { findModelForTask, type ModelDescriptor } from './models';

/**
 * A detection request that has passed all boundary validation.
 */
export interface ValidatedDetectObjectsRequest {
  /**
   * Verified image bytes and facts.
   */ source: ValidatedInputImage;
  /**
   * Reviewed model.
   */ model: ModelDescriptor;
  /**
   * Correlation ID.
   */ runId: string;
  /**
   * Phrase the provider should locate.
   */ target: string;
  /**
   * Maximum boxes the provider should return.
   */ maxObjects: number;
}
const FORBIDDEN_FIELDS = [
  'user',
  'email',
  'actor',
  'sub',
  'mediaType',
  'contentType',
  'mimeType',
  'width',
  'height',
  'fileName'
] as const;
const GENERATIVE_FIELDS = ['instruction', 'prompt', 'question', 'negativePrompt'] as const;
function field(body: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(body, key) ? body[key] : undefined;
}
/**
 * Validates an untrusted Detect Objects request. @param body Parsed JSON body. @returns Validated
 * request. @throws {ProblemDetailsError} When body fields or controls are invalid.
 */
export function validateDetectObjectsRequest(body: unknown): ValidatedDetectObjectsRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw badRequest({ detail: 'Request body must be a JSON object.' });
  const source = body as Record<string, unknown>;
  for (const key of FORBIDDEN_FIELDS)
    if (Object.hasOwn(source, key))
      throw badRequest({
        detail: `Request body must not contain "${key}". The server derives identity and image facts itself.`
      });
  for (const key of GENERATIVE_FIELDS)
    if (Object.hasOwn(source, key))
      throw badRequest({
        detail: `Request body must not contain "${key}". Detect Objects locates the target phrase; it does not accept a generative instruction.`
      });
  const runId = field(source, 'runId');
  if (typeof runId !== 'string' || !isPlausibleRunId(runId))
    throw badRequest({ detail: 'Request body must contain a plausible "runId".' });
  const modelId = field(source, 'model');
  if (typeof modelId !== 'string')
    throw badRequest({ detail: 'Request body must contain a "model" identifier.' });
  const model = findModelForTask('detect-objects', modelId);
  if (model?.detectionControls === undefined)
    throw badRequest({
      detail: 'That model is not one of the reviewed models available for Detect Objects.'
    });
  const target = field(source, 'target');
  if (typeof target !== 'string' || target.trim() === '')
    throw badRequest({ detail: 'Request body must contain a non-empty "target" phrase.' });
  if (target.trim().length > MAX_DETECTION_TARGET_LENGTH)
    throw badRequest({
      detail: `A target phrase must be ${MAX_DETECTION_TARGET_LENGTH} characters or fewer. This panel locates a thing you name, such as "person wearing a red shirt", so the limit is this demo's own rather than the model's.`
    });
  const maxObjectsRaw = field(source, 'maxObjects');
  const range = model.detectionControls.maxObjects;
  const maxObjects = maxObjectsRaw === undefined ? range.default : maxObjectsRaw;
  if (
    typeof maxObjects !== 'number'
    || !Number.isInteger(maxObjects)
    || maxObjects < range.min
    || maxObjects > range.max
  )
    throw badRequest({
      detail: `"maxObjects" must be a whole number between ${range.min} and ${range.max}.`
    });
  return {
    source: validateInputImage(field(source, 'imageBase64'), 'imageBase64', 'classify'),
    model,
    runId,
    target: target.trim(),
    maxObjects
  };
}
/**
 * Builds the precise reviewed Moondream detect payload. @param request Validated request. @returns
 * Provider input.
 */
export function buildDetectObjectsInput(
  request: ValidatedDetectObjectsRequest
): Record<string, unknown> {
  let binary = '';
  for (const byte of request.source.bytes) binary += String.fromCodePoint(byte);
  return {
    task: 'detect',
    image: `data:${request.source.facts.mediaType};base64,${btoa(binary)}`,
    target: request.target,
    max_objects: request.maxObjects,
    stream: false
  };
}
/**
 * Records effective model settings. @param request Validated request. @returns Applied controls.
 */
export function describeAppliedDetectionControls(
  request: ValidatedDetectObjectsRequest
): AppliedDetectionControls {
  return { model: request.model.id, target: request.target, maxObjects: request.maxObjects };
}
