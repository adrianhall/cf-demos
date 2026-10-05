import { Hono } from 'hono';
import { currentIdentity, jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import {
  MAX_CLASSIFICATION_TEXT_CHARACTERS,
  type ClassifyTextResponse
} from '../../shared/classify-text';
import type { AppBindings } from '../bindings';
import {
  validateClassifyTextRequest,
  type ValidatedClassifyTextRequest
} from '../domain/classify-text';

/**
 * Largest Classify Text request body accepted.
 *
 * Derived from the panel's character ceiling rather than chosen, so raising that limit cannot
 * silently leave this behind and turn a valid request into an opaque refusal. Four bytes per
 * character covers the worst case for UTF-8.
 */
export const CLASSIFY_TEXT_BODY_LIMIT_BYTES = MAX_CLASSIFICATION_TEXT_CHARACTERS * 4 + 2_048;

/**
 * Classify Text's endpoint, mounted at `/api/classify-text`.
 *
 * A plain JSON `POST` rather than SSE. A classification is a single small structured answer, and
 * there is no partial result worth streaming — a label with half its score is not a useful prefix.
 *
 * The API surface is deliberately narrow, and the narrowness _is_ the design. There is no field for
 * a label, a category, or a question: the categories belong to the trained model, and the domain
 * refuses a body that tries to supply them rather than ignoring it. That refusal is what keeps this
 * endpoint distinct from Evaluate Choices, which takes caller-defined questions and is a separate
 * task with a separate schema. The two panels are cross-linked in the UI and share no API.
 *
 * Nothing is stored. The text is already in the browser and the result travels back in the
 * response, so there is no second copy to keep.
 */
export const classifyTextRouter = new Hono<AppBindings>();

classifyTextRouter.use(jsonBodyLimit(CLASSIFY_TEXT_BODY_LIMIT_BYTES));

/**
 * Summarises what a validated request asked for, without disclosing its content.
 *
 * The text is recorded as a character count alone. The controls are logged by value because they
 * are enumerated numbers from the model's own declared range rather than visitor content, and which
 * were applied is frequently the whole explanation for a result that looks empty.
 *
 * @param request The validated request.
 * @returns Structured fields describing the request's shape.
 */
function describeRequest(request: ValidatedClassifyTextRequest): Record<string, unknown> {
  const controls = request.model.textClassificationControls;

  return {
    runId: request.runId,
    model: request.model.id,
    contractVersion: request.model.contractVersion,
    characterCount: [...request.text].length,
    // Which shape of answer is expected. A refusal later is far easier to read when the log says
    // whether a verdict or a ranking was being looked for.
    expectedOutcomeKind: controls?.outcomeKind ?? null,
    // Null rather than omitted for a model with no ranking controls, so a log search for the key
    // does not imply a bug when the model simply has no such control.
    topK: request.topK ?? controls?.topK?.default ?? null,
    minimumConfidence: request.minimumConfidence ?? controls?.minimumConfidence?.default ?? null
  };
}

/**
 * Classifies one text and returns the result with its run receipt.
 *
 * Every failure is an ordinary RFC 9457 problem-details response. Nothing is sent until the whole
 * classification has been read, so a real status code is always still available.
 *
 * @param context Hono request context, carrying the verified Access identity and the request-scoped
 *   Classify Text service.
 * @returns A JSON `200` carrying {@link ClassifyTextResponse}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is malformed, carries an
 *   identity field, tries to supply caller-defined labels or questions, names an unknown model,
 *   submits text that is empty or too long, or sets a ranking control the selected model does not
 *   have or that falls outside its declared range; `502` when the provider fails or returns no
 *   usable classification; `503` when the account has insufficient AI Gateway credit, which cannot
 *   arise for the reviewed Cloudflare-hosted models but would for a third-party model added later.
 */
classifyTextRouter.post('/', async (context) => {
  const request = validateClassifyTextRequest(await readJsonBody(context.req.raw));

  const identity = currentIdentity(context);
  // Assembled from the verified JWT claims alone. There is no code path by which a body or header
  // value could reach it, which is why the domain rejects a body that carries one rather than
  // relying on a filter.
  const actor = { email: identity.email, sub: identity.sub };

  const logger = context.var.LOGGER;

  // Logged before the model is called, not only after. A request that fails inside the provider,
  // or times out, or is cancelled mid-flight would otherwise leave no record of having been
  // attempted — which is precisely the case where knowing what was asked for matters most.
  logger.info('classify_text_run_started', describeRequest(request));

  try {
    const result = await context.var.CLASSIFY_TEXT_SERVICE.classify(request, actor);

    // Deliberately free of the text, the labels, and the user's email. The *shape* of the answer
    // is recorded, not the answer: how many labels survived, or whether a verdict was reached —
    // but never which categories, because for a safety model that is a judgement about the
    // visitor's own text and belongs in gateway metadata rather than a structured log.
    logger.info('classify_text_run_completed', {
      runId: result.receipt.runId,
      model: result.receipt.model,
      elapsedMs: result.receipt.elapsedMs,
      costStatus: result.receipt.costStatus,
      outcomeKind: result.outcome.kind,
      ...(result.outcome.kind === 'scored-labels'
        ? {
            shownLabels: result.outcome.labels.length,
            totalLabels: result.outcome.totalLabels
          }
        : {
            // How many categories were cited, not which. The count tells an operator the verdict
            // was substantive; the codes would be content.
            categoryCount: result.outcome.verdict.categories.length,
            unrecognisedCategoryCount: result.outcome.verdict.unrecognisedCategories.length
          })
    });

    const response: ClassifyTextResponse = {
      outcome: result.outcome,
      receipt: result.receipt,
      applied: result.applied
    };
    return context.json(response);
  } catch (cause) {
    // The inference client has already logged the provider's own message against this same run
    // identifier, and the service has logged why an output was refused. This line records the
    // panel-level outcome and repeats the request's shape, so one search for the run identifier
    // returns the whole story.
    logger.warn('classify_text_run_failed', describeRequest(request));
    throw cause;
  }
});
