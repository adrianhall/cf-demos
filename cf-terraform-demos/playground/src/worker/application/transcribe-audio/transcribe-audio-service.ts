/**
 * @file The Transcribe Audio use case: call the model through the gateway, normalise whatever
 *   envelope it returned into one transcript, record the run, and build the receipt. Thinner than
 *   Read Text's service, and deliberately so. The interesting work — reconciling three unrelated
 *   response envelopes — lives in `domain/transcript-normalisation.ts`, because it is pure logic
 *   over plain data and belongs where it can be exhaustively tested without a service around it.
 *   What remains here is the use case itself: invoke, normalise, persist, report. The one judgement
 *   this file makes is about **what a refusal looks like**. A provider that changed its response
 *   shape and a provider that failed outright both surface as a `502`, so the distinction has to be
 *   recorded in a log rather than inferred from a status code. The log says which envelope was
 *   expected and which keys actually arrived — never the transcript itself, which is the visitor's
 *   content.
 */

import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type { RunReceipt } from '../../../shared/runs';
import type {
  AppliedTranscriptionControls,
  Transcript,
  VerifiedAudioFacts
} from '../../../shared/transcribe-audio';
import { initialCostStatus } from '../../domain/metrics';
import {
  buildTranscribeAudioInput,
  describeAppliedTranscriptionControls,
  type ValidatedTranscribeAudioRequest
} from '../../domain/transcribe-audio';
import { normaliseTranscript } from '../../domain/transcript-normalisation';
import type { DiagnosticLogger } from '../ports/diagnostic-logger-port';
import type { InferencePort, VerifiedActor } from '../ports/inference-port';
import type { RunRepositoryPort } from '../ports/run-repository-port';

/**
 * What a completed Transcribe Audio run produced.
 */
export interface TranscribeAudioResult {
  /**
   * The normalised transcript; see {@link Transcript}.
   */
  transcript: Transcript;
  /**
   * What the server verified about the submitted audio.
   */
  audio: VerifiedAudioFacts;
  /**
   * The run receipt, already persisted for a later metrics lookup.
   */
  receipt: RunReceipt;
  /**
   * The settings the transcript was produced with.
   */
  applied: AppliedTranscriptionControls;
}

/**
 * Dependencies of {@link TranscribeAudioService}.
 */
export interface TranscribeAudioServiceOptions {
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
 * Transcribes audio through AI Gateway.
 */
export class TranscribeAudioService {
  readonly #inference: InferencePort;
  readonly #runs: RunRepositoryPort;
  readonly #now: () => number;
  readonly #logger: DiagnosticLogger | undefined;

  /**
   * Creates the service.
   *
   * @param options Inference port, run repository, and optional clock and logger; see
   *   {@link TranscribeAudioServiceOptions}.
   */
  constructor(options: TranscribeAudioServiceOptions) {
    this.#inference = options.inference;
    this.#runs = options.runs;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
  }

  /**
   * Runs one transcription.
   *
   * A single synchronous call rather than a job. All three reviewed models return the complete
   * transcript within the request — the panel's duration cap keeps that bounded to a few minutes of
   * audio — so the receipt is complete by the time this method returns and the run record is
   * written before it does. There is no window in which the browser holds a receipt the server
   * cannot resolve.
   *
   * @param request A validated request; the type cannot be produced without validation.
   * @param actor The verified Access identity the run is attributed to, used both for gateway
   *   metadata and as the record's owner for the later ownership check.
   * @returns The transcript, verified audio facts, receipt, and applied controls; see
   *   {@link TranscribeAudioResult}.
   * @throws {ProblemDetailsError} With `502` when the provider fails, or when it returns something
   *   with no usable transcript in the envelope its reviewed contract declares.
   * @throws {Error} When the actor carries no verified email, so the request could not be
   *   attributed to anyone.
   */
  async transcribe(
    request: ValidatedTranscribeAudioRequest,
    actor: VerifiedActor
  ): Promise<TranscribeAudioResult> {
    const startedAtMs = this.#now();
    const startedAt = new Date(startedAtMs).toISOString();

    const result = await this.#inference.run<Record<string, unknown>, unknown>({
      task: 'transcribe-audio',
      model: request.model,
      runId: request.runId,
      actor,
      input: buildTranscribeAudioInput(request)
    });

    const outcome = normaliseTranscript(result.output, request.model);

    if (!outcome.ok) {
      // Logged with the expected envelope and the keys that actually arrived, which is how a
      // changed response format is identified immediately. Keys only — a value here could be the
      // transcript, which is the visitor's content and does not belong in a Worker log.
      this.#logger?.error('transcribe_audio_output_unusable', {
        reason: outcome.reason,
        model: request.model.id,
        contractVersion: request.model.contractVersion,
        expectedEnvelope:
          request.model.transcriptionControls?.audioEncoding === 'body-object'
            ? 'results.channels[].alternatives[]'
            : 'text',
        outputKeys:
          typeof result.output === 'object' && result.output !== null
            ? Object.keys(result.output as Record<string, unknown>)
            : [],
        outputType: result.output === null ? 'null' : typeof result.output
      });

      throw transcriptionFailure(outcome.reason);
    }

    const logIds = result.logId === undefined ? [] : [result.logId];
    const receipt: RunReceipt = {
      runId: request.runId,
      task: 'transcribe-audio',
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
      transcript: outcome.transcript,
      audio: request.audioFacts,
      receipt,
      applied: describeAppliedTranscriptionControls(request)
    };
  }
}

/**
 * Builds the sanitised error returned when a transcript cannot be produced or trusted.
 *
 * The detail differs for an empty transcript, because that one is very likely not a fault at all —
 * silent audio, or a recording in a language the model could not make out — and telling a visitor
 * to try a different model would send them to spend credit on the same outcome.
 *
 * @param reason Why normalisation refused the output.
 * @returns A `502` problem-details error.
 */
function transcriptionFailure(reason: string): ProblemDetailsError {
  return new ProblemDetailsError({
    status: 502,
    title: 'The audio could not be transcribed',
    detail:
      reason === 'empty_transcript'
        ? 'The model returned an empty transcript. The recording may be silent, or too quiet for '
          + 'the model to make out any speech.'
        : 'The model did not return a transcript. Try again, or choose a different model for this '
          + 'panel.'
  });
}
