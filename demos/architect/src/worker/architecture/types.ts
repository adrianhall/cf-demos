import type { ArchitectureJobStatus } from "../../collaboration-protocol";

/**
 * One `architecture_jobs` D1 row (`docs/09-ARCHITECT.md`'s Data And State Model), camel-cased for
 * the API.
 */
export interface ArchitectureJob {
  /** Job id — also the `ArchitectureWorkflow` instance id and the R2 key's `<jobId>` segment. */
  id: string;
  /** The Workflow instance id. Always equal to {@link ArchitectureJob.id} in this demo. */
  workflowInstanceId: string;
  /** Diagram this proposal is for. */
  diagramId: string;
  /** The diagram's revision at the moment this job was created, used by acceptance's staleness check. */
  baseRevision: number;
  /** Verified Cloudflare Access email of the member who requested this proposal. */
  requesterEmail: string;
  /** Current durable status. */
  status: ArchitectureJobStatus;
  /** The R2 key (`proposals/<jobId>.json`) once the `store` step has written it, else `null`. */
  proposalR2Key: string | null;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp of the most recent status change. */
  updatedAt: string;
}

/** Validated `POST /api/diagrams/:id/proposals` request body. */
export interface StartProposalInput {
  /** The user's short natural-language application description. */
  prompt: string;
  /**
   * Optional client-supplied idempotency key. Retrying the same diagram + requester + key
   * returns the existing job instead of starting a second one — see
   * `./idempotency.ts`'s `deriveIdempotentJobId()`.
   */
  idempotencyKey?: string;
}
