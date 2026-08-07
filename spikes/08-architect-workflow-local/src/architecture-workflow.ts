import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { ArchitectureJobInput, ArchitectureProposal, JobStatus } from "./contracts";
import { DeterministicArchitectureGenerator } from "./generator";
import { parseArchitectureProposal } from "./validation";

/** Retry policy for the only upstream-dependent step: two total generator attempts. */
const generatorRetry = { retries: { limit: 1, delay: 10, backoff: "constant" }, timeout: "1 second" } as const;

/** Durable orchestration of one architecture proposal. */
export class ArchitectureWorkflow extends WorkflowEntrypoint<Env, ArchitectureJobInput> {
  /**
   * Executes durable state transitions, generation, validation, object storage, and terminal repair.
   *
   * @param event Immutable job data provided when the Workflow instance is created.
   * @param step Durable step coordinator supplied by the Workflows runtime.
   * @returns The deterministic R2 key on success or the failed job status after terminal repair.
   */
  async run(event: Readonly<WorkflowEvent<ArchitectureJobInput>>, step: WorkflowStep): Promise<{ status: JobStatus; proposalKey?: string }> {
    const input = event.payload;
    try {
      const summary = await step.do("summarize", async () => {
        await this.transition(input, "summarizing");
        return `diagram:${input.diagramId}:revision:${input.baseRevision}`;
      });
      await step.do("mark generating", async () => this.transition(input, "generating"));
      const raw = await step.do("generate", generatorRetry, async (context) => {
        // Attempt is Workflows metadata, never a prompt or generated document.
        console.log(JSON.stringify({ event: "architecture_generation_attempt", jobId: input.jobId, attempt: context.attempt }));
        return new DeterministicArchitectureGenerator().generate({ fixture: input.fixture, attempt: context.attempt, summary });
      });
      const proposal = await step.do("validate", async () => {
        await this.transition(input, "validating");
        try {
          return parseArchitectureProposal(raw);
        } catch (error) {
          // Schema violations are deterministic; retrying the same output cannot repair them.
          throw new NonRetryableError(error instanceof Error ? error.message : "proposal validation failed");
        }
      });
      const proposalKey = await step.do("store", async () => this.store(input, proposal));
      await step.do("mark ready", async () => this.transition(input, "ready", proposalKey));
      return { status: "ready", proposalKey };
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : "workflow failed";
      await step.do("finalize failure", async () => this.transition(input, "failed", undefined, failureReason));
      return { status: "failed" };
    }
  }

  /** Persists a validated proposal under its stable key and records the storing transition. */
  private async store(input: ArchitectureJobInput, proposal: ArchitectureProposal): Promise<string> {
    await this.transition(input, "storing");
    const proposalKey = `proposals/${input.jobId}.json`;
    await this.env.PROPOSALS.put(proposalKey, JSON.stringify(proposal), { httpMetadata: { contentType: "application/json" } });
    await this.env.ARCHITECT_DB.prepare("UPDATE architecture_jobs SET proposal_key = ? WHERE id = ?").bind(proposalKey, input.jobId).run();
    return proposalKey;
  }

  /** Updates D1 before notifying the authoritative room, making state visible before delivery. */
  private async transition(input: ArchitectureJobInput, status: JobStatus, proposalKey?: string, failureReason?: string): Promise<void> {
    await this.env.ARCHITECT_DB.prepare("UPDATE architecture_jobs SET status = ?, proposal_key = COALESCE(?, proposal_key), failure_reason = ? WHERE id = ?")
      .bind(status, proposalKey ?? null, failureReason ?? null, input.jobId)
      .run();
    await this.env.DIAGRAM_ROOM.getByName(input.diagramId).notify({ jobId: input.jobId, status, proposalKey, failureReason });
  }
}
