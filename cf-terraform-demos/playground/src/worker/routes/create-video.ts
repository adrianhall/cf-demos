/**
 * @file Create Video's endpoints, mounted at `/api/create-video`. Four routes rather than one,
 *   because a job is not a value: it is started, polled, played, and cancelled. All four sit under
 *   the same `/api` prefix the Access policies already cover, so none needs a policy of its own.
 *   The video route is the only one in this demo that answers with media rather than JSON, and it
 *   is authenticated like every other: a visitor's generated video is served from this origin,
 *   behind Access, from a key derived from their own identity.
 */

import { Hono } from 'hono';
import { notFound } from '@adrianhall/cloudflare-toolkit/errors';
import { currentIdentity, jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import type {
  CreateVideoAcceptedResponse,
  CreateVideoStatusResponse
} from '../../shared/create-video';
import type { AppBindings } from '../bindings';
import { isPlausibleRunId } from '../domain/chat';
import {
  estimateVideoCostUsd,
  validateCreateVideoRequest,
  type ValidatedCreateVideoRequest
} from '../domain/create-video';

/**
 * Largest Create Video request body accepted.
 *
 * Small, because the body is a prompt and a handful of controls — there is no media going _in_. The
 * prompt cap plus a generous envelope allowance covers it, and an 8 KiB-ish limit means a body
 * shaped like an image upload is refused by the transport before validation sees it.
 */
export const CREATE_VIDEO_BODY_LIMIT_BYTES = 16 * 1_024;

/**
 * Create Video's router.
 */
export const createVideoRouter = new Hono<AppBindings>();

createVideoRouter.use(jsonBodyLimit(CREATE_VIDEO_BODY_LIMIT_BYTES));

/**
 * Summarises a validated request for a structured log.
 *
 * Describes the shape and the controls, never the prompt. The prompt's _length_ distinguishes a
 * real request from an empty one without retaining what the visitor asked for, and the controls are
 * what make a failed attempt reproducible — and what explain its cost.
 *
 * @param request The validated request.
 * @returns Structured fields describing the attempt.
 */
function describeAttempt(request: ValidatedCreateVideoRequest): Record<string, unknown> {
  return {
    model: request.model.id,
    contractVersion: request.model.contractVersion,
    promptCharacters: request.prompt.length,
    resolution: request.resolution,
    aspectRatio: request.aspectRatio,
    duration: request.duration,
    // Logged because it is the number a visitor was quoted before spending. A run whose reported
    // cost diverges sharply from its estimate is worth noticing, and that comparison is impossible
    // if the estimate was never recorded.
    estimatedCostUsd: estimateVideoCostUsd(request),
    hasNegativePrompt: request.negativePrompt !== undefined,
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    ...(request.generateAudio === undefined ? {} : { generateAudio: request.generateAudio })
  };
}

/**
 * Starts generating a video.
 *
 * Answers `202` rather than `200`: the request succeeded, the work has not. The browser polls the
 * status route from here.
 *
 * @param context Hono request context, carrying the verified Access identity and the request-scoped
 *   Create Video service.
 * @returns A JSON `202` carrying {@link CreateVideoAcceptedResponse}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is malformed, carries an
 *   identity or job-naming field, names an unknown or wrong-panel model, omits or oversizes the
 *   prompt, or sets an unsupported or out-of-range control, and when the body exceeds
 *   {@link CREATE_VIDEO_BODY_LIMIT_BYTES}; `409` when a job already exists for this run
 *   identifier.
 */
createVideoRouter.post('/', async (context) => {
  const body = (await readJsonBody(context.req.raw)) as Record<string, unknown>;
  const request = validateCreateVideoRequest(body);

  const identity = currentIdentity(context);
  // Assembled from the verified JWT claims alone. There is no code path by which a body or header
  // value could reach it, which is why the domain rejects a body carrying one.
  const actor = { email: identity.email, sub: identity.sub };

  const logger = context.var.LOGGER;

  // Logged before the job starts, so a request that fails inside the platform still leaves a record
  // of what it attempted — including what it was expected to cost.
  logger.info('create_video_run_started', {
    runId: request.runId,
    ...describeAttempt(request)
  });

  try {
    const accepted = await context.var.CREATE_VIDEO_SERVICE.accept(request, body, actor);

    const response: CreateVideoAcceptedResponse = {
      runId: accepted.runId,
      state: accepted.state,
      applied: accepted.applied
    };
    return context.json(response, 202);
  } catch (cause) {
    logger.warn('create_video_run_failed', {
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
 * @returns A JSON `200` carrying {@link CreateVideoStatusResponse}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the run identifier is implausible;
 *   `notFound()` (404) when no job exists for this identity and run identifier — which is also the
 *   answer when the job belongs to someone else, deliberately, since confirming its existence would
 *   itself be a disclosure.
 */
createVideoRouter.get('/:runId/status', async (context) => {
  const runId = context.req.param('runId');
  if (!isPlausibleRunId(runId)) {
    throw notFound({ detail: 'No such video job.' });
  }

  const identity = currentIdentity(context);

  // Wrapped and logged before rethrowing. The status route is polled rather than submitted, so a
  // throw here surfaces as a bare `500` in a browser's network tab with nothing tying it to a
  // cause. Catching, recording, and rethrowing keeps the response behaviour identical while making
  // the failure attributable to this run.
  let status;
  try {
    status = await context.var.CREATE_VIDEO_SERVICE.status(runId, {
      email: identity.email,
      sub: identity.sub
    });
  } catch (cause) {
    context.var.LOGGER.error('create_video_status_failed', {
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
    throw notFound({ detail: 'No such video job.' });
  }

  // Logged at `info` so a poll's own outcome is visible in sequence. A job that reports `failed`
  // with a reason, and a job whose poll threw, are indistinguishable in an access log — both are
  // just a request — so the distinction has to be recorded here.
  context.var.LOGGER.info('create_video_status_reported', {
    runId,
    state: status.state,
    ...(status.reason === undefined ? {} : { reason: status.reason })
  });

  const response: CreateVideoStatusResponse = {
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
createVideoRouter.get('/:runId/video', async (context) => {
  const runId = context.req.param('runId');
  if (!isPlausibleRunId(runId)) {
    throw notFound({ detail: 'No such video.' });
  }

  const identity = currentIdentity(context);
  const actor = { email: identity.email, sub: identity.sub };

  const requested = parseRangeHeader(context.req.header('range'));
  const video = await context.var.CREATE_VIDEO_SERVICE.read(
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
createVideoRouter.post('/:runId/cancel', async (context) => {
  const runId = context.req.param('runId');
  if (!isPlausibleRunId(runId)) {
    throw notFound({ detail: 'No such video job.' });
  }

  const identity = currentIdentity(context);
  const cancelled = await context.var.CREATE_VIDEO_SERVICE.cancel(runId, {
    email: identity.email,
    sub: identity.sub
  });

  if (!cancelled) {
    throw notFound({ detail: 'No such video job.' });
  }

  context.var.LOGGER.info('create_video_run_cancelled', { runId });

  const response: CreateVideoStatusResponse = { runId, state: 'cancelled' };
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

  if (!hasStart && !hasEnd) {
    return undefined;
  }

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
