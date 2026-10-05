/**
 * @file Generate Music's endpoint, mounted at `/api/generate-music`. One route rather than four,
 *   which is the visible consequence of the phase decision recorded in the service: neither
 *   reviewed model has a job API, so there is nothing to poll, nothing stored to serve, and nothing
 *   running to cancel server-side. A plain JSON `POST` like Read Text, not the four-route job
 *   surface Create Video needs. The response carries the audio base64-encoded rather than a URL.
 *   The provider returned a short-lived URL on its own CDN; this Worker fetched it once, from an
 *   allowlisted host, and verified the bytes — so what reaches the browser is audio this demo has
 *   actually looked at, from this demo's own origin, with no third-party request made from the
 *   visitor's browser.
 */

import { Hono } from 'hono';
import { currentIdentity, jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import type { GenerateMusicResponse } from '../../shared/generate-music';
import { classifyMusicFailure } from '../application/generate-music/generate-music-service';
import type { AppBindings } from '../bindings';
import {
  estimateMusicCostForRequest,
  musicLyricsSource,
  validateGenerateMusicRequest,
  type ValidatedGenerateMusicRequest
} from '../domain/generate-music';

/**
 * Largest Generate Music request body accepted.
 *
 * Driven by the two text fields rather than by any binary payload: a 2,000-character prompt and
 * 3,500 characters of lyrics, both of which may be four UTF-8 bytes per character in some scripts,
 * plus the surrounding JSON. 32 KiB holds the worst case with room to spare and invites nothing
 * larger — a body shaped like a media upload is refused by the transport before validation sees
 * it.
 *
 * Note which direction the volume travels here: a small request produces a response of several
 * megabytes. The response is bounded separately, by `MAX_MUSIC_BYTES`, inside the retrieval
 * client.
 */
export const GENERATE_MUSIC_BODY_LIMIT_BYTES = 32 * 1_024;

/**
 * Generate Music's router.
 */
export const generateMusicRouter = new Hono<AppBindings>();

generateMusicRouter.use(jsonBodyLimit(GENERATE_MUSIC_BODY_LIMIT_BYTES));

/**
 * Summarises a validated request for a structured log.
 *
 * Describes the shape and the controls, never the prompt and never the lyrics. Both are the
 * visitor's content; their _lengths_ distinguish a real request from an empty one without retaining
 * what was written, and the controls are what make a failed attempt reproducible.
 *
 * The cost estimate and its unit are logged together and deliberately. A run whose reported cost
 * diverges sharply from its estimate is worth noticing, and that comparison is impossible if the
 * estimate was never recorded — but a bare number would be ambiguous on this panel, where one model
 * charges per second and the other per track.
 *
 * @param request The validated request.
 * @returns Structured fields describing the attempt.
 */
function describeAttempt(request: ValidatedGenerateMusicRequest): Record<string, unknown> {
  return {
    model: request.model.id,
    contractVersion: request.model.contractVersion,
    promptCharacters: [...request.prompt].length,
    instrumental: request.instrumental,
    lyricsSource: musicLyricsSource(request),
    lyricsCharacters: request.lyrics === undefined ? 0 : [...request.lyrics].length,
    generateLyrics: request.generateLyrics,
    format: request.format,
    ...(request.lengthSeconds === undefined ? {} : { lengthSeconds: request.lengthSeconds }),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    pricingUnit: request.controls.pricing.unit,
    estimatedCostUsd: estimateMusicCostForRequest(request)
  };
}

/**
 * Generates one track and returns it with its run receipt.
 *
 * Every failure is an ordinary RFC 9457 problem-details response. As with Read Text there is no
 * partially delivered response to worry about: nothing is sent until the audio has been retrieved
 * and verified, so a real status code is always still available.
 *
 * @param context Hono request context, carrying the verified Access identity and the request-scoped
 *   Generate Music service.
 * @returns A JSON `200` carrying {@link GenerateMusicResponse}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is malformed, carries an
 *   identity or output-describing field, names an unknown or wrong-panel model, omits or oversizes
 *   the prompt, or sets a control the selected model does not support — including the lyrics
 *   combinations the reviewed models refuse; `503` when the account has insufficient prepaid AI
 *   Gateway credit, which is the expected outcome on an unfunded account because every reviewed
 *   music model is third-party; `502` when the provider fails, returns no usable audio location, or
 *   returns bytes that are not audio this panel will play.
 */
generateMusicRouter.post('/', async (context) => {
  const request = validateGenerateMusicRequest(await readJsonBody(context.req.raw));

  const identity = currentIdentity(context);
  // Assembled from the verified JWT claims alone. There is no code path by which a body or header
  // value could reach it, which is why the domain rejects a body that carries one rather than
  // relying on a filter.
  const actor = { email: identity.email, sub: identity.sub };

  const logger = context.var.LOGGER;

  // Logged before the model is called, not only after. A request that fails inside the provider, or
  // times out, or is cancelled mid-flight would otherwise leave no record of having been attempted —
  // which is precisely the case where knowing what was asked for, and what it was expected to cost,
  // matters most.
  logger.info('generate_music_run_started', {
    runId: request.runId,
    ...describeAttempt(request)
  });

  try {
    const result = await context.var.GENERATE_MUSIC_SERVICE.generate(request, actor);

    // Deliberately free of the prompt, the lyrics, the audio, and the user's email. The email is
    // recorded in AI Gateway metadata and nowhere else; a structured log is a different retention
    // domain with different access control. The media type, size, and source host are safe and
    // genuinely useful when diagnosing a provider that changed its output shape or its CDN.
    logger.info('generate_music_run_completed', {
      runId: result.receipt.runId,
      model: result.receipt.model,
      elapsedMs: result.receipt.elapsedMs,
      costStatus: result.receipt.costStatus,
      logCount: result.receipt.logIds.length,
      mediaType: result.track.mediaType,
      byteLength: result.track.byteLength,
      sourceHost: result.track.sourceHost,
      // Absent for MP3, which is the common case. Recording it as `null` rather than omitting the
      // field keeps a log search for the key from implying a bug.
      durationSeconds: result.track.durationSeconds ?? null,
      pricingUnit: result.applied.pricingUnit,
      estimatedCostUsd: result.applied.estimatedCostUsd
    });

    const response: GenerateMusicResponse = {
      track: result.track,
      receipt: result.receipt,
      applied: result.applied
    };
    return context.json(response);
  } catch (cause) {
    // The inference client has already logged the provider's own message against this same run
    // identifier. This line records the panel-level outcome, repeats the settings, and names the
    // classified reason — which is the field that distinguishes "top up the account" from "try
    // again" in a log, exactly as it does in the UI.
    logger.warn('generate_music_run_failed', {
      runId: request.runId,
      reason: classifyMusicFailure(cause),
      ...describeAttempt(request)
    });
    throw cause;
  }
});
