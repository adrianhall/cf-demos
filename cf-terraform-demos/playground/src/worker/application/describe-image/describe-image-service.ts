/**
 * @file The Describe Image use case: call the vision model through the gateway, pull the answer out
 *   of whichever field that model uses, record the run, and build the receipt. The normalisation
 *   here is the mirror image of Create Image's. There the provider disagreement was about how bytes
 *   came back; here it is about what the answer is _called_ — LLaVA returns `{ description }` and
 *   Llama 3.2 Vision returns `{ response }`. The field name is read from the reviewed descriptor
 *   rather than guessed by trying keys in turn, so a model whose contract changes produces a
 *   logged, diagnosable refusal instead of quietly matching a different field that happens to hold
 *   a string.
 */

import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type { AppliedVisionControls, VerifiedImageFacts } from '../../../describe-image';
import type { RunReceipt } from '../../../runs';
import {
  buildDescribeImageInput,
  describeAppliedVisionControls,
  type ValidatedDescribeImageRequest
} from '../../domain/describe-image';
import { initialCostStatus } from '../../domain/metrics';
import type { ModelDescriptor } from '../../domain/models';
import type { DiagnosticLogger } from '../ports/diagnostic-logger-port';
import type { InferencePort, VerifiedActor } from '../ports/inference-port';
import type { RunRepositoryPort } from '../ports/run-repository-port';

/**
 * What a completed Describe Image run produced.
 */
export interface DescribeImageResult {
  /**
   * The model's description of the picture.
   */
  description: string;
  /**
   * What the server verified about the submitted picture.
   */
  image: VerifiedImageFacts;
  /**
   * The run receipt, already persisted for a later metrics lookup.
   */
  receipt: RunReceipt;
  /**
   * The settings the description was produced with, including filled-in model defaults.
   */
  applied: AppliedVisionControls;
}

/**
 * Dependencies of {@link DescribeImageService}.
 */
export interface DescribeImageServiceOptions {
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
 * Describes pictures through AI Gateway.
 */
export class DescribeImageService {
  readonly #inference: InferencePort;
  readonly #runs: RunRepositoryPort;
  readonly #now: () => number;
  readonly #logger: DiagnosticLogger | undefined;

  /**
   * Creates the service.
   *
   * @param options Inference port, run repository, optional clock, and logger; see
   *   {@link DescribeImageServiceOptions}.
   */
  constructor(options: DescribeImageServiceOptions) {
    this.#inference = options.inference;
    this.#runs = options.runs;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
  }

  /**
   * Runs one description.
   *
   * A single synchronous call rather than a stream. Both reviewed models can stream, but the answer
   * here is a short paragraph about a picture the visitor is already looking at, so framing it
   * would add machinery without making anything feel faster.
   *
   * @param request A validated request; the type cannot be produced without validation.
   * @param actor The verified Access identity the run is attributed to, used both for gateway
   *   metadata and as the record's owner for the later ownership check.
   * @returns The description, receipt, verified image facts, and applied controls; see
   *   {@link DescribeImageResult}.
   * @throws {ProblemDetailsError} With `502` when the provider fails, or when it returns something
   *   with no usable description in the field its reviewed contract declares.
   * @throws {Error} When the actor carries no verified email, so the request could not be
   *   attributed to anyone.
   */
  async describe(
    request: ValidatedDescribeImageRequest,
    actor: VerifiedActor
  ): Promise<DescribeImageResult> {
    const startedAtMs = this.#now();
    const startedAt = new Date(startedAtMs).toISOString();

    const result = await this.#inference.run<Record<string, unknown>, unknown>({
      task: 'describe-image',
      model: request.model,
      runId: request.runId,
      actor,
      input: buildDescribeImageInput(request)
    });

    const description = extractDescription(result.output, request.model, this.#logger);

    const logIds = result.logId === undefined ? [] : [result.logId];
    const receipt: RunReceipt = {
      runId: request.runId,
      task: 'describe-image',
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
      description,
      image: request.imageFacts,
      receipt,
      applied: describeAppliedVisionControls(request)
    };
  }
}

/**
 * Pulls the description out of a vision model's output.
 *
 * Reads the field named by the reviewed descriptor rather than trying candidates in turn. Guessing
 * would be more forgiving and considerably worse: if a model's contract changed, a fallback would
 * find some other string field and return it as the answer, turning a contract break into a subtly
 * wrong description. Insisting on the declared field makes that same break a logged `502`.
 *
 * @param output The provider's raw output.
 * @param model The reviewed descriptor, which names the field to read.
 * @param logger Where a refusal is recorded, so an operator can tell a rejected output from a
 *   provider error.
 * @returns The trimmed description.
 * @throws {ProblemDetailsError} With `502` when the output is not an object, lacks the declared
 *   field, or holds something empty or not a string there.
 */
function extractDescription(
  output: unknown,
  model: ModelDescriptor,
  logger?: DiagnosticLogger
): string {
  const field = model.descriptionField ?? 'response';

  if (typeof output !== 'object' || output === null) {
    logger?.error('describe_image_output_unusable', {
      reason: 'unrecognised_shape',
      model: model.id,
      contractVersion: model.contractVersion,
      expectedField: field,
      outputType: output === null ? 'null' : typeof output
    });
    throw describeFailure();
  }

  const record = output as Record<string, unknown>;
  const value = record[field];

  if (typeof value !== 'string') {
    logger?.error('describe_image_output_unusable', {
      reason: value === undefined ? 'missing_field' : 'wrong_field_type',
      model: model.id,
      contractVersion: model.contractVersion,
      expectedField: field,
      // The keys that *were* present, which is how a changed response envelope is identified
      // immediately. Keys only — a value here could be the description itself, which is the
      // visitor's content and does not belong in a Worker log.
      outputKeys: Object.keys(record),
      actualType: typeof value
    });
    throw describeFailure();
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    logger?.error('describe_image_output_unusable', {
      reason: 'empty_description',
      model: model.id,
      contractVersion: model.contractVersion,
      expectedField: field
    });
    throw describeFailure();
  }

  return trimmed;
}

/**
 * Builds the sanitised error returned when a description cannot be produced or trusted.
 *
 * @returns A `502` problem-details error.
 */
function describeFailure(): ProblemDetailsError {
  return new ProblemDetailsError({
    status: 502,
    title: 'The picture could not be described',
    detail:
      'The model did not return a description. Try again, or choose a different model for this '
      + 'panel.'
  });
}
