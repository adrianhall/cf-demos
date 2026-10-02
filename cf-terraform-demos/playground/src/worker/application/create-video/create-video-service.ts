/**
 * @file The Create Video use case: start a durable job, report its status, serve the stored result,
 *   and cancel cleanly. Unlike every service before it, this one does not call a model. It starts
 *   something that will, and then answers questions about it. That shift is why the panel needed
 *   new infrastructure, and it has one consequence worth stating plainly: the gateway call happens
 *   inside the Workflow, so the gateway log identifiers this service reports arrive _later_, in the
 *   finished instance's output, rather than from a call it made itself. The run record is still
 *   written here, at acceptance, rather than when the job finishes. A record written only on
 *   completion would leave a cancelled or failed job with no owner on file, and the metrics route's
 *   ownership check would have nothing to compare against.
 */

import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type {
  AppliedVideoControls,
  MediaJobState,
  StoredVideo
} from '../../../shared/create-video';
import type { RunReceipt } from '../../../shared/runs';
import {
  describeAppliedVideoControls,
  type ValidatedCreateVideoRequest
} from '../../domain/create-video';
import { deriveMediaJobId, videoObjectKey } from '../../domain/media-job-identity';
import { initialCostStatus } from '../../domain/metrics';
import { playableVideoMediaType } from '../../domain/video-bytes';
import { VIDEO_SNIFF_BYTES } from '../../domain/video-bytes';
import type { CreateVideoJobOutput } from '../../infrastructure/jobs/create-video-workflow';
import type { DiagnosticLogger } from '../ports/diagnostic-logger-port';
import type { VerifiedActor } from '../ports/inference-port';
import type { MediaJobPort } from '../ports/media-job-port';
import type { RunRepositoryPort } from '../ports/run-repository-port';
import type {
  StoredVideoBody,
  VideoByteRange,
  VideoStoragePort
} from '../ports/video-storage-port';

/**
 * What accepting a job produced.
 */
export interface AcceptedVideoJob {
  /**
   * The run identifier the job is addressed by.
   */
  runId: string;
  /**
   * State at acceptance, always `accepted`.
   */
  state: MediaJobState;
  /**
   * The controls the job will run with, including defaults and the cost estimate.
   */
  applied: AppliedVideoControls;
}

/**
 * What the status of one job looks like to a route.
 */
export interface VideoJobStatus {
  /**
   * The run identifier.
   */
  runId: string;
  /**
   * Current state.
   */
  state: MediaJobState;
  /**
   * The stored video, present once completed.
   */
  video?: StoredVideo;
  /**
   * The run receipt, present once a terminal state is reached and the job recorded its logs.
   */
  receipt?: RunReceipt;
  /**
   * The controls the job ran with.
   */
  applied?: AppliedVideoControls;
  /**
   * Visitor-facing failure explanation.
   */
  error?: string;
}

/**
 * Dependencies of {@link CreateVideoService}.
 */
export interface CreateVideoServiceOptions {
  /**
   * Durable job execution.
   */
  jobs: MediaJobPort;
  /**
   * Where generated video is kept.
   */
  storage: VideoStoragePort;
  /**
   * Where run records are kept until their metrics are read.
   */
  runs: RunRepositoryPort;
  /**
   * Keying material for job-identifier derivation. The Access audience tag; see
   * `domain/media-job-identity.ts` for why that is the right choice.
   */
  jobIdKey: string;
  /**
   * Clock reading epoch milliseconds, injected so tests need not wait.
   */
  now?: () => number;
  /**
   * Where failures and refusals are recorded.
   */
  logger?: DiagnosticLogger;
}

/**
 * Starts and reports on video generation jobs.
 */
export class CreateVideoService {
  readonly #jobs: MediaJobPort;
  readonly #storage: VideoStoragePort;
  readonly #runs: RunRepositoryPort;
  readonly #jobIdKey: string;
  readonly #now: () => number;
  readonly #logger: DiagnosticLogger | undefined;

  /**
   * Creates the service.
   *
   * @param options Job port, storage, run repository, keying material, optional clock and logger;
   *   see {@link CreateVideoServiceOptions}.
   */
  constructor(options: CreateVideoServiceOptions) {
    this.#jobs = options.jobs;
    this.#storage = options.storage;
    this.#runs = options.runs;
    this.#jobIdKey = options.jobIdKey;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
  }

  /**
   * Accepts a generation request and starts the durable job.
   *
   * @param request A validated request; the type cannot be produced without validation.
   * @param body The original request body, carried into the job and re-validated there.
   * @param actor The verified Access identity the run is attributed to.
   * @returns The accepted job's identifier, state, and applied controls.
   * @throws {ProblemDetailsError} With `409` when a job already exists for this identity and run
   *   identifier, which means the browser reused a run identifier rather than that two visitors
   *   collided — the derivation makes a cross-identity collision impossible.
   * @throws {Error} When the actor carries no verified email, so the job could not be attributed.
   */
  async accept(
    request: ValidatedCreateVideoRequest,
    body: Record<string, unknown>,
    actor: VerifiedActor
  ): Promise<AcceptedVideoJob> {
    const jobId = await deriveMediaJobId(actor.email, request.runId, this.#jobIdKey);
    const videoKey = videoObjectKey(jobId);

    // Written before the job starts, so a job that fails immediately still has an owner on file for
    // the metrics route's ownership check.
    await this.#runs.save({
      runId: request.runId,
      task: 'create-video',
      model: request.model.id,
      ownerEmail: actor.email,
      logIds: [],
      status: 'running',
      startedAtMs: this.#now()
    });

    try {
      await this.#jobs.start(jobId, {
        request: body,
        actorEmail: actor.email,
        actorSub: actor.sub,
        videoKey
      });
    } catch (cause) {
      this.#logger?.warn('create_video_job_start_failed', {
        runId: request.runId,
        model: request.model.id,
        contractVersion: request.model.contractVersion,
        cause: describeCause(cause)
      });
      throw new ProblemDetailsError({
        status: 409,
        title: 'That video is already being generated',
        detail: 'A job for this run already exists. Start a new run to generate another video.'
      });
    }

    return {
      runId: request.runId,
      state: 'accepted',
      applied: describeAppliedVideoControls(request)
    };
  }

  /**
   * Reports the status of one job.
   *
   * The job identifier is recomputed from the identity on _this_ request, which is the whole of the
   * ownership check: a visitor asking after another's run derives a different identifier, finds
   * nothing, and is told the job does not exist rather than that they may not see it.
   *
   * @param runId Run identifier from the request.
   * @param actor The verified Access identity making the request.
   * @returns The job's status, or `undefined` when no such job exists for this identity.
   */
  async status(runId: string, actor: VerifiedActor): Promise<VideoJobStatus | undefined> {
    const jobId = await deriveMediaJobId(actor.email, runId, this.#jobIdKey);
    const status = await this.#jobs.status(jobId);
    if (status === undefined) {
      return undefined;
    }

    if (status.state !== 'completed') {
      return {
        runId,
        state: status.state,
        // A provider's own error text can name internal hosts and request identifiers, so the
        // visitor sees a fixed explanation. The instance's recorded error is still available in the
        // Workflow's own observability for whoever is diagnosing it.
        ...(status.state === 'failed'
          ? {
              error:
                'The video could not be generated. The model or the provider reported a failure; nothing was charged for a video you did not receive unless the model had already completed it.'
            }
          : {})
      };
    }

    const output = status.output as CreateVideoJobOutput | undefined;
    if (output === undefined) {
      this.#logger?.error('create_video_job_output_missing', { runId });
      return { runId, state: 'failed', error: 'The finished video could not be located.' };
    }

    const logIds = output.logIds;
    const receipt: RunReceipt = {
      runId,
      task: 'create-video',
      model: output.applied.model,
      gatewayRouted: true,
      logIds,
      status: 'completed',
      costStatus: initialCostStatus(logIds),
      elapsedMs: output.elapsedMs,
      startedAt: new Date(this.#now() - output.elapsedMs).toISOString()
    };

    // Re-saved now that the job has finished and its gateway logs are known. The record written at
    // acceptance had no log identifiers, because the gateway call had not happened yet.
    await this.#runs.save({
      runId,
      task: 'create-video',
      model: output.applied.model,
      ownerEmail: actor.email,
      logIds,
      status: 'completed',
      startedAtMs: this.#now() - output.elapsedMs
    });

    return {
      runId,
      state: 'completed',
      video: {
        mediaType: output.mediaType === 'video/webm' ? 'video/webm' : 'video/mp4',
        byteLength: output.byteLength
      },
      receipt,
      applied: output.applied
    };
  }

  /**
   * Serves a stored video, optionally a byte range of it.
   *
   * The bytes are verified before the first one is served, independently of whatever verified them
   * at store time. That is not redundant: the read path is the one facing a browser from this
   * demo's authenticated origin, and an object trusted merely because something stored it earlier
   * would be trusted on the strength of a decision made elsewhere.
   *
   * @param runId Run identifier from the request.
   * @param actor The verified Access identity making the request.
   * @param range Byte range the browser asked for, or `undefined` for the whole video.
   * @returns The body and metadata, or `undefined` when no such video exists for this identity.
   * @throws {ProblemDetailsError} With `502` when the stored bytes are not a playable video, which
   *   indicates something wrote an object this demo would not have stored.
   */
  async read(
    runId: string,
    actor: VerifiedActor,
    range?: VideoByteRange
  ): Promise<StoredVideoBody | undefined> {
    const jobId = await deriveMediaJobId(actor.email, runId, this.#jobIdKey);
    const key = videoObjectKey(jobId);

    const head = await this.#storage.readHead(key, VIDEO_SNIFF_BYTES);
    if (head === undefined) {
      return undefined;
    }

    const verified = playableVideoMediaType(head);
    if (verified === undefined) {
      this.#logger?.error('create_video_stored_bytes_unusable', {
        runId,
        // The key is derived from a verified email, so it is identifying and stays out of the log
        // for the same reason the email does. The run identifier is enough to find this.
        headByteLength: head.length
      });
      throw new ProblemDetailsError({
        status: 502,
        title: 'The stored video could not be served',
        detail: 'The stored file is not a video this demo will play.'
      });
    }

    return await this.#storage.read(key, range);
  }

  /**
   * Cancels a job and deletes anything it had already stored.
   *
   * Deletion runs whether or not an instance was found, because the two can race: a job that
   * finished between the browser deciding to cancel and this call arriving has already written its
   * object, and leaving it behind would be exactly the orphan the phase-18 reaper exists to avoid
   * needing.
   *
   * @param runId Run identifier from the request.
   * @param actor The verified Access identity making the request.
   * @returns `true` when a job existed and was terminated.
   */
  async cancel(runId: string, actor: VerifiedActor): Promise<boolean> {
    const jobId = await deriveMediaJobId(actor.email, runId, this.#jobIdKey);
    const cancelled = await this.#jobs.cancel(jobId);
    await this.#storage.delete(videoObjectKey(jobId));
    return cancelled;
  }
}

/**
 * Renders an unknown thrown value readably for a log line.
 *
 * `String(someObject)` yields `[object Object]`, which occupies a log line while saying nothing, so
 * an `Error` is described by name and message and anything else is coerced deliberately.
 *
 * @param cause The thrown value.
 * @returns A readable description.
 */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  return typeof cause === 'string' ? cause : JSON.stringify(cause);
}
