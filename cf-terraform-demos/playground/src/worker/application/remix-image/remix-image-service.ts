/**
 * @file Remix Image use case: gateway-routed FLUX.2 editing and immediate safe retrieval of its
 *   short-lived generated-image URL.
 */
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type { VerifiedImageFacts } from '../../../describe-image';
import type { GeneratedImage } from '../../../images';
import type { AppliedRemixImageControls } from '../../../remix-image';
import type { RunReceipt } from '../../../runs';
import { initialCostStatus } from '../../domain/metrics';
import {
  buildRemixImageInput,
  describeAppliedRemixControls,
  type ValidatedRemixImageRequest
} from '../../domain/remix-image';
import type { DiagnosticLogger } from '../ports/diagnostic-logger-port';
import type { GeneratedMediaPort } from '../ports/generated-media-port';
import type { InferencePort, VerifiedActor } from '../ports/inference-port';
import type { RunRepositoryPort } from '../ports/run-repository-port';

/**
 * Completed Remix Image output.
 */
export interface RemixImageResult {
  /**
   * Server-fetched and signature-verified transformed image.
   */
  image: GeneratedImage;
  /**
   * Source facts verified before inference.
   */
  source: VerifiedImageFacts;
  /**
   * Saved gateway receipt.
   */
  receipt: RunReceipt;
  /**
   * Applied model controls.
   */
  applied: AppliedRemixImageControls;
}

/**
 * Dependencies for {@link RemixImageService}.
 */
export interface RemixImageServiceOptions {
  /**
   * Gateway-routed inference port.
   */
  inference: InferencePort;
  /**
   * Caller-owned run store.
   */
  runs: RunRepositoryPort;
  /**
   * Safe provider-result retrieval port.
   */
  media: GeneratedMediaPort;
  /**
   * Injectable clock for deterministic tests.
   */
  now?: () => number;
  /**
   * Safe diagnostic logger for response-contract failures.
   */
  logger?: DiagnosticLogger;
}

/**
 * Runs reviewed reference-image models through AI Gateway.
 */
export class RemixImageService {
  readonly #inference: InferencePort;
  readonly #runs: RunRepositoryPort;
  readonly #media: GeneratedMediaPort;
  readonly #now: () => number;
  readonly #logger: DiagnosticLogger | undefined;

  /**
   * @param options Service dependencies.
   */
  constructor(options: RemixImageServiceOptions) {
    this.#inference = options.inference;
    this.#runs = options.runs;
    this.#media = options.media;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
  }

  /**
   * Edits one validated source image and retrieves the resulting signed URL immediately.
   *
   * @param request Validated narrow Remix Image request.
   * @param actor Verified Access identity for ownership and gateway attribution.
   * @returns Verified transient output, source facts, receipt, and applied controls.
   * @throws {ProblemDetailsError} When inference fails, the output contract is broken, or the
   *   provider-hosted media cannot be safely retrieved.
   */
  async remix(
    request: ValidatedRemixImageRequest,
    actor: VerifiedActor
  ): Promise<RemixImageResult> {
    const startedAtMs = this.#now();
    const result = await this.#inference.run<Record<string, unknown>, unknown>({
      task: 'remix-image',
      model: request.model,
      runId: request.runId,
      actor,
      input: buildRemixImageInput(request)
    });
    const image = await normaliseRemixOutput(result.output, request, this.#media, this.#logger);
    const logIds = result.logId === undefined ? [] : [result.logId];
    const receipt: RunReceipt = {
      runId: request.runId,
      task: 'remix-image',
      model: request.model.id,
      gatewayRouted: request.model.remixImageControls?.inputAdapter !== 'flux-multipart',
      logIds,
      status: 'completed',
      costStatus:
        request.model.remixImageControls?.inputAdapter === 'flux-multipart'
          ? 'not-applicable'
          : initialCostStatus(logIds),
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
      image,
      source: request.source.facts,
      receipt,
      applied: describeAppliedRemixControls(request)
    };
  }
}

/**
 * Normalises the selected model's explicitly reviewed output envelope.
 */
async function normaliseRemixOutput(
  output: unknown,
  request: ValidatedRemixImageRequest,
  media: GeneratedMediaPort,
  logger?: DiagnosticLogger
): Promise<GeneratedImage> {
  if (typeof output !== 'object' || output === null) {
    logBrokenOutput(logger, request, 'unrecognised_shape', output);
    throw outputFailure();
  }
  const record = output as Record<string, unknown>;
  const controls = request.model.remixImageControls;
  if (controls === undefined) {
    throw outputFailure();
  }

  // All three reviewed models expose `image`; FLUX.2 Dev returns raw base64 while the Unified
  // Catalog adapters return an HTTPS URL or data URI. Keeping this distinction in the descriptor's
  // input adapter avoids guessing from string contents when another model is added.
  const value = record['image'];
  if (typeof value !== 'string' || value.trim() === '') {
    logBrokenOutput(logger, request, 'missing_or_invalid_image', record);
    throw outputFailure();
  }

  const reference =
    controls.inputAdapter === 'flux-multipart' ? `data:image/png;base64,${value}` : value;
  return media.fetchImage(reference, controls.outputHosts);
}

/**
 * Records output shape only, never output content or signed URLs.
 */
function logBrokenOutput(
  logger: DiagnosticLogger | undefined,
  request: ValidatedRemixImageRequest,
  reason: string,
  output: unknown
): void {
  logger?.error('remix_image_output_unusable', {
    reason,
    runId: request.runId,
    outputType: output === null ? 'null' : typeof output,
    ...(typeof output === 'object' && output !== null
      ? { outputKeys: Object.keys(output as Record<string, unknown>) }
      : {})
  });
}

/**
 * Builds the sanitised FLUX response-contract failure.
 */
function outputFailure(): ProblemDetailsError {
  return new ProblemDetailsError({
    status: 502,
    title: 'The image could not be remixed',
    detail: 'The model did not return a usable generated-image location. Try again.'
  });
}
