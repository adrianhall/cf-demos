import { Hono } from 'hono';
import { currentIdentity, jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import type { DescribeImageResponse } from '../../shared/describe-image';
import { MAX_INPUT_IMAGE_BYTES } from '../../shared/describe-image';
import type { AppBindings } from '../bindings';
import {
  validateDescribeImageRequest,
  type ValidatedDescribeImageRequest
} from '../domain/describe-image';

/**
 * Largest Describe Image request body accepted.
 *
 * This panel reverses Create Image's traffic pattern: the request carries the megabytes and the
 * response is a paragraph. The limit is therefore the image budget plus the base64 inflation of
 * about a third, plus a small allowance for the question and the JSON envelope around it.
 *
 * It is deliberately derived from {@link MAX_INPUT_IMAGE_BYTES} rather than written as its own
 * number. Two independent limits would drift, and the failure when they did would be confusing: a
 * picture the panel says it accepts, refused by the transport before validation ever sees it.
 */
export const DESCRIBE_IMAGE_BODY_LIMIT_BYTES = Math.ceil(MAX_INPUT_IMAGE_BYTES * 1.4) + 8_192;

/**
 * Describe Image's endpoint, mounted at `/api/describe-image`.
 *
 * A plain JSON `POST`, like Create Image. Both reviewed models can stream their answer, but the
 * answer is a short paragraph about a picture already on screen, so streaming would add framing for
 * very little perceived gain.
 */
export const describeImageRouter = new Hono<AppBindings>();

describeImageRouter.use(jsonBodyLimit(DESCRIBE_IMAGE_BODY_LIMIT_BYTES));

/**
 * Summarises a validated request for a structured log.
 *
 * Describes the picture and the shape of the question, never their content. The dimensions, byte
 * count, and format are the fields that make a failed attempt reproducible — an oversized or
 * unusual picture is the most likely cause of a vision model failing — and none of them reveals
 * what the picture shows.
 *
 * @param request The validated request.
 * @returns Structured fields describing the attempt.
 */
function describeAttempt(request: ValidatedDescribeImageRequest): Record<string, unknown> {
  return {
    model: request.model.id,
    contractVersion: request.model.contractVersion,
    mediaType: request.imageFacts.mediaType,
    imageByteLength: request.imageFacts.byteLength,
    imageWidth: request.imageFacts.width,
    imageHeight: request.imageFacts.height,
    // Length rather than text: the question is the visitor's content, and the length still
    // separates a real question from an absent one.
    instructionLength: request.instruction === undefined ? 0 : [...request.instruction].length,
    // Which of the two contract styles this request used. When a model that requires a question
    // starts failing, this distinguishes "asked nothing" from "asked something".
    hasInstruction: request.instruction !== undefined,
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens })
  };
}

/**
 * Describes one picture and returns the answer with its run receipt.
 *
 * @param context Hono request context, carrying the verified Access identity and the request-scoped
 *   Describe Image service.
 * @returns A JSON `200` carrying {@link DescribeImageResponse}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is malformed, carries an
 *   identity or self-described image field, names an unknown model, omits a question a model
 *   requires, or supplies a picture that is undecodable, oversized, or an unsupported format, and
 *   when the body exceeds {@link DESCRIBE_IMAGE_BODY_LIMIT_BYTES} — the shared `jsonBodyLimit`
 *   reports an oversized body as a bad request, which every panel in this demo does alike; `502`
 *   when the provider fails or returns no usable description.
 */
describeImageRouter.post('/', async (context) => {
  const request = validateDescribeImageRequest(await readJsonBody(context.req.raw));

  const identity = currentIdentity(context);
  // Assembled from the verified JWT claims alone. There is no code path by which a body or header
  // value could reach it, which is why the domain rejects a body that carries one rather than
  // relying on a filter.
  const actor = { email: identity.email, sub: identity.sub };

  const logger = context.var.LOGGER;

  // Logged before the model is called. A request that fails inside the provider, times out, or is
  // cancelled mid-flight would otherwise leave no record of what was attempted — and for this
  // panel the picture's size and format are the most likely explanation for such a failure.
  logger.info('describe_image_run_started', {
    runId: request.runId,
    ...describeAttempt(request)
  });

  try {
    const result = await context.var.DESCRIBE_IMAGE_SERVICE.describe(request, actor);

    // Free of the question, the description, and the user's email. The description's length is
    // recorded because a model that answers with one word is failing in a way a `200` hides.
    logger.info('describe_image_run_completed', {
      runId: result.receipt.runId,
      model: result.receipt.model,
      elapsedMs: result.receipt.elapsedMs,
      costStatus: result.receipt.costStatus,
      logCount: result.receipt.logIds.length,
      descriptionLength: [...result.description].length
    });

    const response: DescribeImageResponse = {
      description: result.description,
      image: result.image,
      receipt: result.receipt,
      applied: result.applied
    };
    return context.json(response);
  } catch (cause) {
    // The inference client has already logged the provider's own message against this same run
    // identifier. This line records the panel-level outcome and repeats the picture's details, so
    // one search for the run identifier returns the whole story.
    logger.warn('describe_image_run_failed', {
      runId: request.runId,
      ...describeAttempt(request)
    });
    throw cause;
  }
});
