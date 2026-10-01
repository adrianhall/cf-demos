import { Hono } from 'hono';
import { currentIdentity, jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import type { CreateImageResponse } from '../../images';
import type { AppBindings } from '../bindings';
import {
  validateCreateImageRequest,
  type ValidatedCreateImageRequest
} from '../domain/create-image';

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
 * Summarises which controls a validated request actually asked for.
 *
 * Only the controls that were supplied appear, so a log line reads as the decisions the visitor
 * made rather than a fixed set of fields padded with nulls. Every value here is a bounded number
 * the visitor chose, which is what makes a failed attempt reproducible.
 *
 * @param request The validated request.
 * @returns Structured fields naming the requested controls and their values.
 */
function describeRequestedControls(request: ValidatedCreateImageRequest): Record<string, unknown> {
  const requested: Record<string, number> = {};

  if (request.width !== undefined) {
    requested['width'] = request.width;
  }
  if (request.height !== undefined) {
    requested['height'] = request.height;
  }
  if (request.steps !== undefined) {
    requested['steps'] = request.steps;
  }
  if (request.guidance !== undefined) {
    requested['guidance'] = request.guidance;
  }
  if (request.seed !== undefined) {
    requested['seed'] = request.seed;
  }

  return {
    requestedControls: Object.keys(requested),
    requested,
    hasNegativePrompt: request.negativePrompt !== undefined
  };
}

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

  // Logged before the model is called, not only after. A request that fails inside the provider, or
  // times out, or is cancelled mid-flight would otherwise leave no record of having been attempted
  // — which is precisely the case where knowing what was asked for matters most. With this line,
  // two POSTs that look identical in an access log are distinguishable by their run identifier and
  // their settings.
  //
  // The prompt's length is recorded rather than its text: the text is the visitor's content, and
  // the length still distinguishes an empty-looking request from a real one.
  logger.info('create_image_run_started', {
    runId: request.runId,
    model: request.model.id,
    contractVersion: request.model.contractVersion,
    promptLength: [...request.prompt].length,
    negativePromptLength:
      request.negativePrompt === undefined ? 0 : [...request.negativePrompt].length,
    ...describeRequestedControls(request)
  });

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
    // The inference client has already logged the provider's own message against this same run
    // identifier. This line records the panel-level outcome and repeats the settings, so one search
    // for the run identifier returns both halves of the story.
    logger.warn('create_image_run_failed', {
      runId: request.runId,
      model: request.model.id,
      ...describeRequestedControls(request)
    });
    throw cause;
  }
});
