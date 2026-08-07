import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

/** Input retained as an explicit future contract for Workflow invocation. */
export interface ArchitectureWorkflowInput {
  /** Architecture job identifier assigned by the API. */
  jobId: string;
}

/**
 * Registered Workflow entry point for architecture proposals.
 *
 * Phase 1 makes the binding deployable but intentionally starts no paid or durable job. Phase 5
 * supplies the generated proposal steps and terminal status handling.
 */
export class ArchitectureWorkflow extends WorkflowEntrypoint<
  Env,
  ArchitectureWorkflowInput
> {
  /** Complete the inert scaffold invocation without creating application state. */
  async run(
    _event: Readonly<WorkflowEvent<ArchitectureWorkflowInput>>,
    _step: WorkflowStep,
  ): Promise<void> {}
}
