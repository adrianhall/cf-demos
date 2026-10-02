import { Hono } from 'hono';
import { currentIdentity, jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import { MAX_INPUT_AUDIO_BYTES, type TranscribeAudioResponse } from '../../shared/transcribe-audio';
import type { AppBindings } from '../bindings';
import {
  validateTranscribeAudioRequest,
  type ValidatedTranscribeAudioRequest
} from '../domain/transcribe-audio';

/**
 * Largest Transcribe Audio request body accepted.
 *
 * Sized from the panel's own audio ceiling rather than chosen: base64 inflates by about a third, so
 * the body limit has to clear `MAX_INPUT_AUDIO_BYTES * 4 / 3` plus room for the surrounding JSON
 * and a context prompt. Deriving it means raising the audio limit cannot silently leave this behind
 * and turn a valid upload into an opaque refusal.
 *
 * This is the panel-wide ceiling. The _model-specific_ limit is enforced inside the domain, where
 * the selected descriptor is known — a model whose schema demands a JSON array of byte values
 * accepts a quarter of this, and refusing that at the transport layer would lose the explanation.
 *
 * Note which direction the volume travels on this endpoint: a request of several megabytes produces
 * a response of a few kilobytes. It is the exact inverse of Read Text.
 */
export const TRANSCRIBE_AUDIO_BODY_LIMIT_BYTES = Math.ceil(MAX_INPUT_AUDIO_BYTES * (4 / 3)) + 8_192;

/**
 * Transcribe Audio's endpoint, mounted at `/api/transcribe-audio`.
 *
 * A plain JSON `POST` rather than SSE or a job. All three reviewed models return the complete
 * transcript within the request, and the panel's duration cap keeps that to a few minutes of audio,
 * so there is nothing to stream and no render to protect from a closed tab — which is what made
 * Create Video a Workflow.
 *
 * The audio arrives base64-encoded in the JSON body rather than as `multipart/form-data`, matching
 * the image panels: the request's other fields are JSON already, and one body shape means one
 * validation path and one size limit instead of two.
 *
 * Nothing is stored. The browser already holds the file it chose, and the transcript is returned in
 * the response, so there is no second copy to keep — see `tests/worker/panel-architecture.test.ts`,
 * which holds that boundary.
 */
export const transcribeAudioRouter = new Hono<AppBindings>();

transcribeAudioRouter.use(jsonBodyLimit(TRANSCRIBE_AUDIO_BODY_LIMIT_BYTES));

/**
 * Summarises which controls a validated request actually asked for.
 *
 * Only the controls that were supplied appear, so a log line reads as the decisions the visitor
 * made rather than a fixed set of fields padded with nulls.
 *
 * The language and the flags are logged by _value_: none is visitor content — each is an enumerated
 * code or a boolean from the model's own schema — and which language was hinted is frequently the
 * whole explanation for a poor transcript. The context prompt is the one exception and is recorded
 * only as a length, because it is free text the visitor wrote.
 *
 * @param request The validated request.
 * @returns Structured fields naming the requested controls and their values.
 */
function describeRequestedControls(
  request: ValidatedTranscribeAudioRequest
): Record<string, unknown> {
  const requested: Record<string, unknown> = {};

  if (request.language !== undefined) {
    requested['language'] = request.language;
  }
  if (request.detectLanguage !== undefined) {
    requested['detectLanguage'] = request.detectLanguage;
  }
  if (request.diarize !== undefined) {
    requested['diarize'] = request.diarize;
  }
  if (request.punctuate !== undefined) {
    requested['punctuate'] = request.punctuate;
  }
  if (request.contextPrompt !== undefined) {
    // Length rather than content. The prompt is the visitor's own text, and the length still
    // distinguishes a request that supplied one from a request that did not.
    requested['contextPromptCharacters'] = [...request.contextPrompt].length;
  }

  return { requestedControls: Object.keys(requested), requested };
}

/**
 * Transcribes one recording and returns the transcript with its run receipt.
 *
 * Every failure is an ordinary RFC 9457 problem-details response. As with the other synchronous
 * panels there is no partially delivered response to worry about: nothing is sent until the
 * transcript has been produced and normalised, so a real status code is always still available.
 *
 * @param context Hono request context, carrying the verified Access identity and the request-scoped
 *   Transcribe Audio service.
 * @returns A JSON `200` carrying {@link TranscribeAudioResponse}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is malformed, carries an
 *   identity or self-described audio field, names an unknown model, supplies a control the selected
 *   model does not support, or submits audio that is not an accepted format or is beyond that
 *   model's own size ceiling; `502` when the provider fails or returns no usable transcript; `503`
 *   when the account has insufficient AI Gateway credit, which cannot arise for the reviewed
 *   Cloudflare-hosted models but would for a third-party model added later.
 */
transcribeAudioRouter.post('/', async (context) => {
  const request = validateTranscribeAudioRequest(await readJsonBody(context.req.raw));

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
  // The audio's facts are recorded rather than the audio: the recording is the visitor's content,
  // while its format, size, and duration are what explain a provider rejection or a charge. The
  // duration is also the billable quantity for every reviewed model.
  logger.info('transcribe_audio_run_started', {
    runId: request.runId,
    model: request.model.id,
    contractVersion: request.model.contractVersion,
    mediaType: request.audioFacts.mediaType,
    byteLength: request.audioFacts.byteLength,
    // Null rather than omitted for a compressed file, so a log search for the key does not imply a
    // bug when the common case simply has no duration to report.
    durationSeconds: request.audioFacts.durationSeconds ?? null,
    ...describeRequestedControls(request)
  });

  try {
    const result = await context.var.TRANSCRIBE_AUDIO_SERVICE.transcribe(request, actor);

    // Deliberately free of the transcript, the audio, and the user's email. The email is recorded in
    // AI Gateway metadata and nowhere else; a structured log is a different retention domain with
    // different access control. The counts and flags below are safe and genuinely useful when
    // diagnosing a provider that changed its output shape — which for these three models means
    // three shapes to tell apart.
    logger.info('transcribe_audio_run_completed', {
      runId: result.receipt.runId,
      model: result.receipt.model,
      elapsedMs: result.receipt.elapsedMs,
      costStatus: result.receipt.costStatus,
      logCount: result.receipt.logIds.length,
      wordCount: result.transcript.wordCount,
      spanCount: result.transcript.spans.length,
      // Whether the model returned the timing and quality information its contract promised. A
      // sudden absence here is the earliest signal that an envelope changed, and it is invisible
      // in a success status.
      timestampGranularity: result.transcript.timestampGranularity ?? null,
      confidenceScale: result.transcript.confidenceScale ?? null,
      diarized: result.transcript.diarized,
      detectedLanguage: result.transcript.detectedLanguage ?? null
    });

    const response: TranscribeAudioResponse = {
      transcript: result.transcript,
      audio: result.audio,
      receipt: result.receipt,
      applied: result.applied
    };
    return context.json(response);
  } catch (cause) {
    // The inference client has already logged the provider's own message against this same run
    // identifier. This line records the panel-level outcome and repeats the settings, so one search
    // for the run identifier returns both halves of the story.
    logger.warn('transcribe_audio_run_failed', {
      runId: request.runId,
      model: request.model.id,
      mediaType: request.audioFacts.mediaType,
      byteLength: request.audioFacts.byteLength,
      ...describeRequestedControls(request)
    });
    throw cause;
  }
});
