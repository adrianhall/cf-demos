/**
 * @file The Workflow that animates a picture and stores the resulting video. It exists for exactly
 *   the reasons Create Video's does — a render takes minutes, the visitor's connection is the
 *   fragile part, and a render abandoned halfway has still been _paid for_ — and it reuses that
 *   phase's machinery wholesale rather than growing a parallel one: the same R2 bucket, the same
 *   `R2VideoStorage` adapter, the same `ProviderVideoClient` host allowlist, the same step policies
 *   from `domain/media-job.ts`, and the same failure classification that survives the Workflow
 *   boundary. **No second storage product and no second job mechanism.** It is a separate Workflow
 *   class rather than a branch inside the Create Video one, and that is a deliberate choice worth
 *   stating. The two differ in their _parameters_ and their _validation_ — this one carries a
 *   picture and re-validates it against the image rules — and a single class switching on a
 *   discriminator would have to accept a union payload, re-validate against whichever arm it
 *   guessed, and would make the retry policy's cost reasoning apply to two panels at once. The
 *   shared parts are shared as modules, which is the form of reuse that does not create a second
 *   thing to reason about. **The picture crosses the event-parameter boundary, which is why this
 *   panel caps its source image lower than every other image panel.** A Workflow event payload is
 *   capped at 1 MiB, and base64 expands bytes by four thirds; see `MAX_ANIMATE_SOURCE_BYTES`. The
 *   picture is written to no storage product — Phase 8's Finding 10 applies unchanged, and only the
 *   generated video is kept. It does reach the provider in the request, which the panel discloses
 *   rather than papering over with a retention promise this demo cannot make on someone else's
 *   behalf.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type { AppliedAnimateImageControls } from '../../../shared/animate-image';
import type { DiagnosticLogger } from '../../application/ports/diagnostic-logger-port';
import {
  buildAnimateImageInput,
  describeAppliedAnimateControls,
  validateAnimateImageRequest
} from '../../domain/animate-image';
import { VIDEO_INFERENCE_STEP_POLICY, VIDEO_STORAGE_STEP_POLICY } from '../../domain/media-job';
import { classifyProviderFailure, encodeFailureReason } from '../../domain/provider-failures';
import { GatewayInferenceClient } from '../ai/gateway-inference-client';
import { ProviderVideoClient } from '../media/provider-video-client';
import { R2VideoStorage } from '../media/r2-video-storage';

/**
 * What the Worker passes to a new Animate Image Workflow instance.
 *
 * The verified email is included because the Workflow has to attribute its own gateway call, and a
 * Workflow step runs long after the request that started it — so the identity cannot be re-derived
 * from a JWT at that point. It travels as a parameter and is used for gateway metadata only; it is
 * never written to a log line, exactly as in the request path.
 *
 * The request is carried as the raw body rather than a validated object, and re-validated inside
 * the Workflow. Workflow parameters are serialised, so a validated type's guarantees do not survive
 * the trip: re-validating means the thing the Workflow acts on has actually passed the same checks
 * the route applied — **including re-reading the picture's format and dimensions from its own
 * bytes** — rather than merely having the shape of something that once did.
 */
export interface AnimateImageJobParams {
  /**
   * The original, untrusted request body including the base64 picture, re-validated on arrival.
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
 * Read by the status route to describe a completed job. It carries metadata only — never bytes. The
 * generated video is in storage and served from there, and **the source picture is not carried back
 * at all**: it was the visitor's own upload, it is already in their browser, and returning it would
 * hold a second copy in instance state for no benefit.
 */
export interface AnimateImageJobOutput {
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
   * Milliseconds the generation took, measured across the whole run.
   */
  elapsedMs: number;
  /**
   * The controls the video was produced with, including the facts verified from the source
   * picture's bytes, so a job polled from a fresh tab can describe itself.
   */
  applied: AppliedAnimateImageControls;
}

/**
 * Bindings the Workflow needs.
 *
 * Identical to the Create Video Workflow's, because it uses the same gateway and the same bucket. A
 * narrower set than the Worker's: a Workflow serves no requests, so it has no use for Access
 * configuration or the asset store.
 */
export interface AnimateImageWorkflowEnv {
  /**
   * Workers AI binding, used only through the central gateway client.
   */
  AI: Ai;
  /**
   * Identifier of the Terraform-managed AI Gateway.
   */
  AI_GATEWAY_ID: string;
  /**
   * Bucket generated video is stored in — the same one Create Video writes to, under the same
   * prefix, so one scheduled reaper will collect both panels' output.
   */
  VIDEO_BUCKET: R2Bucket;
}

/**
 * Animates one picture and stores the resulting video.
 */
export class AnimateImageWorkflow extends WorkflowEntrypoint<
  AnimateImageWorkflowEnv,
  AnimateImageJobParams
> {
  /**
   * Runs the animation.
   *
   * @param event The instance's parameters; see {@link AnimateImageJobParams}.
   * @param step Workflow step API, used to make each stage durable.
   * @returns The stored video's metadata and the run's gateway log identifiers; see
   *   {@link AnimateImageJobOutput}.
   * @throws {ProblemDetailsError} When validation refuses the carried request, the provider's URL
   *   is unapproved, or the returned bytes are not a playable video.
   * @throws {Error} Carrying an encoded failure reason when the provider call fails, so the status
   *   route can tell a billing failure from a provider one. A thrown error puts the instance in
   *   `errored`, which the status route reports as a failed job.
   */
  async run(
    event: WorkflowEvent<AnimateImageJobParams>,
    step: WorkflowStep
  ): Promise<AnimateImageJobOutput> {
    const { request, actorEmail, actorSub, videoKey } = event.payload;

    // Re-validated rather than trusted: parameters crossed a serialisation boundary, so this is the
    // first point inside the Workflow where the request's guarantees actually hold. For this panel
    // that includes re-sniffing the picture's media type and re-reading its dimensions from the
    // bytes, rather than relying on a check another process performed earlier.
    const validated = validateAnimateImageRequest(request);
    const actor = { email: actorEmail, sub: actorSub };

    const startedAtMs = Date.now();
    const logger = workflowLogger();

    // Logged on entry so an instance that dies before its first step still records what it was
    // asked to do. A Workflow's own observability shows that it ran; this shows what it ran *with*.
    // The picture itself is never logged — only facts about it, which is what makes a failed render
    // reproducible without retaining a visitor's image.
    logger.warn('animate_image_workflow_started', {
      runId: validated.runId,
      model: validated.model.id,
      resolution: validated.resolution,
      duration: validated.duration,
      sourceMediaType: validated.source.facts.mediaType,
      sourceByteLength: validated.source.facts.byteLength
    });

    const generated = await step.do(
      'animate-image',
      // Retries disabled; see `VIDEO_INFERENCE_STEP_POLICY` for why. The policy is shared with
      // Create Video rather than copied, because the cost reasoning is identical: this step bills
      // per second of generated video, so an inherited retry default would turn one transient
      // provider fault into several charges.
      VIDEO_INFERENCE_STEP_POLICY,
      async () => {
        const inference = new GatewayInferenceClient({
          ai: this.env.AI,
          gatewayId: this.env.AI_GATEWAY_ID,
          // A Workflow has no request-scoped logger, so one is built here. Without it the client's
          // record of the provider's own message would go nowhere, leaving a failed render
          // diagnosable only as "it failed".
          logger
        });

        try {
          const result = await inference.run<Record<string, unknown>, unknown>({
            task: 'animate-image',
            model: validated.model,
            runId: validated.runId,
            actor,
            input: buildAnimateImageInput(validated)
          });

          return {
            videoUrl: extractVideoUrl(result.output),
            logIds: result.logId === undefined ? [] : [result.logId],
            elapsedMs: result.elapsedMs
          };
        } catch (cause) {
          // Classified *here*, before it leaves the step, because a Workflow records a thrown error
          // as `{ name, message }` only: a `ProblemDetailsError`'s status and visitor-facing detail
          // are dropped on the way out. Without this, "the account is out of AI Gateway credit" and
          // "the provider broke" arrive at the status route indistinguishable — and the first is
          // the one a visitor can actually fix. This panel's models are all third-party, so the
          // billing case is the *likely* one rather than an edge case.
          const reason = classifyProviderFailure(cause);

          logger.error('animate_image_inference_failed', {
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
      applied: describeAppliedAnimateControls(validated)
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
 * Both registered models declare an output carrying `video` wrapped in an envelope that also
 * carries `state` and `gatewayMetadata`; MiniMax's additionally carries `task_id` and `status`,
 * which this demo ignores because the job lifecycle it reports is this Workflow's rather than the
 * provider's. Both the bare output and the enveloped one are accepted, because the binding's
 * unwrapping behaviour is the kind of detail that changes without notice.
 *
 * @param output The provider's raw output.
 * @returns The video URL.
 * @throws {ProblemDetailsError} With `502` when no usable URL is present, which is the signal that
 *   the response contract has changed rather than that the request was wrong.
 */
function extractVideoUrl(output: unknown): string {
  if (typeof output !== 'object' || output === null) {
    throw animationContractFailure();
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

  throw animationContractFailure();
}

/**
 * Builds the sanitised error used when a provider's response carries no usable video URL.
 *
 * @returns A `502` problem-details error.
 */
function animationContractFailure(): ProblemDetailsError {
  return new ProblemDetailsError({
    status: 502,
    title: 'The animation could not be generated',
    detail: 'The model did not return a usable video. Try again, or choose another model.'
  });
}
