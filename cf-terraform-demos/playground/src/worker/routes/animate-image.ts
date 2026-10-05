/**
 * @file Animate Image's endpoints, mounted at `/api/animate-image`. Four routes rather than one,
 *   for the same reason Create Video has four: a job is not a value — it is started, polled,
 *   played, and cancelled. All four sit under the same `/api` prefix the Access policies already
 *   cover, so none needs a policy of its own. These are **separate routes from Create Video's
 *   rather than a mode parameter on them**, which is the API-tier half of the panel's defining
 *   decision. A visitor arriving with a picture gets a panel, a URL, and an endpoint named for what
 *   they are doing. The shared part is everything underneath: the job machinery, the bucket, and
 *   the ownership derivation.
 */

import { Hono } from 'hono';
import { notFound } from '@adrianhall/cloudflare-toolkit/errors';
import { currentIdentity, jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import {
  MAX_ANIMATE_SOURCE_BYTES,
  type AnimateImageAcceptedResponse,
  type AnimateImageStatusResponse
} from '../../shared/animate-image';
import type { AppBindings } from '../bindings';
import {
  estimateAnimateCost,
  validateAnimateImageRequest,
  type ValidatedAnimateImageRequest
} from '../domain/animate-image';
import { isPlausibleRunId } from '../domain/chat';

/**
 * Largest Animate Image request body accepted.
 *
 * Unlike Create Video's, this body carries media going _in_, so the limit is derived from the
 * panel's source-image ceiling rather than from a prompt length. Base64 expands bytes by four
 * thirds; the extra allowance covers the JSON envelope, the motion prompt, and the controls. A body
 * shaped like something else entirely is refused by the transport before validation sees it.
 */
export const ANIMATE_IMAGE_BODY_LIMIT_BYTES = Math.ceil(MAX_ANIMATE_SOURCE_BYTES * (4 / 3)) + 8_192;

/**
 * Animate Image's router.
 */
export const animateImageRouter = new Hono<AppBindings>();

animateImageRouter.use(jsonBodyLimit(ANIMATE_IMAGE_BODY_LIMIT_BYTES));

/**
 * Summarises a validated request for a structured log.
 *
 * Describes the shape and the controls, never the motion prompt and never the picture. The prompt's
 * _length_ distinguishes a real request from an empty one without retaining what the visitor asked
 * for, and the source facts are byte-derived rather than visitor-supplied — a media type and a
 * pixel count describe nothing about the image's content.
 *
 * @param request The validated request.
 * @returns Structured fields describing the attempt.
 */
function describeAttempt(request: ValidatedAnimateImageRequest): Record<string, unknown> {
  const estimate = estimateAnimateCost(request);

  return {
    model: request.model.id,
    contractVersion: request.model.contractVersion,
    motionPromptCharacters: request.motionPrompt?.length ?? 0,
    resolution: request.resolution,
    duration: request.duration,
    sourceMediaType: request.source.facts.mediaType,
    sourceByteLength: request.source.facts.byteLength,
    sourceWidth: request.source.facts.width,
    sourceHeight: request.source.facts.height,
    // Logged because it is the number a visitor was quoted before spending. A run whose reported
    // cost diverges sharply from its estimate is worth noticing, and that comparison is impossible
    // if the estimate was never recorded.
    estimatedCostUsd: estimate.costUsd,
    // Recorded separately so a zero estimate is not read as a free run. For a combination the
    // provider has not published, this is `false` and the zero means "unknown".
    estimateKnown: estimate.known,
    hasNegativePrompt: request.negativePrompt !== undefined,
    ...(request.seed === undefined ? {} : { seed: request.seed })
  };
}

/**
 * Starts animating a picture.
 *
 * Answers `202` rather than `200`: the request succeeded, the work has not. The browser polls the
 * status route from here.
 *
 * @param context Hono request context, carrying the verified Access identity and the request-scoped
 *   Animate Image service.
 * @returns A JSON `202` carrying {@link AnimateImageAcceptedResponse}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is malformed, carries an
 *   identity, job-naming, or image-location field, names an unknown or wrong-panel model, omits or
 *   oversizes the picture, omits a motion prompt the model requires, or sets an unsupported or
 *   out-of-range control, and when the body exceeds {@link ANIMATE_IMAGE_BODY_LIMIT_BYTES}; `409`
 *   when a job already exists for this run identifier.
 */
animateImageRouter.post('/', async (context) => {
  const body = (await readJsonBody(context.req.raw)) as Record<string, unknown>;
  const request = validateAnimateImageRequest(body);

  const identity = currentIdentity(context);
  // Assembled from the verified JWT claims alone. There is no code path by which a body or header
  // value could reach it, which is why the domain rejects a body carrying one.
  const actor = { email: identity.email, sub: identity.sub };

  const logger = context.var.LOGGER;

  // Logged before the job starts, so a request that fails inside the platform still leaves a record
  // of what it attempted — including what it was expected to cost.
  logger.info('animate_image_run_started', {
    runId: request.runId,
    ...describeAttempt(request)
  });

  try {
    const accepted = await context.var.ANIMATE_IMAGE_SERVICE.accept(request, body, actor);

    const response: AnimateImageAcceptedResponse = {
      runId: accepted.runId,
      state: accepted.state,
      applied: accepted.applied
    };
    return context.json(response, 202);
  } catch (cause) {
    logger.warn('animate_image_run_failed', {
      runId: request.runId,
      ...describeAttempt(request)
    });
    throw cause;
  }
});

/**
 * Reports the status of one job.
 *
 * @param context Hono request context.
 * @returns A JSON `200` carrying {@link AnimateImageStatusResponse}.
 * @throws {ProblemDetailsError} `notFound()` (404) when the run identifier is implausible, or when
 *   no job exists for this identity and run identifier — which is also the answer when the job
 *   belongs to someone else, deliberately, since confirming its existence would itself be a
 *   disclosure.
 */
animateImageRouter.get('/:runId/status', async (context) => {
  const runId = context.req.param('runId');
  if (!isPlausibleRunId(runId)) {
    throw notFound({ detail: 'No such animation job.' });
  }

  const identity = currentIdentity(context);

  // Wrapped and logged before rethrowing. The status route is polled rather than submitted, so a
  // throw here surfaces as a bare `500` in a browser's network tab with nothing tying it to a
  // cause. Catching, recording, and rethrowing keeps the response behaviour identical while making
  // the failure attributable to this run.
  let status;
  try {
    status = await context.var.ANIMATE_IMAGE_SERVICE.status(runId, {
      email: identity.email,
      sub: identity.sub
    });
  } catch (cause) {
    context.var.LOGGER.error('animate_image_status_failed', {
      runId,
      errorName: cause instanceof Error ? cause.name : typeof cause,
      errorMessage: cause instanceof Error ? cause.message : String(cause),
      stack: cause instanceof Error ? cause.stack : undefined,
      cause:
        cause instanceof Error && cause.cause instanceof Error
          ? `${cause.cause.name}: ${cause.cause.message}`
          : undefined
    });
    throw cause;
  }

  if (status === undefined) {
    throw notFound({ detail: 'No such animation job.' });
  }

  // Logged at `info` so a poll's own outcome is visible in sequence. A job that reports `failed`
  // with a reason, and a job whose poll threw, are indistinguishable in an access log.
  context.var.LOGGER.info('animate_image_status_reported', {
    runId,
    state: status.state,
    ...(status.reason === undefined ? {} : { reason: status.reason })
  });

  const response: AnimateImageStatusResponse = {
    runId: status.runId,
    state: status.state,
    ...(status.video === undefined ? {} : { video: status.video }),
    ...(status.receipt === undefined ? {} : { receipt: status.receipt }),
    ...(status.applied === undefined ? {} : { applied: status.applied }),
    ...(status.reason === undefined ? {} : { reason: status.reason })
  };
  return context.json(response);
});

/**
 * Serves a generated video, supporting ranged reads.
 *
 * Range support is why the video is in storage at all: a `<video>` element seeks by asking for byte
 * ranges, and a base64 payload in a JSON body cannot answer one. The response advertises
 * `Accept-Ranges` so a browser knows it may.
 *
 * @param context Hono request context.
 * @returns A `200` with the whole video, or a `206` with the requested range.
 * @throws {ProblemDetailsError} `notFound()` (404) when no video exists for this identity and run
 *   identifier; `502` when the stored bytes are not a playable video.
 */
animateImageRouter.get('/:runId/video', async (context) => {
  const runId = context.req.param('runId');
  if (!isPlausibleRunId(runId)) {
    throw notFound({ detail: 'No such video.' });
  }

  const identity = currentIdentity(context);
  const actor = { email: identity.email, sub: identity.sub };

  const requested = parseRangeHeader(context.req.header('range'));
  const video = await context.var.ANIMATE_IMAGE_SERVICE.read(
    runId,
    actor,
    requested === undefined ? undefined : requested
  );

  if (video === undefined) {
    throw notFound({ detail: 'No such video.' });
  }

  const headers = new Headers({
    // The sniffed type, never a provider's declared one. This is the header that decides how the
    // browser treats bytes served from this demo's own authenticated origin.
    'content-type': video.mediaType,
    'content-length': String(video.rangeLength),
    'accept-ranges': 'bytes',
    // A generated video is private to one visitor and served from a derived key, so it must not be
    // held in a shared cache.
    'cache-control': 'private, no-store',
    // Defence in depth: even though the type is sniffed, telling the browser not to second-guess it
    // removes the remaining room for interpretation.
    'x-content-type-options': 'nosniff'
  });

  if (requested !== undefined) {
    headers.set(
      'content-range',
      `bytes ${video.rangeOffset}-${video.rangeOffset + video.rangeLength - 1}/${video.byteLength}`
    );
    return new Response(video.body, { status: 206, headers });
  }

  return new Response(video.body, { status: 200, headers });
});

/**
 * Cancels a job and deletes anything it stored.
 *
 * @param context Hono request context.
 * @returns A JSON `200` reporting the cancelled state.
 * @throws {ProblemDetailsError} `notFound()` (404) when no job exists for this identity and run
 *   identifier.
 */
animateImageRouter.post('/:runId/cancel', async (context) => {
  const runId = context.req.param('runId');
  if (!isPlausibleRunId(runId)) {
    throw notFound({ detail: 'No such animation job.' });
  }

  const identity = currentIdentity(context);
  const cancelled = await context.var.ANIMATE_IMAGE_SERVICE.cancel(runId, {
    email: identity.email,
    sub: identity.sub
  });

  if (!cancelled) {
    throw notFound({ detail: 'No such animation job.' });
  }

  context.var.LOGGER.info('animate_image_run_cancelled', { runId });

  const response: AnimateImageStatusResponse = { runId, state: 'cancelled' };
  return context.json(response);
});

/**
 * Parses a single-range `Range` header.
 *
 * Deliberately narrow: one range, bytes only. A multi-range request would require a multipart
 * response, which no `<video>` element asks for, and answering a request we did not understand with
 * the whole file is the honest fallback — a browser treats a `200` as "ranges not supported" and
 * copes.
 *
 * @param header The raw header value, when present.
 * @returns The requested range, or `undefined` when there is none or it is not a form this demo
 *   serves.
 */
function parseRangeHeader(header: string | undefined): VideoByteRangeRequest | undefined {
  if (header === undefined) {
    return undefined;
  }

  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null) {
    return undefined;
  }

  const [, rawStart, rawEnd] = match;
  const hasStart = rawStart !== undefined && rawStart !== '';
  const hasEnd = rawEnd !== undefined && rawEnd !== '';

  // A suffix range (`bytes=-500`) asks for the last N bytes. R2 expresses that as a suffix rather
  // than an offset, and the only consumer here is a browser probing for duration metadata, so it is
  // served as "from this offset to the end" only when a start was given.
  if (!hasStart) {
    return undefined;
  }

  const offset = Number(rawStart);
  if (!Number.isFinite(offset) || offset < 0) {
    return undefined;
  }

  if (!hasEnd) {
    return { offset };
  }

  const end = Number(rawEnd);
  if (!Number.isFinite(end) || end < offset) {
    return undefined;
  }

  return { offset, length: end - offset + 1 };
}

/**
 * A byte range parsed from a request header.
 */
interface VideoByteRangeRequest {
  /**
   * First byte requested, inclusive.
   */
  offset: number;
  /**
   * How many bytes were requested, when the header gave an end.
   */
  length?: number;
}
