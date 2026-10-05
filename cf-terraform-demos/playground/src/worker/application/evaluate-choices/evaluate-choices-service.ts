/**
 * @file The Evaluate Choices use case: call the decision model through the gateway, read the typed
 *   answers, record the run, and build the receipt. The service is deliberately thin, and that is
 *   worth noting rather than apologising for. The substance of this panel lives in validation (what
 *   a caller may ask) and normalisation (what the model's answer is allowed to be), both of which
 *   are pure logic over plain data and both of which belong in the domain where every transport
 *   gets them. What is left here is orchestration: one call, one read, one record. **One call,
 *   however many questions.** This is the panel's cost story and the reason the service has no
 *   loop. Asking five questions about one state is a single gateway request, not five — which is
 *   precisely what a decision model buys over five classifier calls. A visitor can watch the
 *   question count rise while the request count stays at one. The one judgement this service makes
 *   is about **partial degradation**. The model can answer four of five questions usably, and those
 *   four are returned rather than failing the whole run: they were asked, paid for, and answered
 *   correctly. But a silent four-card result would be indistinguishable from having asked four
 *   questions, so the unanswered names travel in the result and the skip is logged with its
 *   counts.
 */

import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type { AppliedEvaluationControls, EvaluationResult } from '../../../shared/evaluate-choices';
import type { RunReceipt } from '../../../shared/runs';
import {
  buildEvaluationInput,
  countQuestionTypes,
  describeAppliedEvaluationControls,
  type ValidatedEvaluateChoicesRequest
} from '../../domain/evaluate-choices';
import {
  readEvaluationAnswers,
  type EvaluationRejection
} from '../../domain/evaluation-normalisation';
import { initialCostStatus } from '../../domain/metrics';
import type { DiagnosticLogger } from '../ports/diagnostic-logger-port';
import type { InferencePort, VerifiedActor } from '../ports/inference-port';
import type { RunRepositoryPort } from '../ports/run-repository-port';

/**
 * What a completed Evaluate Choices run produced.
 */
export interface EvaluateChoicesServiceResult {
  /**
   * The typed answers and the model's own usage report.
   */
  result: EvaluationResult;
  /**
   * The run receipt, already persisted for a later metrics lookup.
   */
  receipt: RunReceipt;
  /**
   * The settings the evaluation was produced with.
   */
  applied: AppliedEvaluationControls;
}

/**
 * Dependencies of {@link EvaluateChoicesService}.
 */
export interface EvaluateChoicesServiceOptions {
  /**
   * Gateway-routed inference, injected by the Worker's composition root.
   */
  inference: InferencePort;
  /**
   * Where run records are kept until their metrics are read.
   */
  runs: RunRepositoryPort;
  /**
   * Clock reading epoch milliseconds. Injected so a test can assert on timing without waiting.
   */
  now?: () => number;
  /**
   * Where an unusable provider output is recorded.
   */
  logger?: DiagnosticLogger;
}

/**
 * Evaluates typed questions about a state through AI Gateway.
 */
export class EvaluateChoicesService {
  readonly #inference: InferencePort;
  readonly #runs: RunRepositoryPort;
  readonly #now: () => number;
  readonly #logger: DiagnosticLogger | undefined;

  /**
   * Creates the service.
   *
   * @param options Inference port, run repository, and optional clock and logger; see
   *   {@link EvaluateChoicesServiceOptions}.
   */
  constructor(options: EvaluateChoicesServiceOptions) {
    this.#inference = options.inference;
    this.#runs = options.runs;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
  }

  /**
   * Runs one evaluation.
   *
   * @param request A validated request; the type cannot be produced without validation.
   * @param actor The verified Access identity the run is attributed to, used both for gateway
   *   metadata and as the record's owner for the later ownership check.
   * @returns The answers, receipt, and applied controls; see
   * {@link EvaluateChoicesServiceResult}.
   * @throws {ProblemDetailsError} With `502` when the provider fails, or when it returns something
   *   with no usable answer in the shape its reviewed contract declares.
   * @throws {Error} When the actor carries no verified email, so the request could not be
   *   attributed to anyone.
   */
  async evaluate(
    request: ValidatedEvaluateChoicesRequest,
    actor: VerifiedActor
  ): Promise<EvaluateChoicesServiceResult> {
    const startedAtMs = this.#now();
    const startedAt = new Date(startedAtMs).toISOString();

    // One call for every question. The whole panel rests on this line being outside a loop.
    const call = await this.#inference.run<Record<string, unknown>, unknown>({
      task: 'evaluate-choices',
      model: request.model,
      runId: request.runId,
      actor,
      input: buildEvaluationInput(request)
    });

    const logIds = call.logId === undefined ? [] : [call.logId];
    const read = readEvaluationAnswers(call.output, request.questions);

    if (!read.ok) {
      // Counts, keys, and types only — never values. A value here would be the visitor's own
      // state or their own question wording.
      this.#logger?.error('evaluate_choices_output_unusable', {
        reason: read.reason,
        model: request.model.id,
        contractVersion: request.model.contractVersion,
        runId: request.runId,
        questionCount: request.questions.length,
        questionTypeCounts: countQuestionTypes(request.questions),
        outputType: call.output === null ? 'null' : typeof call.output,
        outputKeys:
          typeof call.output === 'object' && call.output !== null && !Array.isArray(call.output)
            ? Object.keys(call.output as Record<string, unknown>)
            : []
      });

      throw evaluationFailure(read.reason);
    }

    // Survivable, so the run continues — but never silently. A visitor who asked five questions
    // and sees four cards is owed the names of the missing one, and an operator is owed the
    // counts.
    if (read.unansweredQuestions.length > 0) {
      this.#logger?.warn('evaluate_choices_answers_incomplete', {
        model: request.model.id,
        contractVersion: request.model.contractVersion,
        runId: request.runId,
        asked: request.questions.length,
        answered: read.answers.length,
        unanswered: read.unansweredQuestions.length
      });
    }

    const receipt: RunReceipt = {
      runId: request.runId,
      task: 'evaluate-choices',
      model: request.model.id,
      gatewayRouted: true,
      logIds,
      status: 'completed',
      costStatus: initialCostStatus(logIds),
      elapsedMs: this.#now() - startedAtMs,
      startedAt
    };

    await this.#runs.save({
      runId: receipt.runId,
      task: receipt.task,
      model: receipt.model,
      ownerEmail: actor.email,
      logIds,
      status: receipt.status,
      startedAtMs
    });

    return {
      result: {
        answers: read.answers,
        unansweredQuestions: read.unansweredQuestions,
        usage: read.usage
      },
      receipt,
      applied: describeAppliedEvaluationControls(request)
    };
  }
}

/**
 * Builds the sanitised error returned when an evaluation cannot be produced or trusted.
 *
 * The detail differs by cause because the useful advice differs: an unrecognised envelope may be a
 * transient provider fault, while answers that are present but unreadable for every question
 * indicates the typed contract itself has moved.
 *
 * @param reason Why normalisation refused the output.
 * @returns A `502` problem-details error.
 */
function evaluationFailure(reason: EvaluationRejection): ProblemDetailsError {
  const detail =
    reason === 'no_usable_answers'
      ? 'The model answered, but not one answer matched the type of the question it was asked. '
        + 'This application will not reinterpret an answer as a different type, because the '
        + 'result would be a confident reading of the wrong number. This is a fault in the '
        + 'service rather than in your questions.'
      : 'The model did not answer in the shape its contract describes. This is a fault in the '
        + 'service rather than in your request, and retrying is unlikely to help.';

  return new ProblemDetailsError({
    status: 502,
    title: 'The questions could not be evaluated',
    detail
  });
}
