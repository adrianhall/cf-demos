import { Hono } from 'hono';
import { currentIdentity, jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import {
  MAX_EVALUATION_INSTRUCTION_CHARACTERS,
  MAX_EVALUATION_OPTIONS,
  MAX_EVALUATION_QUESTIONS,
  MAX_EVALUATION_STATE_CHARACTERS,
  type EvaluateChoicesResponse
} from '../../shared/evaluate-choices';
import type { AppBindings } from '../bindings';
import {
  countQuestionTypes,
  validateEvaluateChoicesRequest,
  type ValidatedEvaluateChoicesRequest
} from '../domain/evaluate-choices';

/**
 * Largest Evaluate Choices request body accepted.
 *
 * Derived from the panel's own ceilings rather than chosen, so raising one of them cannot silently
 * leave this behind and turn a valid request into an opaque refusal. The state plus the worst-case
 * question set — every question carrying the maximum number of options, each with a full-length
 * description — at four bytes per character for the worst UTF-8 case, with headroom for the JSON
 * structure around them.
 */
export const EVALUATE_CHOICES_BODY_LIMIT_BYTES =
  (MAX_EVALUATION_STATE_CHARACTERS
    + MAX_EVALUATION_QUESTIONS * MAX_EVALUATION_OPTIONS * MAX_EVALUATION_INSTRUCTION_CHARACTERS)
    * 4
  + 8_192;

/**
 * Evaluate Choices' endpoint, mounted at `/api/evaluate-choices`.
 *
 * A plain JSON `POST` rather than SSE. The answer is a set of typed structures that are not
 * meaningful until complete — half a probability distribution is not a useful prefix of a whole one
 * — and there is no token stream here to forward in any case, because nothing is generated.
 *
 * **However many questions are asked, this endpoint makes exactly one gateway call.** That is the
 * defining property of a decision model and the reason the panel exists: five questions about one
 * state cost one request, not five.
 *
 * The caller supplies the questions, the types, the instructions, and the criteria. That is the
 * deliberate inverse of Classify Text next door, where the label set belongs to the trained model
 * and a caller-supplied label is refused. What a caller cannot supply _here_ is a prompt: there is
 * no `prompt`, `system`, `messages`, `temperature`, or `response_format` field, and the domain
 * refuses a body carrying one rather than ignoring it. The answer is a typed contract, not prose
 * being coaxed into JSON, and an API that appeared to accept a prompt would teach the opposite.
 *
 * Nothing the visitor typed is stored or logged. The state and the question wording never reach a
 * log line; only counts, types, and names of the shape of the request do.
 */
export const evaluateChoicesRouter = new Hono<AppBindings>();

evaluateChoicesRouter.use(jsonBodyLimit(EVALUATE_CHOICES_BODY_LIMIT_BYTES));

/**
 * Summarises what a validated request asked for, without disclosing its content.
 *
 * The state and the question wording are recorded as counts alone. The question _types_ are logged
 * because they are frequently the whole explanation for a result's shape — a run with no confidence
 * anywhere is a run that asked only `noul` questions.
 *
 * @param request The validated request.
 * @returns Structured fields describing the request's shape.
 */
function describeRequest(request: ValidatedEvaluateChoicesRequest): Record<string, unknown> {
  return {
    runId: request.runId,
    model: request.model.id,
    contractVersion: request.model.contractVersion,
    stateFormat: request.stateFormat,
    stateCharacterCount: [...request.state].length,
    questionCount: request.questions.length,
    questionTypeCounts: countQuestionTypes(request.questions),
    // Always one, whatever the question count. Logged explicitly so the batching claim is
    // checkable from the logs rather than only from the documentation.
    gatewayCalls: 1
  };
}

/**
 * Evaluates typed questions about one state and returns the answers with the run receipt.
 *
 * Every failure is an ordinary RFC 9457 problem-details response. Nothing is sent until the whole
 * evaluation has completed, so a real status code is always still available.
 *
 * @param context Hono request context, carrying the verified Access identity and the request-scoped
 *   Evaluate Choices service.
 * @returns A JSON `200` carrying {@link EvaluateChoicesResponse}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is malformed, carries an
 *   identity field, carries a generative control such as `prompt` or `temperature`, names an
 *   unknown model, submits a state that is empty, too long, or marked JSON but unparseable, or
 *   submits questions that are absent, too many, duplicated by name, badly named, or malformed for
 *   their declared type; `502` when the provider fails or returns no usable answer; `503` when the
 *   account has insufficient AI Gateway credit, which cannot arise for the reviewed
 *   Cloudflare-hosted models but would for a third-party model added later.
 */
evaluateChoicesRouter.post('/', async (context) => {
  const request = validateEvaluateChoicesRequest(await readJsonBody(context.req.raw));

  const identity = currentIdentity(context);
  // Assembled from the verified JWT claims alone. There is no code path by which a body or header
  // value could reach it, which is why the domain rejects a body that carries one rather than
  // relying on a filter.
  const actor = { email: identity.email, sub: identity.sub };

  const logger = context.var.LOGGER;

  // Logged before the model is called, not only after. A request that fails inside the provider,
  // or times out, or is cancelled mid-flight would otherwise leave no record of having been
  // attempted — which is precisely the case where knowing what was asked for matters most.
  logger.info('evaluate_choices_run_started', describeRequest(request));

  try {
    const result = await context.var.EVALUATE_CHOICES_SERVICE.evaluate(request, actor);

    // Deliberately free of the state, the question wording, the answers, and the user's email.
    // The *shape* of the outcome is recorded, not the outcome: how many questions were answered
    // and what the model read, but never which option won, because for an evaluation that is a
    // judgement about the visitor's own content.
    logger.info('evaluate_choices_run_completed', {
      runId: result.receipt.runId,
      model: result.receipt.model,
      elapsedMs: result.receipt.elapsedMs,
      costStatus: result.receipt.costStatus,
      answeredCount: result.result.answers.length,
      unansweredCount: result.result.unansweredQuestions.length,
      // The asymmetric price shape, visible in the logs rather than only in the UI. Output tokens
      // are zero on every reviewed call because a typed decision is not generated text.
      inputTokens: result.result.usage.inputTokens,
      outputTokens: result.result.usage.outputTokens,
      logCount: result.receipt.logIds.length
    });

    const response: EvaluateChoicesResponse = {
      result: result.result,
      receipt: result.receipt,
      applied: result.applied
    };
    return context.json(response);
  } catch (cause) {
    // The inference client has already logged the provider's own message against this same run
    // identifier, and the service has logged why an output was refused. This line records the
    // panel-level outcome and repeats the request's shape, so one search for the run identifier
    // returns the whole story.
    logger.warn('evaluate_choices_run_failed', describeRequest(request));
    throw cause;
  }
});
