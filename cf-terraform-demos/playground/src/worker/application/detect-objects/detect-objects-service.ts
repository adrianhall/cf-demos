import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type { VerifiedImageFacts } from '../../../shared/describe-image';
import type { Detection } from '../../../shared/detect-objects';
import type { RunReceipt } from '../../../shared/runs';
import {
  buildDetectObjectsInput,
  describeAppliedDetectionControls,
  type ValidatedDetectObjectsRequest
} from '../../domain/detect-objects';
import { initialCostStatus } from '../../domain/metrics';
import type { DiagnosticLogger } from '../ports/diagnostic-logger-port';
import type { InferencePort, VerifiedActor } from '../ports/inference-port';
import type { RunRepositoryPort } from '../ports/run-repository-port';
/**
 * Completed object-localisation result.
 */
export interface DetectObjectsResult {
  /**
   * Valid boxes.
   */ detections: Detection[];
  /**
   * Source image facts.
   */ image: VerifiedImageFacts;
  /**
   * Stored run receipt.
   */ receipt: RunReceipt;
  /**
   * Applied inputs.
   */ applied: ReturnType<typeof describeAppliedDetectionControls>;
}
/**
 * Dependencies for {@link DetectObjectsService}.
 */
export interface DetectObjectsServiceOptions {
  /**
   * Gateway inference port.
   */ inference: InferencePort;
  /**
   * Run ledger.
   */ runs: RunRepositoryPort;
  /**
   * Testable clock.
   */ now?: () => number;
  /**
   * Privacy-safe diagnostics.
   */ logger?: DiagnosticLogger;
}
/**
 * Calls Moondream's structured detection mode.
 */
export class DetectObjectsService {
  readonly #inference: InferencePort;
  readonly #runs: RunRepositoryPort;
  readonly #now: () => number;
  readonly #logger: DiagnosticLogger | undefined;
  /**
   * @param options Injected ports and diagnostics.
   */ constructor(options: DetectObjectsServiceOptions) {
    this.#inference = options.inference;
    this.#runs = options.runs;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
  }
  /**
   * Runs object localisation. @param request Validated request. @param actor Verified Access actor.
   *
   * @returns Validated response and receipt. @throws {ProblemDetailsError} When the provider
   *   violates its structured contract.
   */
  async detect(
    request: ValidatedDetectObjectsRequest,
    actor: VerifiedActor
  ): Promise<DetectObjectsResult> {
    const startedAtMs = this.#now();
    const inference = await this.#inference.run<Record<string, unknown>, unknown>({
      task: 'detect-objects',
      model: request.model,
      runId: request.runId,
      actor,
      input: buildDetectObjectsInput(request)
    });
    const detections = normaliseDetections(inference.output, request, this.#logger);
    const logIds = inference.logId === undefined ? [] : [inference.logId];
    const receipt: RunReceipt = {
      runId: request.runId,
      task: 'detect-objects',
      model: request.model.id,
      gatewayRouted: true,
      logIds,
      status: 'completed',
      costStatus: initialCostStatus(logIds),
      elapsedMs: this.#now() - startedAtMs,
      startedAt: new Date(startedAtMs).toISOString()
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
      detections,
      image: request.source.facts,
      receipt,
      applied: describeAppliedDetectionControls(request)
    };
  }
}
/**
 * Normalises only valid normalised boxes from the documented response envelope. @param output
 * Provider output. @param request Request context. @param logger Diagnostics sink. @returns
 * Geometry-safe regions. @throws {ProblemDetailsError} When `objects` is missing/null or a box is
 * malformed.
 */
export function normaliseDetections(
  output: unknown,
  request: ValidatedDetectObjectsRequest,
  logger?: DiagnosticLogger
): Detection[] {
  const objects =
    typeof output === 'object' && output !== null && 'result' in output
      ? (output as { result?: { objects?: unknown } }).result?.objects
      : undefined;
  if (!Array.isArray(objects)) {
    logger?.error('detect_objects_output_unusable', {
      runId: request.runId,
      model: request.model.id,
      reason: 'objects_missing_or_not_array'
    });
    throw failure();
  }
  return objects.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw failure();
    const box = entry as Record<string, unknown>;
    const values = [box.x_min, box.y_min, box.x_max, box.y_max];
    if (!values.every((value) => typeof value === 'number' && Number.isFinite(value)))
      throw failure();
    const [xMin, yMin, xMax, yMax] = values as number[];
    if (xMax <= xMin || yMax <= yMin || xMin < 0 || yMin < 0 || xMax > 1 || yMax > 1)
      throw failure();
    return {
      index: index + 1,
      label: request.target,
      xMin,
      yMin,
      xMax,
      yMax,
      region: regionFor(xMin, yMin, xMax, yMax)
    };
  });
}
/**
 * Creates a textual region description. @param xMin Left edge. @param yMin Top edge. @param xMax
 * Right edge. @param yMax Bottom edge. @returns Region phrase.
 */
function regionFor(xMin: number, yMin: number, xMax: number, yMax: number): string {
  const x = (xMin + xMax) / 2;
  const y = (yMin + yMax) / 2;
  const horizontal = x < 1 / 3 ? 'left' : x > 2 / 3 ? 'right' : 'centre';
  const vertical = y < 1 / 3 ? 'upper' : y > 2 / 3 ? 'lower' : 'centre';
  return horizontal === 'centre' && vertical === 'centre'
    ? 'centre'
    : `${vertical === 'centre' ? '' : `${vertical} `}${horizontal}`.trim();
}
/**
 * @returns Sanitised provider-contract failure.
 */
function failure(): ProblemDetailsError {
  return new ProblemDetailsError({
    status: 502,
    title: 'The picture could not be analysed',
    detail: 'The model did not return usable object regions. Try again with another picture.'
  });
}
