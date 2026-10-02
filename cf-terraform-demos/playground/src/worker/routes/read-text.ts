import { Hono } from 'hono';
import { currentIdentity, jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import type { ReadTextResponse } from '../../shared/read-text';
import type { AppBindings } from '../bindings';
import { validateReadTextRequest, type ValidatedReadTextRequest } from '../domain/read-text';

/**
 * Largest Read Text request body accepted.
 *
 * The request is pure text — the passage to speak, a model identifier, and two short control names
 * — so the bound is driven by the character limit rather than by any binary payload. 16 KiB holds
 * the full 2,000-character limit even in a script where every character occupies four UTF-8 bytes,
 * with room for the surrounding JSON, and invites nothing larger.
 *
 * Note which direction the volume travels on this endpoint: a small request produces a response of
 * several hundred kilobytes. The response is bounded separately, inside the service, by
 * `MAX_SPEECH_BYTES`.
 */
export const READ_TEXT_BODY_LIMIT_BYTES = 16_384;

/**
 * Read Text's endpoint, mounted at `/api/read-text`.
 *
 * A plain JSON `POST` rather than SSE: there is nothing to stream. Both reviewed model families
 * return the complete audio at the end of their run, so a streaming transport would add framing for
 * a single payload and give a visitor no earlier feedback than a spinner already does.
 *
 * The audio comes back base64-encoded in the JSON response rather than from a follow-up URL, which
 * is the opposite of the choice Create Video made and for concrete reasons rather than consistency.
 * A video needs storage because the provider returns a short-lived URL instead of bytes and because
 * `<video>` seeks with `Range` requests a JSON body cannot answer. Neither applies here: these
 * models return the bytes themselves, and an `<audio>` element can seek freely within a payload the
 * page already holds. Storing it would add a retention surface for no benefit — see
 * `tests/worker/panel-architecture.test.ts`, which holds that boundary.
 */
export const readTextRouter = new Hono<AppBindings>();

readTextRouter.use(jsonBodyLimit(READ_TEXT_BODY_LIMIT_BYTES));

/**
 * Summarises which controls a validated request actually asked for.
 *
 * Only the controls that were supplied appear, so a log line reads as the decisions the visitor
 * made rather than a fixed set of fields padded with nulls. Every value here is a bounded choice
 * from a list the model published, which is what makes a failed attempt reproducible.
 *
 * The voice and language are logged by _value_ rather than only by name, unlike a prompt. Neither
 * is visitor content — both are enumerated identifiers from the model's own schema — and which
 * voice was requested is frequently the whole explanation for a provider rejection.
 *
 * @param request The validated request.
 * @returns Structured fields naming the requested controls and their values.
 */
function describeRequestedControls(request: ValidatedReadTextRequest): Record<string, unknown> {
  const requested: Record<string, string> = {};

  if (request.voice !== undefined) {
    requested['voice'] = request.voice;
  }
  if (request.language !== undefined) {
    requested['language'] = request.language;
  }
  if (request.format !== undefined) {
    requested['format'] = request.format;
  }

  return { requestedControls: Object.keys(requested), requested };
}

/**
 * Speaks one passage of text and returns the audio with its run receipt.
 *
 * Every failure is an ordinary RFC 9457 problem-details response. As with Create Image there is no
 * partially delivered response to worry about: nothing is sent until the audio has been produced
 * and verified, so a real status code is always still available.
 *
 * @param context Hono request context, carrying the verified Access identity and the request-scoped
 *   Read Text service.
 * @returns A JSON `200` carrying {@link ReadTextResponse}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is malformed, carries an
 *   identity field, names an unknown model, or supplies a control the selected model does not
 *   support; `502` when the provider fails or returns something that is not playable audio; `503`
 *   when the account has insufficient AI Gateway credit, which cannot arise for the reviewed
 *   Cloudflare-hosted models but would for a third-party model added later.
 */
readTextRouter.post('/', async (context) => {
  const request = validateReadTextRequest(await readJsonBody(context.req.raw));

  const identity = currentIdentity(context);
  // Assembled from the verified JWT claims alone. There is no code path by which a body or header
  // value could reach it, which is why the domain rejects a body that carries one rather than
  // relying on a filter.
  const actor = { email: identity.email, sub: identity.sub };

  const logger = context.var.LOGGER;

  // Logged before the model is called, not only after. A request that fails inside the provider, or
  // times out, or is cancelled mid-flight would otherwise leave no record of having been attempted
  // — which is precisely the case where knowing what was asked for matters most.
  //
  // The text's length is recorded rather than its content: the passage is the visitor's content, and
  // the length still distinguishes an empty-looking request from a real one. It is also the billable
  // quantity for the character-priced models, so it is the figure that explains a charge.
  logger.info('read_text_run_started', {
    runId: request.runId,
    model: request.model.id,
    contractVersion: request.model.contractVersion,
    characterCount: [...request.text].length,
    ...describeRequestedControls(request)
  });

  try {
    const result = await context.var.READ_TEXT_SERVICE.generate(request, actor);

    // Deliberately free of the text, the audio, and the user's email. The email is recorded in AI
    // Gateway metadata and nowhere else; a structured log is a different retention domain with
    // different access control. The byte length and media type are safe and genuinely useful when
    // diagnosing a provider that changed its output shape — which for MeloTTS is two shapes.
    logger.info('read_text_run_completed', {
      runId: result.receipt.runId,
      model: result.receipt.model,
      elapsedMs: result.receipt.elapsedMs,
      costStatus: result.receipt.costStatus,
      logCount: result.receipt.logIds.length,
      mediaType: result.speech.mediaType,
      byteLength: result.speech.byteLength,
      // Absent for MP3, which is the common case. Its absence is not a fault, and recording it as
      // `null` rather than omitting the field keeps a log search for the key from implying a bug.
      durationSeconds: result.durationSeconds ?? null
    });

    const response: ReadTextResponse = {
      speech: result.speech,
      receipt: result.receipt,
      applied: result.applied
    };
    return context.json(response);
  } catch (cause) {
    // The inference client has already logged the provider's own message against this same run
    // identifier. This line records the panel-level outcome and repeats the settings, so one search
    // for the run identifier returns both halves of the story.
    logger.warn('read_text_run_failed', {
      runId: request.runId,
      model: request.model.id,
      characterCount: [...request.text].length,
      ...describeRequestedControls(request)
    });
    throw cause;
  }
});
