import { Hono } from 'hono';
import { currentIdentity, jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import type { ClassifyImageResponse } from '../../shared/classify-image';
import { MAX_INPUT_IMAGE_BYTES } from '../../shared/describe-image';
import type { AppBindings } from '../bindings';
import {
  validateClassifyImageRequest,
  type ValidatedClassifyImageRequest
} from '../domain/classify-image';

/**
 * Largest Classify Image request body accepted.
 *
 * Derived from {@link MAX_INPUT_IMAGE_BYTES} plus base64's one-third inflation and a small envelope
 * allowance, exactly as Describe Image's limit is. Two independently written numbers would drift,
 * and the failure when they did would be confusing: a picture the panel says it accepts, refused by
 * the transport before validation ever sees it.
 *
 * The allowance is smaller than Describe Image's because this panel has no instruction field — the
 * whole body is the picture and two numbers.
 */
export const CLASSIFY_IMAGE_BODY_LIMIT_BYTES = Math.ceil(MAX_INPUT_IMAGE_BYTES * 1.4) + 4_096;

/**
 * Classify Image's endpoint, mounted at `/api/classify-image`.
 *
 * A plain JSON `POST`. The classifier is synchronous and its answer is a short list, so there is
 * nothing to stream.
 */
export const classifyImageRouter = new Hono<AppBindings>();

classifyImageRouter.use(jsonBodyLimit(CLASSIFY_IMAGE_BODY_LIMIT_BYTES));

/**
 * Summarises a validated request for a structured log.
 *
 * Describes the picture and the controls, never the picture itself. The dimensions, byte count, and
 * format are what make a failed attempt reproducible, and none of them reveals what the picture
 * shows.
 *
 * @param request The validated request.
 * @returns Structured fields describing the attempt.
 */
function describeAttempt(request: ValidatedClassifyImageRequest): Record<string, unknown> {
  return {
    model: request.model.id,
    contractVersion: request.model.contractVersion,
    mediaType: request.source.facts.mediaType,
    imageByteLength: request.source.facts.byteLength,
    imageWidth: request.source.facts.width,
    imageHeight: request.source.facts.height,
    // The controls as the caller set them, so a run whose result looks surprisingly short can be
    // explained without guessing. Named rather than counted, because which control was set is the
    // diagnostic — a request with a high floor and one with a low top-k fail differently.
    requestedControls: [
      ...(request.topK === undefined ? [] : ['topK']),
      ...(request.minimumConfidence === undefined ? [] : ['minimumConfidence'])
    ],
    ...(request.topK === undefined ? {} : { topK: request.topK }),
    ...(request.minimumConfidence === undefined
      ? {}
      : { minimumConfidence: request.minimumConfidence })
  };
}

/**
 * Classifies one picture and returns the ranked labels with their run receipt.
 *
 * @param context Hono request context, carrying the verified Access identity and the request-scoped
 *   Classify Image service.
 * @returns A JSON `200` carrying {@link ClassifyImageResponse}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is malformed, carries an
 *   identity, self-described image, or generative field, names an unknown model, sets an
 *   unsupported or out-of-range control, or supplies a picture that is undecodable, oversized, or
 *   an unsupported format, and when the body exceeds {@link CLASSIFY_IMAGE_BODY_LIMIT_BYTES} — the
 *   shared `jsonBodyLimit` reports an oversized body as a bad request, which every panel in this
 *   demo does alike; `502` when the provider fails or returns no usable labels.
 */
classifyImageRouter.post('/', async (context) => {
  const request = validateClassifyImageRequest(await readJsonBody(context.req.raw));

  const identity = currentIdentity(context);
  // Assembled from the verified JWT claims alone. There is no code path by which a body or header
  // value could reach it, which is why the domain rejects a body that carries one rather than
  // relying on a filter.
  const actor = { email: identity.email, sub: identity.sub };

  const logger = context.var.LOGGER;

  // Logged before the model is called, so a request that fails inside the provider or is cancelled
  // mid-flight still leaves a record of what was attempted.
  logger.info('classify_image_run_started', {
    runId: request.runId,
    ...describeAttempt(request)
  });

  try {
    const result = await context.var.CLASSIFY_IMAGE_SERVICE.classify(request, actor);

    // Counts rather than labels. How many the model returned against how many survived is what
    // explains a short result list; the label text is model output about the visitor's picture and
    // stays out of the log.
    logger.info('classify_image_run_completed', {
      runId: result.receipt.runId,
      model: result.receipt.model,
      elapsedMs: result.receipt.elapsedMs,
      costStatus: result.receipt.costStatus,
      logCount: result.receipt.logIds.length,
      returnedLabels: result.totalLabels,
      shownLabels: result.labels.length
    });

    const response: ClassifyImageResponse = {
      labels: result.labels,
      totalLabels: result.totalLabels,
      image: result.image,
      receipt: result.receipt,
      applied: result.applied
    };
    return context.json(response);
  } catch (cause) {
    // The inference client has already logged the provider's own message against this same run
    // identifier. This line records the panel-level outcome and repeats the picture's details, so
    // one search for the run identifier returns the whole story.
    logger.warn('classify_image_run_failed', {
      runId: request.runId,
      ...describeAttempt(request)
    });
    throw cause;
  }
});
