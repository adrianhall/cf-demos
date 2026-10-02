/**
 * @file The Classify Image use case: call the classifier through the gateway, validate the shape of
 *   what came back, rank it, record the run, and build the receipt. The normalisation here differs
 *   from every panel before it. Chat and Describe Image read a string out of an envelope; Create
 *   Image and Remix Image read bytes. A classifier returns a _collection_, and the interesting
 *   failures are structural rather than textual: an element that is not an object, a score that is
 *   not a number, a score outside the range a probability can occupy. Each of those is checked,
 *   because a single malformed element would otherwise reach the browser as a confidence bar of
 *   unbounded width or a label reading `undefined`. An element is rejected individually rather than
 *   failing the whole run, with one exception: if nothing usable survives, the run fails. One bad
 *   element out of twenty is a provider quirk worth logging and skipping; twenty out of twenty is a
 *   contract change worth refusing.
 */

import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type {
  AppliedClassificationControls,
  ClassificationLabel
} from '../../../shared/classify-image';
import type { VerifiedImageFacts } from '../../../shared/describe-image';
import type { RunReceipt } from '../../../shared/runs';
import {
  buildClassifyImageInput,
  describeAppliedClassificationControls,
  rankClassificationLabels,
  type ValidatedClassifyImageRequest
} from '../../domain/classify-image';
import { initialCostStatus } from '../../domain/metrics';
import type { DiagnosticLogger } from '../ports/diagnostic-logger-port';
import type { InferencePort, VerifiedActor } from '../ports/inference-port';
import type { RunRepositoryPort } from '../ports/run-repository-port';

/**
 * What a completed Classify Image run produced.
 */
export interface ClassifyImageResult {
  /**
   * The surviving labels, highest score first.
   */
  labels: ClassificationLabel[];
  /**
   * How many usable labels the model returned before ranking and filtering.
   */
  totalLabels: number;
  /**
   * What the server verified about the submitted picture.
   */
  image: VerifiedImageFacts;
  /**
   * The run receipt, already persisted for a later metrics lookup.
   */
  receipt: RunReceipt;
  /**
   * The settings the classification was produced with, including filled-in model defaults.
   */
  applied: AppliedClassificationControls;
}

/**
 * Dependencies of {@link ClassifyImageService}.
 */
export interface ClassifyImageServiceOptions {
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
 * Classifies pictures through AI Gateway.
 */
export class ClassifyImageService {
  readonly #inference: InferencePort;
  readonly #runs: RunRepositoryPort;
  readonly #now: () => number;
  readonly #logger: DiagnosticLogger | undefined;

  /**
   * Creates the service.
   *
   * @param options Inference port, run repository, optional clock, and logger; see
   *   {@link ClassifyImageServiceOptions}.
   */
  constructor(options: ClassifyImageServiceOptions) {
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
   * @returns The ranked labels, how many the model returned, the receipt, the verified image facts,
   *   and the applied controls; see {@link ClassifyImageResult}.
   * @throws {ProblemDetailsError} With `502` when the provider fails, or when it returns something
   *   that is not a list of scored labels.
   * @throws {Error} When the actor carries no verified email, so the request could not be
   *   attributed to anyone.
   */
  async classify(
    request: ValidatedClassifyImageRequest,
    actor: VerifiedActor
  ): Promise<ClassifyImageResult> {
    const startedAtMs = this.#now();
    const startedAt = new Date(startedAtMs).toISOString();

    const result = await this.#inference.run<Record<string, unknown>, unknown>({
      task: 'classify-image',
      model: request.model,
      runId: request.runId,
      actor,
      input: buildClassifyImageInput(request)
    });

    const scored = extractScoredLabels(result.output, request, this.#logger);
    const labels = rankClassificationLabels(scored, request);

    const logIds = result.logId === undefined ? [] : [result.logId];
    const receipt: RunReceipt = {
      runId: request.runId,
      task: 'classify-image',
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
      labels,
      totalLabels: scored.length,
      image: request.source.facts,
      receipt,
      applied: describeAppliedClassificationControls(request)
    };
  }
}

/**
 * Pulls the scored labels out of a classifier's output.
 *
 * The reviewed model returns a bare array rather than an envelope, so the array itself is the
 * output. Each element is checked rather than trusted: a label that is not a string would render as
 * `undefined` beside a bar, and a score outside 0–1 would render as a bar wider than its track —
 * both of which look like rendering bugs rather than provider output.
 *
 * @param output The provider's raw output.
 * @param request The validated request, used to name the model and run in a diagnostic.
 * @param logger Where a refusal is recorded, so an operator can tell a rejected output from a
 *   provider error.
 * @returns Every usable `{ label, score }` pair, in the order the provider returned them.
 * @throws {ProblemDetailsError} With `502` when the output is not an array, or when no element in
 *   it is a usable scored label.
 */
function extractScoredLabels(
  output: unknown,
  request: ValidatedClassifyImageRequest,
  logger?: DiagnosticLogger
): { label: string; score: number }[] {
  if (!Array.isArray(output)) {
    logger?.error('classify_image_output_unusable', {
      reason: 'unrecognised_shape',
      runId: request.runId,
      model: request.model.id,
      contractVersion: request.model.contractVersion,
      outputType: output === null ? 'null' : typeof output,
      // The keys that *were* present, which is how a changed response envelope is identified
      // immediately. Keys only: a value here could be a label, which is model output about the
      // visitor's picture and does not belong in a Worker log.
      ...(typeof output === 'object' && output !== null
        ? { outputKeys: Object.keys(output as Record<string, unknown>) }
        : {})
    });
    throw classifyFailure();
  }

  const usable: { label: string; score: number }[] = [];
  let skipped = 0;

  for (const element of output) {
    if (typeof element !== 'object' || element === null) {
      skipped += 1;
      continue;
    }

    const candidate = element as { label?: unknown; score?: unknown };
    const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
    const score = candidate.score;

    // A score outside 0–1 is not merely odd: it is the one value this panel renders as a
    // proportion, so an out-of-range number would paint a bar outside its own track.
    const usableScore =
      typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1;

    if (label === '' || !usableScore) {
      skipped += 1;
      continue;
    }

    usable.push({ label, score: score as number });
  }

  // One malformed element out of twenty is a provider quirk: it is logged and skipped so the run
  // still produces a result. Every element malformed is a contract change, and returning an empty
  // ranking would present it to the visitor as "this model recognised nothing".
  if (usable.length === 0) {
    logger?.error('classify_image_output_unusable', {
      reason: output.length === 0 ? 'empty_result' : 'no_usable_labels',
      runId: request.runId,
      model: request.model.id,
      contractVersion: request.model.contractVersion,
      elementCount: output.length
    });
    throw classifyFailure();
  }

  if (skipped > 0) {
    logger?.warn('classify_image_labels_skipped', {
      runId: request.runId,
      model: request.model.id,
      contractVersion: request.model.contractVersion,
      skipped,
      usable: usable.length
    });
  }

  return usable;
}

/**
 * Builds the sanitised error returned when a classification cannot be produced or trusted.
 *
 * @returns A `502` problem-details error.
 */
function classifyFailure(): ProblemDetailsError {
  return new ProblemDetailsError({
    status: 502,
    title: 'The picture could not be classified',
    detail: 'The model did not return a usable list of labels. Try again with another picture.'
  });
}
