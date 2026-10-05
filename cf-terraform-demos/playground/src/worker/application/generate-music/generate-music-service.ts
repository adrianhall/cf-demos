/**
 * @file The Generate Music use case: call the model through the gateway, read the audio URL out of
 *   whichever envelope came back, retrieve and verify the bytes from an allowlisted host, record
 *   the run, and build the receipt. The shape of this service is the answer to a question the phase
 *   brief asked explicitly: reuse the media-job infrastructure **only** if the selected model is
 *   asynchronous. Neither reviewed model is. Neither schema declares a job handle, a polling
 *   endpoint, or an operation identifier, and both document the result arriving from the call
 *   itself in a `{ state: "Completed", result: { audio } }` envelope. A Workflow would therefore
 *   add a polling protocol, a storage product, and a derived-key scheme to deliver a value the
 *   request already has — so this is a synchronous service like Read Text rather than a job like
 *   Create Video. Generation still takes appreciably longer than a text completion, which the panel
 *   handles with an honest progress state and a cancellable request rather than with durable
 *   execution. Two things it does that an earlier audio panel did not. The result is a **URL rather
 *   than bytes**, so the bytes are fetched server-side under a host allowlist — see
 *   {@link GeneratedAudioPort} for why that is not optional. And the receipt is accompanied by a
 *   **non-token cost estimate** carrying its own unit, because the two models bill in different
 *   units and a figure without its unit would be the exact confusion this panel exists to remove.
 */

import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type {
  AppliedMusicControls,
  GeneratedTrack,
  MusicFailureReason
} from '../../../shared/generate-music';
import type { RunReceipt } from '../../../shared/runs';
import {
  buildGenerateMusicInput,
  describeAppliedMusicControls,
  type ValidatedGenerateMusicRequest
} from '../../domain/generate-music';
import { initialCostStatus } from '../../domain/metrics';
import { classifyProviderFailure } from '../../domain/provider-failures';
import type { DiagnosticLogger } from '../ports/diagnostic-logger-port';
import type { GeneratedAudioPort } from '../ports/generated-audio-port';
import type { InferencePort, VerifiedActor } from '../ports/inference-port';
import type { RunRepositoryPort } from '../ports/run-repository-port';

/**
 * What a completed Generate Music run produced.
 */
export interface GenerateMusicResult {
  /**
   * The verified track; see {@link GeneratedTrack}.
   */
  track: GeneratedTrack;
  /**
   * The run receipt, already persisted for a later metrics lookup.
   */
  receipt: RunReceipt;
  /**
   * The settings the track was generated with, including filled-in model defaults, the billing
   * unit, and the pre-request cost estimate.
   */
  applied: AppliedMusicControls;
}

/**
 * Dependencies of {@link GenerateMusicService}.
 */
export interface GenerateMusicServiceOptions {
  /**
   * Gateway-routed inference, injected by the Worker's composition root.
   */
  inference: InferencePort;
  /**
   * Where run records are kept until their metrics are read.
   */
  runs: RunRepositoryPort;
  /**
   * Safe retrieval of the provider-hosted track.
   */
  audio: GeneratedAudioPort;
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
 * Generates music through AI Gateway.
 */
export class GenerateMusicService {
  readonly #inference: InferencePort;
  readonly #runs: RunRepositoryPort;
  readonly #audio: GeneratedAudioPort;
  readonly #now: () => number;
  readonly #logger: DiagnosticLogger | undefined;

  /**
   * Creates the service.
   *
   * @param options Inference port, run repository, audio retrieval port, and optional clock and
   *   logger; see {@link GenerateMusicServiceOptions}.
   */
  constructor(options: GenerateMusicServiceOptions) {
    this.#inference = options.inference;
    this.#runs = options.runs;
    this.#audio = options.audio;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
  }

  /**
   * Runs one music generation.
   *
   * A single synchronous call, for the reason set out in this file's header: neither reviewed model
   * has a job API, so the receipt is complete by the time this method returns and the run record is
   * written before it does. There is no window in which the browser holds a receipt the server
   * cannot resolve.
   *
   * @param request A validated request; the type cannot be produced without validation.
   * @param actor The verified Access identity the run is attributed to, used both for gateway
   *   metadata and as the record's owner for the later ownership check.
   * @returns The track, receipt, and applied controls; see {@link GenerateMusicResult}.
   * @throws {ProblemDetailsError} With `503` when the account has no prepaid AI Gateway credit,
   *   which is the first thing an unfunded account will see on this panel because every reviewed
   *   music model is third-party; with `502` when the provider fails, returns no usable audio
   *   location, or returns bytes that are not audio this panel will play.
   * @throws {Error} When the actor carries no verified email, so the request could not be
   *   attributed to anyone.
   */
  async generate(
    request: ValidatedGenerateMusicRequest,
    actor: VerifiedActor
  ): Promise<GenerateMusicResult> {
    const startedAtMs = this.#now();
    const startedAt = new Date(startedAtMs).toISOString();

    const result = await this.#inference.run<Record<string, unknown>, unknown>({
      task: 'generate-music',
      model: request.model,
      runId: request.runId,
      actor,
      input: buildGenerateMusicInput(request)
    });

    const reference = extractAudioUrl(result.output, request, this.#logger);
    const track = await this.#audio.fetchTrack(reference, request.controls.outputHosts);

    const logIds = result.logId === undefined ? [] : [result.logId];
    const receipt: RunReceipt = {
      runId: request.runId,
      task: 'generate-music',
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

    return { track, receipt, applied: describeAppliedMusicControls(request) };
  }
}

/**
 * Classifies a failure from this panel into the two outcomes a visitor can act on.
 *
 * A thin wrapper over the shared classifier rather than a second implementation of it, and that is
 * the point: the billing failure this panel will meet most often is the same condition Create Video
 * and Remix Image already classify, so it travels the same path and produces the same `503`. A
 * second classifier would be a second opinion about what counts as a billing failure.
 *
 * @param cause Value thrown by the inference call or the audio retrieval.
 * @returns The reason; `provider-failure` when nothing more specific is recognised.
 */
export function classifyMusicFailure(cause: unknown): MusicFailureReason {
  return classifyProviderFailure(cause);
}

/**
 * Reads the audio URL out of whichever envelope the provider returned.
 *
 * Both reviewed models document `{ state: "Completed", result: { audio: "https://…" } }`, and both
 * nest the field. The flat `{ audio }` shape is accepted too, because the Workers AI binding
 * sometimes unwraps a Unified Catalog envelope before the application sees it and a reader that
 * depended on the nesting would break on the shape its own documentation shows.
 *
 * What is deliberately _not_ done here is any validation of the URL. That belongs to the retrieval
 * port, which owns the host allowlist — a URL check in two places would be two policies, and the
 * weaker one would eventually be the one that ran.
 *
 * @param output The provider's raw output.
 * @param request The request that produced it, used to correlate a log line by run identifier.
 * @param logger Where an unusable envelope is recorded, so a changed provider contract is
 *   diagnosable from the shape rather than guessed at.
 * @returns The audio URL exactly as the provider wrote it.
 * @throws {ProblemDetailsError} With `502` when no usable audio location is present.
 */
function extractAudioUrl(
  output: unknown,
  request: ValidatedGenerateMusicRequest,
  logger?: DiagnosticLogger
): string {
  if (typeof output !== 'object' || output === null) {
    logUnusableOutput(logger, request, 'unrecognised_shape', output);
    throw outputFailure();
  }

  const record = output as Record<string, unknown>;

  const direct = record['audio'];
  if (typeof direct === 'string' && direct.trim() !== '') {
    return direct;
  }

  const nested = record['result'];
  if (typeof nested === 'object' && nested !== null) {
    const audio = (nested as Record<string, unknown>)['audio'];
    if (typeof audio === 'string' && audio.trim() !== '') {
      return audio;
    }
  }

  logUnusableOutput(logger, request, 'missing_or_invalid_audio', record);
  throw outputFailure();
}

/**
 * Records an unusable provider output, by shape only.
 *
 * Reports the output's type and top-level keys and never its content or the signed URL it may
 * carry. A model that changed its response envelope is identified immediately from the key list,
 * and a short-lived credentialed URL does not end up in a log that outlives it.
 *
 * @param logger Logger to write to, when the composition root supplied one.
 * @param request The request whose output was refused.
 * @param reason Which check failed, as a stable slug.
 * @param output The provider's raw output.
 * @returns Nothing; the refusal has been recorded.
 */
function logUnusableOutput(
  logger: DiagnosticLogger | undefined,
  request: ValidatedGenerateMusicRequest,
  reason: string,
  output: unknown
): void {
  logger?.error('generate_music_output_unusable', {
    reason,
    runId: request.runId,
    model: request.model.id,
    contractVersion: request.model.contractVersion,
    outputType: output === null ? 'null' : typeof output,
    ...(typeof output === 'object' && output !== null
      ? { outputKeys: Object.keys(output as Record<string, unknown>) }
      : {})
  });
}

/**
 * Builds the sanitised response-contract failure.
 *
 * @returns A `502` problem-details error carrying no provider text.
 */
function outputFailure(): ProblemDetailsError {
  return new ProblemDetailsError({
    status: 502,
    title: 'The track could not be generated',
    detail:
      'The model did not return a usable audio location. Try again, or choose a different model '
      + 'for this panel.'
  });
}
