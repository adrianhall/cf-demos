import {
  createLogger,
  resolveLoggerConfig,
} from "@adrianhall/cloudflare-toolkit/logging";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { ArchitectureJobStatus } from "../collaboration-protocol";
import type { DiagramRoom } from "./diagram-room";
import {
  architectureProposalToGraphDocument,
  validateArchitectureProposal,
} from "../graph/proposal";
import { GraphValidationError } from "../graph/validation";
import { ArchitectureJobRepository } from "./architecture/repository";
import { buildCatalogSummary } from "./architecture/summary";
import { createArchitectureGenerator } from "./architecture/generator";

/**
 * Immutable input `ArchitectureWorkflow.run()` receives as `event.payload`.
 *
 * Deliberately self-describing: this Workflow's instance id (always equal to the job's
 * `architecture_jobs.id`, per `docs/09-ARCHITECT.md`'s Phase 5) plus this payload carry
 * everything every step needs. No step ever depends on a Worker HTTP route having run first —
 * `summarize` (below) ensures its own `architecture_jobs` row exists via `INSERT OR IGNORE`
 * rather than assuming a caller pre-inserted one, so this Workflow can be triggered directly
 * (for example `wrangler workflows trigger` against a deployed instance, bypassing the
 * Access-protected HTTP API entirely) and still reach a durable `ready` or `failed` result.
 */
export interface ArchitectureWorkflowInput {
  /** Diagram this proposal is for. */
  diagramId: string;
  /** The diagram's revision at the moment this job was created (or, for a standalone trigger, the revision to treat as current). */
  baseRevision: number;
  /** Verified Cloudflare Access email of the requester. Never used for authorization inside the Workflow — that already happened in the Worker route that created this job. */
  requesterEmail: string;
  /** The user's short natural-language application description. */
  prompt: string;
}

/** Compute the deterministic proposal R2 key for one job id, matching Spike 08's exact decision. */
function proposalKeyFor(jobId: string): string {
  return `proposals/${jobId}.json`;
}

/**
 * Registered Workflow entry point for architecture proposals
 * (`docs/09-ARCHITECT.md`'s AI Workflow, implementing the seven durable steps measured in
 * `spikes/08-architect-workflow-local/REPORT.md` exactly): `summarize` -> `mark generating` ->
 * `generate` (the only retryable step) -> `validate` -> `store` -> `mark ready`, with a
 * top-level `finalize failure` step run from the `catch` block for any terminal failure.
 *
 * Every named-state transition writes D1 (`architecture_jobs.status`) before notifying
 * `DiagramRoom`, per Spike 08's measured ordering, so status history is durable even if the
 * room's own notification briefly fails — `notify()` below swallows (and only logs) a
 * notification failure for exactly this reason.
 */
export class ArchitectureWorkflow extends WorkflowEntrypoint<
  Env,
  ArchitectureWorkflowInput
> {
  /** Workflow-scoped structured logger — there is no per-request Hono context here. */
  private readonly logger = createLogger(
    resolveLoggerConfig(this.env.ENVIRONMENT, "worker"),
  );

  async run(
    event: Readonly<WorkflowEvent<ArchitectureWorkflowInput>>,
    step: WorkflowStep,
  ): Promise<{ status: "ready" | "failed" }> {
    // The Workflow instance id is always the job id (docs/09-ARCHITECT.md's Phase 5): the Worker
    // route calls `ARCHITECTURE_WORKFLOW.create({ id: jobId, ... })`, and a standalone
    // `wrangler workflows trigger ... --id <jobId>` sets the same id directly.
    const jobId = event.instanceId;
    const { diagramId, baseRevision, requesterEmail, prompt } = event.payload;
    const jobs = new ArchitectureJobRepository(this.env.DB);
    const room = this.env.DIAGRAM_ROOM.getByName(diagramId);
    const generator = createArchitectureGenerator(this.env);

    try {
      const summary = await step.do("summarize", async () => {
        await jobs.ensureJob({
          id: jobId,
          workflowInstanceId: jobId,
          diagramId,
          baseRevision,
          requesterEmail,
        });
        await jobs.setStatus(jobId, "summarizing");
        await this.notify(room, jobId, "summarizing");
        const snapshot = await room.readDocument();
        return buildCatalogSummary(snapshot.document);
      });

      await step.do("mark generating", async () => {
        await jobs.setStatus(jobId, "generating");
        await this.notify(room, jobId, "generating");
      });

      const raw = await step.do(
        "generate",
        {
          // Spike 08's local report measured `{ limit: 1, delay: 10, backoff: "constant" }`
          // against a synchronous, instantaneous fake generator, where a short timeout was
          // harmless. The real Workers AI call it stands in for is not instantaneous: Spike 09
          // observed `@cf/meta/llama-3.3-70b-instruct-fp8-fast` `env.AI.run()` latency of
          // 4.5-19.4 seconds for small/medium fixtures alone (before any HTTP/queue overhead),
          // and a deployed smoke test after this phase's first implementation attempt confirmed
          // a 1-second timeout makes every real generation attempt fail as a timeout, not a
          // model/content failure. 120 seconds comfortably covers the slowest measured fixture
          // plus real-world variance while still bounding a genuinely stuck call. `delay: 10`
          // is a bare number of milliseconds (Cloudflare's own docs: "a fixed duration as a
          // number in milliseconds or a human-readable string") — kept as-is from Spike 08,
          // since a fast retry between the only two generation attempts is still appropriate;
          // only the timeout was actually too short for a real model call.
          retries: { limit: 1, delay: 10, backoff: "constant" },
          timeout: "120 seconds",
        },
        async (stepContext) => {
          this.logger.info("architecture_job_generate_attempt", {
            jobId,
            attempt: stepContext.attempt,
          });
          return await generator.generate({
            prompt,
            catalogSummary: summary,
            attempt: stepContext.attempt,
          });
        },
      );

      const document = await step.do("validate", async () => {
        await jobs.setStatus(jobId, "validating");
        await this.notify(room, jobId, "validating");

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new NonRetryableError(
            "The generated proposal was not valid JSON.",
          );
        }
        try {
          return architectureProposalToGraphDocument(
            validateArchitectureProposal(parsed),
          );
        } catch (error) {
          if (error instanceof GraphValidationError) {
            throw new NonRetryableError(error.message);
          }
          throw error;
        }
      });

      const proposalKey = proposalKeyFor(jobId);
      await step.do("store", async () => {
        await jobs.setStatus(jobId, "storing");
        await this.notify(room, jobId, "storing");
        await this.env.SNAPSHOTS.put(proposalKey, JSON.stringify(document));
        await jobs.setProposalKey(jobId, proposalKey);
      });

      await step.do("mark ready", async () => {
        await jobs.setReady(jobId, proposalKey);
        await this.notify(room, jobId, "ready");
      });

      this.logger.info("architecture_job_completed", { jobId });
      return { status: "ready" };
    } catch (error) {
      await step.do("finalize failure", async () => {
        await jobs.setFailed(jobId);
        await this.notify(
          room,
          jobId,
          "failed",
          "The proposal could not be generated. Please try again.",
        );
      });
      this.logger.warn("architecture_job_failed", {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: "failed" };
    }
  }

  /**
   * Notify `DiagramRoom` of a job's new status, swallowing (and only logging) any failure.
   *
   * D1 has already durably recorded the transition by the time this is called (every call site
   * above writes D1 first), so a transient Durable Object hiccup here must never fail the
   * Workflow step itself — the room simply has a stale `job_progress` view until its next
   * successful notification or a client's `GET /api/diagrams/:id/proposals/:jobId` fallback poll.
   *
   * @param room The diagram's `DiagramRoom` stub.
   * @param jobId The job id.
   * @param status The new status to broadcast.
   * @param error A user-safe explanation, only meaningful when `status` is `"failed"`.
   */
  private async notify(
    room: DurableObjectStub<DiagramRoom>,
    jobId: string,
    status: ArchitectureJobStatus,
    error?: string,
  ): Promise<void> {
    try {
      await room.notifyJobProgress(status, jobId, error);
    } catch (notifyError) {
      this.logger.warn("architecture_job_notification_failed", {
        jobId,
        status,
        error:
          notifyError instanceof Error
            ? notifyError.message
            : String(notifyError),
      });
    }
  }
}
