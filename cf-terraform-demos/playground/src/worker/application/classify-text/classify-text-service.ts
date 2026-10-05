/**
 * @file The Classify Text use case: call the classifier through the gateway, read whichever shape
 *   it returned, record the run, and build the receipt. The service itself is deliberately thin,
 *   and that is worth noting rather than apologising for. The substance of this panel lives in
 *   validation (what a caller may ask for) and normalisation (what the model's answer is allowed to
 *   be), both of which are pure logic over plain data and both of which belong in the domain where
 *   every transport gets them. What is left here is the orchestration: one call, one read, one
 *   record. The one judgement this service makes is about **partial degradation**. A scoring
 *   classifier can return a collection where some elements are malformed, and those are skipped
 *   rather than failing the run — but skipping silently would mean a visitor sees a shorter list
 *   with no indication that anything was dropped. So a skip is logged with its counts, and the run
 *   continues.
 */

import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type {
  AppliedTextClassificationControls,
  ClassificationOutcome
} from '../../../shared/classify-text';
import type { RunReceipt } from '../../../shared/runs';
import {
  buildClassifyTextInput,
  describeAppliedTextClassificationControls,
  type ValidatedClassifyTextRequest
} from '../../domain/classify-text';
import { initialCostStatus } from '../../domain/metrics';
import {
  readTextClassification,
  type TextClassificationRejection
} from '../../domain/text-classification-normalisation';
import type { DiagnosticLogger } from '../ports/diagnostic-logger-port';
import type { InferencePort, VerifiedActor } from '../ports/inference-port';
import type { RunRepositoryPort } from '../ports/run-repository-port';

/**
 * What a completed Classify Text run produced.
 */
export interface ClassifyTextResult {
  /**
   * The classification, in whichever shape the model's contract declares.
   */
  outcome: ClassificationOutcome;
  /**
   * The run receipt, already persisted for a later metrics lookup.
   */
  receipt: RunReceipt;
  /**
   * The settings the classification was produced with.
   */
  applied: AppliedTextClassificationControls;
}

/**
 * Dependencies of {@link ClassifyTextService}.
 */
export interface ClassifyTextServiceOptions {
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
   * Where an unusable or partially usable provider output is recorded.
   */
  logger?: DiagnosticLogger;
}

/**
 * Classifies text through AI Gateway.
 */
export class ClassifyTextService {
  readonly #inference: InferencePort;
  readonly #runs: RunRepositoryPort;
  readonly #now: () => number;
  readonly #logger: DiagnosticLogger | undefined;

  /**
   * Creates the service.
   *
   * @param options Inference port, run repository, and optional clock and logger; see
   *   {@link ClassifyTextServiceOptions}.
   */
  constructor(options: ClassifyTextServiceOptions) {
    this.#inference = options.inference;
    this.#runs = options.runs;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
  }

  /**
   * Runs one classification.
   *
   * @param request A validated request; the type cannot be produced without validation.
   * @param actor The verified Access identity the run is attributed to, used both for gateway
   *   metadata and as the record's owner for the later ownership check.
   * @returns The outcome, receipt, and applied controls; see {@link ClassifyTextResult}.
   * @throws {ProblemDetailsError} With `502` when the provider fails, or when it returns something
   *   with no usable classification in the shape its reviewed contract declares.
   * @throws {Error} When the actor carries no verified email, so the request could not be
   *   attributed to anyone.
   */
  async classify(
    request: ValidatedClassifyTextRequest,
    actor: VerifiedActor
  ): Promise<ClassifyTextResult> {
    const startedAtMs = this.#now();
    const startedAt = new Date(startedAtMs).toISOString();

    const result = await this.#inference.run<Record<string, unknown>, unknown>({
      task: 'classify-text',
      model: request.model,
      runId: request.runId,
      actor,
      input: buildClassifyTextInput(request)
    });

    const read = readTextClassification(result.output, request);

    if (!read.ok) {
      // Keys and counts only, never values: a value here would be the visitor's text or the
      // model's judgement about it.
      this.#logger?.error('classify_text_output_unusable', {
        reason: read.reason,
        model: request.model.id,
        contractVersion: request.model.contractVersion,
        runId: request.runId,
        expectedOutcomeKind: request.model.textClassificationControls?.outcomeKind,
        outputType: result.output === null ? 'null' : typeof result.output,
        outputKeys:
          typeof result.output === 'object'
          && result.output !== null
          && !Array.isArray(result.output)
            ? Object.keys(result.output as Record<string, unknown>)
            : []
      });

      throw classificationFailure(read.reason);
    }

    // A degraded but usable response. Logged rather than silently tolerated, because the visitor
    // sees a shorter list with nothing on screen explaining why it is shorter.
    if (read.diagnostics !== undefined && read.diagnostics.skipped > 0) {
      this.#logger?.warn('classify_text_elements_skipped', {
        model: request.model.id,
        contractVersion: request.model.contractVersion,
        runId: request.runId,
        returned: read.diagnostics.returned,
        skipped: read.diagnostics.skipped
      });
    }

    const logIds = result.logId === undefined ? [] : [result.logId];

    const receipt: RunReceipt = {
      runId: request.runId,
      task: 'classify-text',
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
      outcome: read.outcome,
      receipt,
      applied: describeAppliedTextClassificationControls(request)
    };
  }
}

/**
 * Builds the sanitised error returned when a classification cannot be produced or trusted.
 *
 * The detail differs by cause because the useful advice differs — and in one case because the cause
 * is a safety-relevant refusal rather than a glitch. A prose verdict means the safety model
 * answered in free text, which this demo will not parse; saying "try again" would invite someone to
 * spend credit until the model happens to answer in the structured shape.
 *
 * @param reason Why normalisation refused the output.
 * @returns A `502` problem-details error.
 */
function classificationFailure(reason: TextClassificationRejection): ProblemDetailsError {
  const detail =
    reason === 'prose_verdict'
      ? 'The safety model answered in free text rather than a structured verdict, and this '
        + 'application will not infer a safety decision from prose. Try a different model for '
        + 'this panel.'
      : reason === 'no_usable_labels'
        ? 'The model returned labels this application could not read as scored categories. Try a '
          + 'different model for this panel.'
        : 'The model did not answer in the shape its contract describes. This is a fault in the '
          + 'service rather than in your text, and retrying is unlikely to help.';

  return new ProblemDetailsError({
    status: 502,
    title: 'The text could not be classified',
    detail
  });
}
