import { Hono } from 'hono';
import { currentIdentity, jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import { MAX_INPUT_IMAGE_BYTES } from '../../shared/describe-image';
import type { RemixImageResponse } from '../../shared/remix-image';
import type { AppBindings } from '../bindings';
import { validateRemixImageRequest, type ValidatedRemixImageRequest } from '../domain/remix-image';

/**
 * Largest Remix Image JSON body: two 1 MiB images at base64 expansion plus instruction and
 * envelope.
 *
 * The descriptor currently permits masks, so this cap supports the maximum honest request
 * regardless of the selected model. Domain validation still rejects a mask for a model that does
 * not declare it.
 */
export const REMIX_IMAGE_BODY_LIMIT_BYTES = Math.ceil(MAX_INPUT_IMAGE_BYTES * (8 / 3)) + 32_768;

/**
 * Remix Image endpoint, mounted at `/api/remix-image`.
 */
export const remixImageRouter = new Hono<AppBindings>();
remixImageRouter.use(jsonBodyLimit(REMIX_IMAGE_BODY_LIMIT_BYTES));

/**
 * Produces privacy-safe attempt log fields.
 */
function logFields(request: ValidatedRemixImageRequest): Record<string, unknown> {
  return {
    runId: request.runId,
    model: request.model.id,
    contractVersion: request.model.contractVersion,
    instructionLength: [...request.instruction].length,
    source: request.source.facts,
    requestedControls: request.seed === undefined ? [] : ['seed']
  };
}

/**
 * Runs one image transformation.
 *
 * @param context Authenticated Hono request context.
 * @returns The normalised image and gateway receipt.
 * @throws {ProblemDetailsError} For malformed input or unusable provider output.
 */
remixImageRouter.post('/', async (context) => {
  const request = validateRemixImageRequest(await readJsonBody(context.req.raw));
  const identity = currentIdentity(context);
  const actor = { email: identity.email, sub: identity.sub };
  const logger = context.var.LOGGER;
  logger.info('remix_image_run_started', logFields(request));
  try {
    const result = await context.var.REMIX_IMAGE_SERVICE.remix(request, actor);
    logger.info('remix_image_run_completed', {
      runId: result.receipt.runId,
      model: result.receipt.model,
      elapsedMs: result.receipt.elapsedMs,
      costStatus: result.receipt.costStatus,
      logCount: result.receipt.logIds.length,
      mediaType: result.image.mediaType,
      byteLength: result.image.byteLength
    });
    const response: RemixImageResponse = result;
    return context.json(response);
  } catch (cause) {
    logger.warn('remix_image_run_failed', logFields(request));
    throw cause;
  }
});
