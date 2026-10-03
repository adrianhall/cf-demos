/**
 * @file The Translate Text use case: call the model once or once per line depending on what its
 *   contract accepts, read the translation out of whichever field it uses, reassemble the source's
 *   line structure, record the run, and build the receipt. This is the first service in the demo
 *   that makes a **variable number of inference calls**, and that single fact shapes everything
 *   here. A batching model translates a twelve-line passage in one call; a non-batching model takes
 *   twelve. Three consequences follow, and each is a decision rather than an implementation detail:
 *   **The receipt carries several gateway log identifiers.** `aggregateRunMetrics` has supported
 *   that since phase 3 — it refuses to report a partial total — but this panel is the first to
 *   exercise it, so a run's cost stays `pending` until every one of its calls has a log. **The
 *   calls are made in sequence, not in parallel.** Translating twelve lines concurrently would be
 *   faster and worse. Each line is a separately billed request, so a failure partway through a
 *   parallel fan-out leaves an unknown number of paid calls in flight with no way to report what
 *   was spent. Sequential calls mean a failure has a known cost and a known position. **A failure
 *   partway through is reported as a failure, not as a partial result.** A passage half-translated
 *   is not a translation, and returning one would both look like a model that trails off and charge
 *   for lines the visitor cannot use. The log records which line failed, because that is the
 *   diagnostic a status code cannot carry.
 */

import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type { RunReceipt } from '../../../shared/runs';
import type { AppliedTranslationControls, Translation } from '../../../shared/translate-text';
import { initialCostStatus } from '../../domain/metrics';
import {
  buildTranslateTextInput,
  describeAppliedTranslationControls,
  type ValidatedTranslateTextRequest
} from '../../domain/translate-text';
import {
  assembleTranslation,
  readTranslations,
  type TranslationRejection
} from '../../domain/translation-normalisation';
import type { DiagnosticLogger } from '../ports/diagnostic-logger-port';
import type { InferencePort, VerifiedActor } from '../ports/inference-port';
import type { RunRepositoryPort } from '../ports/run-repository-port';

/**
 * What a completed Translate Text run produced.
 */
export interface TranslateTextResult {
  /**
   * The assembled translation; see {@link Translation}.
   */
  translation: Translation;
  /**
   * The run receipt, already persisted for a later metrics lookup.
   */
  receipt: RunReceipt;
  /**
   * The settings the translation was produced with.
   */
  applied: AppliedTranslationControls;
}

/**
 * Dependencies of {@link TranslateTextService}.
 */
export interface TranslateTextServiceOptions {
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
   *
   * A refusal here is indistinguishable from a provider error at the HTTP boundary — both are a
   * `502` — but the two have entirely different causes, so the distinction has to be recorded.
   */
  logger?: DiagnosticLogger;
}

/**
 * Translates text through AI Gateway.
 */
export class TranslateTextService {
  readonly #inference: InferencePort;
  readonly #runs: RunRepositoryPort;
  readonly #now: () => number;
  readonly #logger: DiagnosticLogger | undefined;

  /**
   * Creates the service.
   *
   * @param options Inference port, run repository, and optional clock and logger; see
   *   {@link TranslateTextServiceOptions}.
   */
  constructor(options: TranslateTextServiceOptions) {
    this.#inference = options.inference;
    this.#runs = options.runs;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
  }

  /**
   * Runs one translation.
   *
   * Makes one gateway call for a model that accepts an array of lines, and one per content line for
   * a model that does not — the choice coming from the reviewed descriptor rather than from a
   * heuristic. Every call's log identifier is collected, so the receipt describes the whole run
   * rather than its last request.
   *
   * @param request A validated request; the type cannot be produced without validation.
   * @param actor The verified Access identity the run is attributed to, used both for gateway
   *   metadata and as the record's owner for the later ownership check.
   * @returns The translation, receipt, and applied controls; see {@link TranslateTextResult}.
   * @throws {ProblemDetailsError} With `502` when the provider fails, or when it returns something
   *   with no usable translation in the field its reviewed contract declares.
   * @throws {Error} When the actor carries no verified email, so the request could not be
   *   attributed to anyone.
   */
  async translate(
    request: ValidatedTranslateTextRequest,
    actor: VerifiedActor
  ): Promise<TranslateTextResult> {
    const startedAtMs = this.#now();
    const startedAt = new Date(startedAtMs).toISOString();

    const batches = controlsOf(request).batchesSegments;
    const contentLines = request.contentLineIndices.map((index) => request.lines[index] ?? '');

    // One unit of work per gateway call: a single array for a batching model, one line each
    // otherwise. Building the list first keeps the loop below identical for both models, so the
    // only difference between them is how many entries it walks.
    const units: readonly (readonly string[])[] = batches
      ? [contentLines]
      : contentLines.map((line) => [line]);

    const translations: string[] = [];
    const logIds: string[] = [];

    for (const [callIndex, texts] of units.entries()) {
      const result = await this.#inference.run<Record<string, unknown>, unknown>({
        task: 'translate-text',
        model: request.model,
        runId: request.runId,
        actor,
        input: buildTranslateTextInput(request, texts)
      });

      if (result.logId !== undefined) {
        logIds.push(result.logId);
      }

      const outcome = readTranslations(result.output, request.model, texts.length);

      if (!outcome.ok) {
        // Logged with which call failed and what arrived, which is what makes a partial failure
        // diagnosable: for a non-batching model the interesting question is *which line* broke, and
        // a status code cannot answer it. Keys only, never values — a value here would be the
        // visitor's text or its translation.
        this.#logger?.error('translate_text_output_unusable', {
          reason: outcome.reason,
          model: request.model.id,
          contractVersion: request.model.contractVersion,
          runId: request.runId,
          expectedField: controlsOf(request).outputField,
          // One-based, and reported alongside the total so a failure on the last of twelve calls
          // reads differently from a failure on the first.
          failedCall: callIndex + 1,
          totalCalls: units.length,
          // Recorded because a run that failed on its ninth call has already been charged for
          // eight, and that is the number someone reconciling a bill needs.
          callsCompleted: callIndex,
          outputKeys:
            typeof result.output === 'object' && result.output !== null
              ? Object.keys(result.output as Record<string, unknown>)
              : [],
          outputType: result.output === null ? 'null' : typeof result.output
        });

        throw translationFailure(outcome.reason);
      }

      translations.push(...outcome.translations);
    }

    const translation = assembleTranslation(
      request.lines,
      request.contentLineIndices,
      translations,
      units.length
    );

    const receipt: RunReceipt = {
      runId: request.runId,
      task: 'translate-text',
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
      translation,
      receipt,
      applied: describeAppliedTranslationControls(request, units.length)
    };
  }
}

/**
 * Reads the resolved model's translation controls.
 *
 * Validation has already refused a translation model with no controls, so this cannot be absent in
 * practice. The fallback keeps the type honest without scattering non-null assertions through the
 * service.
 *
 * @param request A validated request.
 * @returns The model's declared translation controls.
 */
function controlsOf(
  request: ValidatedTranslateTextRequest
): NonNullable<ValidatedTranslateTextRequest['model']['translationControls']> {
  const controls = request.model.translationControls;
  if (controls === undefined) {
    throw new Error(`model ${request.model.id} has no reviewed translation controls`);
  }
  return controls;
}

/**
 * Builds the sanitised error returned when a translation cannot be produced or trusted.
 *
 * The detail differs by cause because the useful advice differs. An async acknowledgement is a
 * routing fault rather than anything a visitor did, and a cardinality mismatch is a contract break
 * — neither is fixed by retrying with different text, and saying "try again" would send someone to
 * spend credit on the same outcome.
 *
 * @param reason Why normalisation refused the output.
 * @returns A `502` problem-details error.
 */
function translationFailure(reason: TranslationRejection): ProblemDetailsError {
  const detail =
    reason === 'empty_translation'
      ? 'The model returned an empty translation. Try rephrasing the text, or choose a different '
        + 'model for this panel.'
      : reason === 'async_acknowledgement' || reason === 'wrong_cardinality'
        ? 'The model did not answer in the shape its contract describes. This is a fault in the '
          + 'service rather than in your request, and retrying is unlikely to help.'
        : 'The model did not return a translation. Try again, or choose a different model for this '
          + 'panel.';

  return new ProblemDetailsError({
    status: 502,
    title: 'The text could not be translated',
    detail
  });
}
