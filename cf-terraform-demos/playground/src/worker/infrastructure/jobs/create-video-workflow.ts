/**
 * @file The Workflow that generates a video and stores it. This exists because of where the
 *   fragility actually is. An HTTP-triggered Worker has no wall-clock duration limit while the
 *   client stays connected, so a multi-minute render would fit inside a request — but when the
 *   visitor closes the tab the request is cancelled and `waitUntil()` extends execution by only
 *   about thirty seconds. A render abandoned halfway has still been _paid for_, and a panel whose
 *   subject is honest cost cannot casually discard dollars. Durable execution is the fix: the
 *   Workflow survives the connection that started it. A Workflow instance is also, usefully, a job
 *   record. It reports `queued`/`running`/`complete`/ `errored`/`terminated`, carries its output,
 *   and retains terminal state for days — so this panel adds no D1 table and no KV namespace. A
 *   second store would mean two sources of truth for one job status, and the predictable result is
 *   a job that one of them calls finished while the other calls it running. **The step boundary is
 *   a cost decision, not a tidiness one.** Workflow steps retry by default, which is normally the
 *   point of them. Here the inference step can cost several dollars, so a default retry policy
 *   would silently multiply the charge for one transient provider fault. The inference step
 *   therefore runs with retries disabled and the cheap, idempotent fetch-and-store step keeps them.
 *   That split is the reason there are two steps at all.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type { AppliedVideoControls } from '../../../shared/create-video';
import type { DiagnosticLogger } from '../../application/ports/diagnostic-logger-port';
import {
  buildCreateVideoInput,
  describeAppliedVideoControls,
  validateCreateVideoRequest
} from '../../domain/create-video';
import { VIDEO_INFERENCE_STEP_POLICY, VIDEO_STORAGE_STEP_POLICY } from '../../domain/media-job';
import { classifyProviderFailure, encodeFailureReason } from '../../domain/provider-failures';
import { GatewayInferenceClient } from '../ai/gateway-inference-client';
import { ProviderVideoClient } from '../media/provider-video-client';
import { R2VideoStorage } from '../media/r2-video-storage';

/**
 * What the Worker passes to a new Workflow instance.
 *
 * The verified email is included because the Workflow has to attribute its own gateway call, and a
 * Workflow step runs long after the request that started it — so the identity cannot be re-derived
 * from a JWT at that point. It travels as a parameter and is used for gateway metadata only; it is
 * never written to a log line, exactly as in the request path.
 *
 * The request is carried as the raw body rather than a validated object, and re-validated inside
 * the Workflow. Workflow parameters are serialised, so a validated type's guarantees do not survive
 * the trip: re-validating means the thing the Workflow acts on has actually passed the same checks
 * the route applied, rather than merely having the shape of something that once did.
 */
export interface CreateVideoJobParams {
  /**
   * The original, untrusted request body, re-validated on arrival.
   */
  request: Record<string, unknown>;
  /**
   * Verified email the gateway call is attributed to.
   */
  actorEmail: string;
  /**
   * Verified subject identifier from the Access JWT.
   */
  actorSub: string;
  /**
   * Storage key the finished video is written to, derived by the route from the verified identity.
   */
  videoKey: string;
}

/**
 * What a finished instance reports as its output.
 *
 * Read by the status route to describe a completed job. It carries metadata only — never bytes,
 * which would breach the 1 MiB step-result limit and would be pointless besides, since the video is
 * in storage and served from there.
 */
export interface CreateVideoJobOutput {
  /**
   * Media type established by sniffing the provider's bytes.
   */
  mediaType: string;
  /**
   * Stored size in bytes.
   */
  byteLength: number;
  /**
   * Gateway log identifiers for the run's inference calls, so the status route can resolve cost.
   */
  logIds: string[];
  /**
   * Milliseconds the generation took, measured across the inference step.
   */
  elapsedMs: number;
  /**
   * The controls the video was generated with, so a job polled from a fresh tab can describe
   * itself.
   */
  applied: AppliedVideoControls;
}

/**
 * Bindings the Workflow needs.
 *
 * A narrower set than the Worker's: a Workflow serves no requests, so it has no use for Access
 * configuration or the asset store.
 */
export interface CreateVideoWorkflowEnv {
  /**
   * Workers AI binding, used only through the central gateway client.
   */
  AI: Ai;
  /**
   * Identifier of the Terraform-managed AI Gateway.
   */
  AI_GATEWAY_ID: string;
  /**
   * Bucket generated video is stored in.
   */
  VIDEO_BUCKET: R2Bucket;
}

/**
 * Generates one video and stores it.
 */
export class CreateVideoWorkflow extends WorkflowEntrypoint<
  CreateVideoWorkflowEnv,
  CreateVideoJobParams
> {
  /**
   * Runs the generation.
   *
   * @param event The instance's parameters; see {@link CreateVideoJobParams}.
   * @param step Workflow step API, used to make each stage durable.
   * @returns The stored video's metadata and the run's gateway log identifiers; see
   *   {@link CreateVideoJobOutput}.
   * @throws {ProblemDetailsError} When validation refuses the carried request, the provider fails,
   *   the provider's URL is unapproved, or the returned bytes are not a playable video. A thrown
   *   error puts the instance in `errored`, which the status route reports as a failed job.
   */
  async run(
    event: WorkflowEvent<CreateVideoJobParams>,
    step: WorkflowStep
  ): Promise<CreateVideoJobOutput> {
    const { request, actorEmail, actorSub, videoKey } = event.payload;

    // Re-validated rather than trusted: parameters crossed a serialisation boundary, so this is the
    // first point inside the Workflow where the request's guarantees actually hold.
    const validated = validateCreateVideoRequest(request);
    const actor = { email: actorEmail, sub: actorSub };

    const startedAtMs = Date.now();
    const logger = workflowLogger();

    // Logged on entry so an instance that dies before its first step still records what it was
    // asked to do. A Workflow's own observability shows that it ran; this shows what it ran *with*.
    logger.warn('create_video_workflow_started', {
      runId: validated.runId,
      model: validated.model.id,
      resolution: validated.resolution,
      duration: validated.duration
    });

    const generated = await step.do(
      'generate-video',
      // Retries disabled; see `VIDEO_INFERENCE_STEP_POLICY` for why that is the most important
      // line in this file. The policy lives in the domain so a test can assert it without loading
      // the Workers runtime.
      VIDEO_INFERENCE_STEP_POLICY,
      async () => {
        const inference = new GatewayInferenceClient({
          ai: this.env.AI,
          gatewayId: this.env.AI_GATEWAY_ID,
          // A Workflow has no request-scoped logger, so one is built here. Omitting it was a real
          // defect: the client logs the provider's own message and this step logs only a
          // classification, so with no logger the actual cause of a failed render was recorded
          // nowhere at all — leaving a `create-video` failure diagnosable only as "it failed".
          logger
        });

        try {
          const result = await inference.run<Record<string, unknown>, unknown>({
            task: 'create-video',
            model: validated.model,
            runId: validated.runId,
            actor,
            input: buildCreateVideoInput(validated)
          });

          return {
            videoUrl: extractVideoUrl(result.output),
            logIds: result.logId === undefined ? [] : [result.logId],
            elapsedMs: result.elapsedMs
          };
        } catch (cause) {
          // The cause is classified *here*, before it leaves the step, because a Workflow records a
          // thrown error as `{ name, message }` only: a `ProblemDetailsError`'s status and
          // visitor-facing detail are dropped on the way out. Without this, "the account is out of
          // AI Gateway credit" and "the provider broke" arrive at the status route
          // indistinguishable — and the first is the one a visitor can actually fix.
          const reason = classifyProviderFailure(cause);

          // Logged at the point of classification, showing both the input and the verdict. This is
          // the line that makes a misclassification self-evident: it records what the step was
          // handed — including whether it was already a sanitised problem-details error and what
          // status that carried — beside the reason derived from it. Reconstructing this by
          // inference is what made the same bug survive three fixes.
          logger.error('create_video_inference_failed', {
            runId: validated.runId,
            model: validated.model.id,
            reason,
            errorName: cause instanceof Error ? cause.name : typeof cause,
            errorMessage: cause instanceof Error ? cause.message : String(cause),
            // The decisive field: a non-null status proves the error reached here already
            // sanitised, which is precisely the condition text matching cannot see through.
            problemStatus:
              typeof cause === 'object' && cause !== null && 'problemDetails' in cause
                ? ((cause as { problemDetails?: { status?: unknown } }).problemDetails?.status
                  ?? null)
                : null,
            nestedCause:
              cause instanceof Error && cause.cause instanceof Error
                ? `${cause.cause.name}: ${cause.cause.message}`
                : undefined,
            stack: cause instanceof Error ? cause.stack : undefined
          });

          // The re-thrown message is a fixed slug carrying no provider text, so using the error
          // message as the channel does not leak anything the request path would have sanitised.
          throw new Error(encodeFailureReason(reason), { cause });
        }
      }
    );

    const stored = await step.do('store-video', VIDEO_STORAGE_STEP_POLICY, async () => {
      const storage = new R2VideoStorage(this.env.VIDEO_BUCKET);
      const client = new ProviderVideoClient({ storage });

      const metadata = await client.fetchAndStore(
        generated.videoUrl,
        validated.controls.outputHosts,
        videoKey
      );

      // Metadata only. The video itself is in storage; returning its bytes here would breach the
      // 1 MiB step-result limit and persist a copy of the whole file in instance state.
      return { mediaType: metadata.mediaType, byteLength: metadata.byteLength };
    });

    return {
      mediaType: stored.mediaType,
      byteLength: stored.byteLength,
      logIds: generated.logIds,
      elapsedMs: Date.now() - startedAtMs,
      applied: describeAppliedVideoControls(validated)
    };
  }
}

/**
 * Builds a logger for use inside a Workflow step.
 *
 * A Workflow is not a request, so there is no `c.var.LOGGER` to inject. `console` is the transport
 * the Workers runtime captures into the same observability stream the request path writes to, which
 * is what keeps a run id searchable across both.
 *
 * @returns A {@link DiagnosticLogger} writing structured JSON.
 */
function workflowLogger(): DiagnosticLogger {
  /**
   * Emits one structured line.
   *
   * @param level Severity label.
   * @returns A logging function for that level.
   */
  const write =
    (level: 'warn' | 'error') =>
    (message: string, context?: Record<string, unknown>): void => {
      // Serialised as one JSON object so the fields are queryable, matching the shape the toolkit's
      // request logger produces.
      console.log(JSON.stringify({ level, message, source: 'workflow', ...context }));
    };

  return { warn: write('warn'), error: write('error') };
}

/**
 * Reads the video URL out of a provider's response envelope.
 *
 * Every reviewed model declares an output of `{ video: string }` wrapped in an envelope that also
 * carries `state` and `gatewayMetadata`. Both shapes are accepted — the bare output and the
 * enveloped one — because the binding's unwrapping behaviour is the kind of detail that changes
 * without notice, and a panel that broke on it would be broken for an uninteresting reason.
 *
 * @param output The provider's raw output.
 * @returns The video URL.
 * @throws {ProblemDetailsError} With `502` when no usable URL is present, which is the signal that
 *   the response contract has changed rather than that the request was wrong.
 */
function extractVideoUrl(output: unknown): string {
  if (typeof output !== 'object' || output === null) {
    throw videoContractFailure();
  }

  const record = output as Record<string, unknown>;

  const direct = record['video'];
  if (typeof direct === 'string' && direct !== '') {
    return direct;
  }

  const result = record['result'];
  if (typeof result === 'object' && result !== null) {
    const nested = (result as Record<string, unknown>)['video'];
    if (typeof nested === 'string' && nested !== '') {
      return nested;
    }
  }

  throw videoContractFailure();
}

/**
 * Builds the sanitised error used when a provider's response carries no usable video URL.
 *
 * @returns A `502` problem-details error.
 */
function videoContractFailure(): ProblemDetailsError {
  return new ProblemDetailsError({
    status: 502,
    title: 'The video could not be generated',
    detail: 'The model did not return a usable video. Try again, or choose another model.'
  });
}
