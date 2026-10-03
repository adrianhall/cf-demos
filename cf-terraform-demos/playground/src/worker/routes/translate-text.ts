import { Hono } from 'hono';
import { currentIdentity, jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import {
  MAX_TRANSLATION_CHARACTERS,
  type TranslateTextResponse
} from '../../shared/translate-text';
import type { AppBindings } from '../bindings';
import {
  validateTranslateTextRequest,
  type ValidatedTranslateTextRequest
} from '../domain/translate-text';

/**
 * Largest Translate Text request body accepted.
 *
 * Derived from the panel's character ceiling rather than chosen, so raising that limit cannot
 * silently leave this behind and turn a valid request into an opaque refusal. Four bytes per
 * character covers the worst case for UTF-8 — and this is the first panel where that matters in
 * practice rather than in theory, because the target languages are written in scripts that really
 * do occupy three and four bytes per character.
 *
 * Note the volumes on this endpoint: a few kilobytes in, a few kilobytes out. It is the only panel
 * since Chat whose request and response are the same order of magnitude.
 */
export const TRANSLATE_TEXT_BODY_LIMIT_BYTES = MAX_TRANSLATION_CHARACTERS * 4 + 2_048;

/**
 * Translate Text's endpoint, mounted at `/api/translate-text`.
 *
 * A plain JSON `POST` rather than SSE. Both reviewed models answer synchronously, and a translation
 * is not usefully streamed: a half-translated line is not a readable prefix of the finished one the
 * way a half-written chat answer is, because word order differs between languages.
 *
 * One request here can make **several** gateway calls, which is new. A model that accepts an array
 * of lines translates a passage in one call; a model that takes a single string takes one per line.
 * The route does not need to know which — the service reads it from the reviewed descriptor — but
 * the logs record the count, because it is what a visitor would otherwise discover from the bill.
 *
 * Nothing is stored. The source text is already in the browser and the translation travels back in
 * the response, so there is no second copy to keep.
 */
export const translateTextRouter = new Hono<AppBindings>();

translateTextRouter.use(jsonBodyLimit(TRANSLATE_TEXT_BODY_LIMIT_BYTES));

/**
 * Summarises what a validated request asked for, without disclosing its content.
 *
 * The languages are logged by value: neither is visitor content — each is an enumerated code from
 * the model's own reviewed list — and which pair was requested is frequently the whole explanation
 * for a poor or refused translation.
 *
 * The text is recorded as a character count and a line count. The line count is the more useful of
 * the two here, because for a non-batching model it _is_ the number of paid calls.
 *
 * @param request The validated request.
 * @returns Structured fields describing the request's shape.
 */
function describeRequest(request: ValidatedTranslateTextRequest): Record<string, unknown> {
  const controls = request.model.translationControls;

  return {
    runId: request.runId,
    model: request.model.id,
    contractVersion: request.model.contractVersion,
    // Null rather than omitted for a fixed-source model, so a log search for the key does not
    // imply a bug when the model simply has no source control.
    sourceLanguage: request.sourceLanguage ?? controls?.defaultSourceLanguage ?? null,
    targetLanguage: request.targetLanguage,
    characterCount: [...request.text].length,
    lineCount: request.lines.length,
    translatableLineCount: request.contentLineIndices.length,
    // The predicted number of gateway calls. Logged before the run so a request that fails partway
    // through can be compared against what it intended to do.
    plannedCalls:
      controls?.batchesSegments === true
        ? Math.min(1, request.contentLineIndices.length)
        : request.contentLineIndices.length
  };
}

/**
 * Translates one passage and returns it with its run receipt.
 *
 * Every failure is an ordinary RFC 9457 problem-details response. Nothing is sent until the whole
 * translation has been produced, so a real status code is always still available — including for a
 * non-batching model that failed on its ninth line, which is reported as a failed run rather than
 * as a partial translation.
 *
 * @param context Hono request context, carrying the verified Access identity and the request-scoped
 *   Translate Text service.
 * @returns A JSON `200` carrying {@link TranslateTextResponse}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is malformed, carries an
 *   identity field, names an unknown model, supplies a source language to a model whose source is
 *   fixed, names a language the selected model does not declare, repeats the same language on both
 *   sides, or submits text that is empty, too long, or has too many lines; `502` when the provider
 *   fails or returns no usable translation; `503` when the account has insufficient AI Gateway
 *   credit, which cannot arise for the reviewed Cloudflare-hosted models but would for a
 *   third-party model added later.
 */
translateTextRouter.post('/', async (context) => {
  const request = validateTranslateTextRequest(await readJsonBody(context.req.raw));

  const identity = currentIdentity(context);
  // Assembled from the verified JWT claims alone. There is no code path by which a body or header
  // value could reach it, which is why the domain rejects a body that carries one rather than
  // relying on a filter.
  const actor = { email: identity.email, sub: identity.sub };

  const logger = context.var.LOGGER;

  // Logged before the model is called, not only after. A request that fails inside the provider, or
  // times out, or is cancelled mid-flight would otherwise leave no record of having been attempted
  // — which is precisely the case where knowing what was asked for matters most. It matters more
  // here than in any earlier panel: one request can be a dozen billed calls, so a run that
  // disappears without a trace is a charge without an explanation.
  logger.info('translate_text_run_started', describeRequest(request));

  try {
    const result = await context.var.TRANSLATE_TEXT_SERVICE.translate(request, actor);

    // Deliberately free of the source text, the translation, and the user's email. The email is
    // recorded in AI Gateway metadata and nowhere else; a structured log is a different retention
    // domain with different access control.
    logger.info('translate_text_run_completed', {
      runId: result.receipt.runId,
      model: result.receipt.model,
      elapsedMs: result.receipt.elapsedMs,
      costStatus: result.receipt.costStatus,
      // The count that makes this panel's cost legible. A run with twelve logs is a run that was
      // billed twelve times, and the receipt is the only place that is visible.
      logCount: result.receipt.logIds.length,
      inferenceCallCount: result.translation.inferenceCallCount,
      translatedLineCount: result.translation.translatedLineCount,
      segmentCount: result.translation.segments.length
    });

    const response: TranslateTextResponse = {
      translation: result.translation,
      receipt: result.receipt,
      applied: result.applied
    };
    return context.json(response);
  } catch (cause) {
    // The inference client has already logged the provider's own message against this same run
    // identifier, and the service has logged which call failed. This line records the panel-level
    // outcome and repeats the request's shape, so one search for the run identifier returns the
    // whole story.
    logger.warn('translate_text_run_failed', describeRequest(request));
    throw cause;
  }
});
