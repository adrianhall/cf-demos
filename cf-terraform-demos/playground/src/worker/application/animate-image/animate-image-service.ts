/**
 * @file The Animate Image use case: start a durable job, report its status, serve the stored
 *   result, and cancel cleanly. Structurally the same shape as the Create Video service, and
 *   deliberately so — it depends on the **same ports** (`MediaJobPort`, `VideoStoragePort`,
 *   `RunRepositoryPort`), derives job identity with the **same keyed derivation**, and decodes
 *   failures with the **same classification**. The panel adds no storage product and no second job
 *   mechanism; what it adds is a task identifier, a different validated request, and an applied-
 *   controls shape carrying the source picture's verified facts. Like Create Video, this service
 *   does not call a model. It starts something that will, and then answers questions about it — so
 *   the gateway log identifiers it reports arrive later, in the finished instance's output, rather
 *   than from a call it made itself. The run record is still written at acceptance rather than on
 *   completion, because a record written only on completion would leave a cancelled or failed job
 *   with no owner on file and the metrics route's ownership check with nothing to compare against.
 */

import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type { AppliedAnimateImageControls } from '../../../shared/animate-image';
import type { MediaJobState, StoredVideo, VideoFailureReason } from '../../../shared/create-video';
import type { RunReceipt } from '../../../shared/runs';
import {
  describeAppliedAnimateControls,
  type ValidatedAnimateImageRequest
} from '../../domain/animate-image';
import { deriveMediaJobId, videoObjectKey } from '../../domain/media-job-identity';
import { initialCostStatus } from '../../domain/metrics';
import { decodeFailureReason } from '../../domain/provider-failures';
import { playableVideoMediaType, VIDEO_SNIFF_BYTES } from '../../domain/video-bytes';
import type { AnimateImageJobOutput } from '../../infrastructure/jobs/animate-image-workflow';
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
export interface AcceptedAnimateJob {
  /**
   * The run identifier the job is addressed by.
   */
  runId: string;
  /**
   * State at acceptance, always `accepted`.
   */
  state: MediaJobState;
  /**
   * The controls the job will run with, including defaults, the verified source facts, and the cost
   * estimate.
   */
  applied: AppliedAnimateImageControls;
}

/**
 * What the status of one job looks like to a route.
 */
export interface AnimateJobStatus {
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
  applied?: AppliedAnimateImageControls;
  /**
   * Why the job failed, as a classification rather than a message.
   */
  reason?: VideoFailureReason;
}

/**
 * Dependencies of {@link AnimateImageService}.
 */
export interface AnimateImageServiceOptions {
  /**
   * Durable job execution, backed by this panel's Workflow.
   */
  jobs: MediaJobPort;
  /**
   * Where generated video is kept — the same bucket Create Video uses, under the same prefix.
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
 * Starts and reports on image-animation jobs.
 */
export class AnimateImageService {
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
   *   see {@link AnimateImageServiceOptions}.
   */
  constructor(options: AnimateImageServiceOptions) {
    this.#jobs = options.jobs;
    this.#storage = options.storage;
    this.#runs = options.runs;
    this.#jobIdKey = options.jobIdKey;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
  }

  /**
   * Accepts an animation request and starts the durable job.
   *
   * The body is carried into the job as-is, including the base64 picture, and re-validated there.
   * That is what keeps Phase 8's Finding 10 true for this panel: the picture travels in the request
   * and into instance state, and this demo writes it to no storage product of its own. It does
   * still reach a third-party provider, so the panel tells a visitor to assume it is logged in the
   * same way a prompt is, rather than claiming a retention guarantee that is not this demo's to
   * give.
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
    request: ValidatedAnimateImageRequest,
    body: Record<string, unknown>,
    actor: VerifiedActor
  ): Promise<AcceptedAnimateJob> {
    const jobId = await deriveMediaJobId(actor.email, request.runId, this.#jobIdKey);
    const videoKey = videoObjectKey(jobId);

    // Written before the job starts, so a job that fails immediately still has an owner on file for
    // the metrics route's ownership check.
    await this.#runs.save({
      runId: request.runId,
      task: 'animate-image',
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
      this.#logger?.warn('animate_image_job_start_failed', {
        runId: request.runId,
        model: request.model.id,
        contractVersion: request.model.contractVersion,
        cause: describeCause(cause)
      });
      throw new ProblemDetailsError({
        status: 409,
        title: 'That picture is already being animated',
        detail: 'A job for this run already exists. Start a new run to animate another picture.'
      });
    }

    return {
      runId: request.runId,
      state: 'accepted',
      applied: describeAppliedAnimateControls(request)
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
   * @throws {Error} When the job identifier cannot be derived, which indicates an unbound or empty
   *   `ACCESS_AUD` rather than a bad request, or when the job port itself fails.
   */
  async status(runId: string, actor: VerifiedActor): Promise<AnimateJobStatus | undefined> {
    // Each stage is wrapped separately rather than under one `try`, so a failure names the stage it
    // came from — the same lesson Create Video's status path records.
    let jobId: string;
    try {
      jobId = await deriveMediaJobId(actor.email, runId, this.#jobIdKey);
    } catch (cause) {
      // Derivation needs a non-empty email, run id, and key. An empty `ACCESS_AUD` binding would
      // fail here on every poll — a deployment fault, not a request fault.
      this.#logger?.error('animate_image_job_id_derivation_failed', {
        runId,
        hasKey: this.#jobIdKey !== '',
        ...describeThrown(cause)
      });
      throw cause;
    }

    let status;
    try {
      status = await this.#jobs.status(jobId);
    } catch (cause) {
      this.#logger?.error('animate_image_job_status_failed', { runId, ...describeThrown(cause) });
      throw cause;
    }

    if (status === undefined) {
      return undefined;
    }

    if (status.state !== 'completed') {
      if (status.state !== 'failed') {
        return { runId, state: status.state };
      }

      // The Workflow classified the cause before throwing, because the boundary records only
      // `{ name, message }` and would otherwise have discarded it. A message this demo did not
      // write is a provider's own text and is reported as a generic provider failure rather than
      // shown. `typeof` rather than `!== undefined`, because the binding may report `null` here.
      const reason =
        typeof status.error === 'string'
          ? (decodeFailureReason(status.error) ?? 'provider-failure')
          : 'provider-failure';

      // Logged at the panel level so a billing failure is searchable by run id without reading the
      // Workflow's own observability. Every model in this panel is third-party, so this is the
      // expected failure on an account without prepaid credit rather than an exotic one.
      this.#logger?.warn('animate_image_run_failed', { runId, reason });

      return { runId, state: 'failed', reason };
    }

    // Validated rather than cast: a Workflow's `output` is `unknown` by contract, and the binding
    // returns `null` for an instance with no output. Dereferencing that would throw a `TypeError`
    // surfacing as an opaque `500`.
    const output = asJobOutput(status.output);
    if (output === undefined) {
      this.#logger?.error('animate_image_job_output_unusable', {
        runId,
        // The shape that arrived, so a changed output contract is diagnosable from one line. Keys
        // only: a value could carry the motion prompt.
        outputType: status.output === null ? 'null' : typeof status.output,
        ...(typeof status.output === 'object' && status.output !== null
          ? { outputKeys: Object.keys(status.output as Record<string, unknown>) }
          : {})
      });
      return { runId, state: 'failed', reason: 'provider-failure' };
    }

    const logIds = output.logIds;
    const receipt: RunReceipt = {
      runId,
      task: 'animate-image',
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
      task: 'animate-image',
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
      this.#logger?.error('animate_image_stored_bytes_unusable', {
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
   * object, and leaving it behind would be an orphan nothing collects until the scheduled reaper
   * exists.
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
 * Narrows a Workflow instance's output to this panel's shape.
 *
 * A Workflow's `output` is `unknown` by contract, so it is checked rather than cast. Every field
 * the receipt reads is verified, including the nested `applied.source` facts the side-by-side
 * result layout depends on — a half-populated output would otherwise throw at the point of use
 * rather than here.
 *
 * @param value The instance's recorded output.
 * @returns The output, or `undefined` when it is absent or not the expected shape.
 */
function asJobOutput(value: unknown): AnimateImageJobOutput | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const candidate = value as Partial<AnimateImageJobOutput>;
  const applied = candidate.applied;

  if (
    !Array.isArray(candidate.logIds)
    || typeof candidate.byteLength !== 'number'
    || typeof candidate.elapsedMs !== 'number'
    || typeof applied !== 'object'
    || applied === null
    || typeof applied.model !== 'string'
    // Checked because the result layout renders the source picture's facts beside the video. An
    // output missing them would render an empty half of a side-by-side comparison.
    || typeof applied.source !== 'object'
    || applied.source === null
  ) {
    return undefined;
  }

  return candidate as AnimateImageJobOutput;
}

/**
 * Describes a thrown value for a structured log line.
 *
 * Name, message, stack, and one level of wrapped cause. The stack is the field that makes an
 * unexpected throw locatable, and one level of `cause` is where a binding's real complaint usually
 * sits.
 *
 * @param cause The thrown value.
 * @returns Structured fields naming the failure.
 */
function describeThrown(cause: unknown): Record<string, unknown> {
  return {
    errorName: cause instanceof Error ? cause.name : typeof cause,
    errorMessage: cause instanceof Error ? cause.message : String(cause),
    ...(cause instanceof Error && cause.stack !== undefined ? { stack: cause.stack } : {}),
    ...(cause instanceof Error && cause.cause instanceof Error
      ? { cause: `${cause.cause.name}: ${cause.cause.message}` }
      : {})
  };
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
