import { Hono } from 'hono';
import { currentIdentity, jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import type { CreateImageResponse } from '../../images';
import type { AppBindings } from '../bindings';
import { validateCreateImageRequest } from '../domain/create-image';

/**
 * Largest Create Image request body accepted.
 *
 * The request is pure text — a prompt, an optional negative prompt, and a handful of numbers — so
 * the shared 8 KiB default would very nearly do. 16 KiB leaves room for two 2,048-character prompts
 * in a multi-byte script, where each character can occupy four bytes, without inviting anything
 * larger.
 *
 * Note which direction the volume travels on this endpoint: a small request produces a response of
 * several megabytes. The response is bounded separately, inside the service, by `MAX_IMAGE_BYTES`.
 */
export const CREATE_IMAGE_BODY_LIMIT_BYTES = 16_384;

/**
 * Create Image's endpoint, mounted at `/api/create-image`.
 *
 * A plain JSON `POST` rather than SSE: there is nothing to stream. A diffusion model returns one
 * image at the end of its run, so a streaming transport would add framing for a single payload and
 * give a visitor no earlier feedback than a spinner already does.
 *
 * The image comes back base64-encoded in the JSON response rather than from a follow-up URL. A URL
 * would require the bytes to be stored somewhere between the two requests, and this panel
 * deliberately keeps generated media transient — no R2 bucket, no retention policy, no cleanup step
 * at teardown.
 */
export const createImageRouter = new Hono<AppBindings>();

createImageRouter.use(jsonBodyLimit(CREATE_IMAGE_BODY_LIMIT_BYTES));

/**
 * Generates one image and returns it with its run receipt.
 *
 * Every failure is an ordinary RFC 9457 problem-details response. Unlike Chat there is no partially
 * delivered response to worry about: nothing is sent until the image has been produced and
 * verified, so a real status code is always still available.
 *
 * @param context Hono request context, carrying the verified Access identity and the request-scoped
 *   Create Image service.
 * @returns A JSON `200` carrying {@link CreateImageResponse}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is malformed, carries an
 *   identity field, names an unknown model, or supplies a control the selected model does not
 *   support; `502` when the provider fails or returns something that is not a renderable image.
 */
createImageRouter.post('/', async (context) => {
  const request = validateCreateImageRequest(await readJsonBody(context.req.raw));

  const identity = currentIdentity(context);
  // Assembled from the verified JWT claims alone. There is no code path by which a body or header
  // value could reach it, which is why the domain rejects a body that carries one rather than
  // relying on a filter.
  const actor = { email: identity.email, sub: identity.sub };

  const logger = context.var.LOGGER;

  try {
    const result = await context.var.CREATE_IMAGE_SERVICE.generate(request, actor);

    // Deliberately free of the prompt, the image, and the user's email. The email is recorded in AI
    // Gateway metadata and nowhere else; a structured log is a different retention domain with
    // different access control. The byte length and media type are safe and genuinely useful when
    // diagnosing a provider that changed its output shape.
    logger.info('create_image_run_completed', {
      runId: result.receipt.runId,
      model: result.receipt.model,
      elapsedMs: result.receipt.elapsedMs,
      costStatus: result.receipt.costStatus,
      logCount: result.receipt.logIds.length,
      mediaType: result.image.mediaType,
      byteLength: result.image.byteLength
    });

    const response: CreateImageResponse = {
      image: result.image,
      receipt: result.receipt,
      applied: result.applied
    };
    return context.json(response);
  } catch (cause) {
    logger.warn('create_image_run_failed', {
      runId: request.runId,
      model: request.model.id
    });
    throw cause;
  }
});
