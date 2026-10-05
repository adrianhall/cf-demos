import { Hono } from 'hono';
import { currentIdentity, jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import { MAX_INPUT_IMAGE_BYTES } from '../../shared/describe-image';
import type { DetectObjectsResponse } from '../../shared/detect-objects';
import type { AppBindings } from '../bindings';
import {
  validateDetectObjectsRequest,
  type ValidatedDetectObjectsRequest
} from '../domain/detect-objects';
/**
 * Maximum JSON payload including base64 inflation.
 */
export const DETECT_OBJECTS_BODY_LIMIT_BYTES = Math.ceil(MAX_INPUT_IMAGE_BYTES * 1.4) + 4_096;
/**
 * Detect Objects endpoint.
 */
export const detectObjectsRouter = new Hono<AppBindings>();
detectObjectsRouter.use(jsonBodyLimit(DETECT_OBJECTS_BODY_LIMIT_BYTES));
/**
 * Builds privacy-safe attempt diagnostics. @param request Validated request. @returns Metadata
 * without image or target text.
 */
function describeAttempt(request: ValidatedDetectObjectsRequest): Record<string, unknown> {
  return {
    model: request.model.id,
    contractVersion: request.model.contractVersion,
    imageByteLength: request.source.facts.byteLength,
    imageWidth: request.source.facts.width,
    imageHeight: request.source.facts.height,
    targetLength: request.target.length,
    maxObjects: request.maxObjects
  };
}
/**
 * Handles a detection request. @param context Hono context. @returns JSON result. @throws
 * {ProblemDetailsError} When input or provider output is invalid.
 */
detectObjectsRouter.post('/', async (context) => {
  const request = validateDetectObjectsRequest(await readJsonBody(context.req.raw));
  const identity = currentIdentity(context);
  const actor = { email: identity.email, sub: identity.sub };
  const logger = context.var.LOGGER;
  logger.info('detect_objects_run_started', { runId: request.runId, ...describeAttempt(request) });
  try {
    const result = await context.var.DETECT_OBJECTS_SERVICE.detect(request, actor);
    logger.info('detect_objects_run_completed', {
      runId: request.runId,
      model: result.receipt.model,
      returnedRegions: result.detections.length
    });
    const response: DetectObjectsResponse = result;
    return context.json(response);
  } catch (cause) {
    logger.warn('detect_objects_run_failed', { runId: request.runId, ...describeAttempt(request) });
    throw cause;
  }
});
