import type { ArchitectureJobStatus } from "../../collaboration-protocol";
import type { ArchitectureJob } from "./types";

/** Raw snake-cased `architecture_jobs` row returned by D1. */
interface ArchitectureJobRow {
  id: string;
  workflow_instance_id: string;
  diagram_id: string;
  base_revision: number;
  requester_email: string;
  status: string;
  proposal_r2_key: string | null;
  created_at: string;
  updated_at: string;
}

/** Statuses that count as "an active job" for the one-active-job-per-diagram rule. */
const ACTIVE_STATUSES: readonly ArchitectureJobStatus[] = [
  "queued",
  "summarizing",
  "generating",
  "validating",
  "storing",
];

/** Convert a D1 row to the API's camel-cased job representation. */
function toJob(row: ArchitectureJobRow): ArchitectureJob {
  return {
    id: row.id,
    workflowInstanceId: row.workflow_instance_id,
    diagramId: row.diagram_id,
    baseRevision: row.base_revision,
    requesterEmail: row.requester_email,
    status: row.status as ArchitectureJobStatus,
    proposalR2Key: row.proposal_r2_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * D1 persistence boundary for `architecture_jobs`.
 *
 * Used by two callers that must agree on the exact same idempotent behavior:
 * `../routes/diagrams.ts`'s `POST /:id/proposals` (the ordinary HTTP path, which pre-creates the
 * row before starting the Workflow) and `../architecture-workflow.ts`'s own `summarize` step
 * (which ensures its row exists so the Workflow can make progress even when started directly —
 * see `docs/09-ARCHITECT.md`'s Phase 5 and this repository's Spike 08 precedent for
 * `INSERT OR IGNORE` idempotency).
 */
export class ArchitectureJobRepository {
  /** @param database D1 capability used to query and update `architecture_jobs`. */
  constructor(private readonly database: Pick<D1Database, "prepare">) {}

  /**
   * Idempotently ensure a job row exists, doing nothing if one with this `id` already does.
   *
   * A new row starts at status `"queued"` with no proposal key — see
   * `../../collaboration-protocol.ts`'s `ArchitectureJobStatus` documentation for why `"queued"`
   * exists ahead of the brief's own named states.
   *
   * @param job The job identity and starting metadata.
   */
  async ensureJob(job: {
    id: string;
    workflowInstanceId: string;
    diagramId: string;
    baseRevision: number;
    requesterEmail: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.database
      .prepare(
        `INSERT OR IGNORE INTO architecture_jobs
           (id, workflow_instance_id, diagram_id, base_revision, requester_email, status, proposal_r2_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', NULL, ?, ?)`,
      )
      .bind(
        job.id,
        job.workflowInstanceId,
        job.diagramId,
        job.baseRevision,
        job.requesterEmail,
        now,
        now,
      )
      .run();
  }

  /**
   * Read one job by id.
   *
   * @param id Job id.
   * @returns The job, or `null` if no such row exists.
   */
  async findById(id: string): Promise<ArchitectureJob | null> {
    const row = await this.database
      .prepare(
        `SELECT id, workflow_instance_id, diagram_id, base_revision, requester_email, status, proposal_r2_key, created_at, updated_at
         FROM architecture_jobs WHERE id = ?`,
      )
      .bind(id)
      .first<ArchitectureJobRow>();
    return row ? toJob(row) : null;
  }

  /**
   * Find a diagram's currently active (non-terminal) job, if any — the enforcement point for
   * "one active job per diagram" (`docs/09-ARCHITECT.md`'s Phase 5).
   *
   * @param diagramId Diagram to check.
   * @returns The active job, or `null` if none.
   */
  async findActiveForDiagram(
    diagramId: string,
  ): Promise<ArchitectureJob | null> {
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
    const row = await this.database
      .prepare(
        `SELECT id, workflow_instance_id, diagram_id, base_revision, requester_email, status, proposal_r2_key, created_at, updated_at
         FROM architecture_jobs WHERE diagram_id = ? AND status IN (${placeholders})
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(diagramId, ...ACTIVE_STATUSES)
      .first<ArchitectureJobRow>();
    return row ? toJob(row) : null;
  }

  /**
   * Find one requester's most recently created job, across every diagram — the read side of the
   * per-user start-rate throttle (`../architecture/validation.ts`'s `PROPOSAL_RATE_LIMIT_MS`).
   *
   * @param email Verified Cloudflare Access email of the requester.
   * @returns The requester's most recent job, or `null` if they have never started one.
   */
  async mostRecentByRequester(email: string): Promise<ArchitectureJob | null> {
    const row = await this.database
      .prepare(
        `SELECT id, workflow_instance_id, diagram_id, base_revision, requester_email, status, proposal_r2_key, created_at, updated_at
         FROM architecture_jobs WHERE requester_email = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(email)
      .first<ArchitectureJobRow>();
    return row ? toJob(row) : null;
  }

  /**
   * Transition a job to a new non-terminal status.
   *
   * Guarded to never overwrite an already-terminal (`"ready"`/`"failed"`) row, so an
   * out-of-order or duplicated step invocation can never resurrect a finished job into a
   * non-terminal one.
   *
   * @param id Job id.
   * @param status The new status.
   */
  async setStatus(id: string, status: ArchitectureJobStatus): Promise<void> {
    await this.database
      .prepare(
        `UPDATE architecture_jobs SET status = ?, updated_at = ?
         WHERE id = ? AND status NOT IN ('ready', 'failed')`,
      )
      .bind(status, new Date().toISOString(), id)
      .run();
  }

  /**
   * Record the deterministic R2 key a validated proposal was written to, ahead of the separate
   * `"ready"` transition (`../architecture-workflow.ts`'s `store` step, matching Spike 08's own
   * two-step `store`/`mark ready` boundary).
   *
   * @param id Job id.
   * @param proposalR2Key The `proposals/<jobId>.json` key the proposal was written to.
   */
  async setProposalKey(id: string, proposalR2Key: string): Promise<void> {
    await this.database
      .prepare(
        "UPDATE architecture_jobs SET proposal_r2_key = ?, updated_at = ? WHERE id = ?",
      )
      .bind(proposalR2Key, new Date().toISOString(), id)
      .run();
  }

  /**
   * Mark a job durably `"ready"`.
   *
   * Guarded to never resurrect an already-`"failed"` job, mirroring {@link setStatus}'s
   * guard — a late-arriving `mark ready` step after finalization has already run must not
   * silently override a terminal failure.
   *
   * @param id Job id.
   * @param proposalR2Key The proposal's R2 key, recorded again here for callers that skip
   * {@link setProposalKey} (defensive; every real caller sets it in the prior `store` step).
   */
  async setReady(id: string, proposalR2Key: string): Promise<void> {
    await this.database
      .prepare(
        `UPDATE architecture_jobs SET status = 'ready', proposal_r2_key = ?, updated_at = ?
         WHERE id = ? AND status != 'failed'`,
      )
      .bind(proposalR2Key, new Date().toISOString(), id)
      .run();
  }

  /**
   * Idempotently mark a job durably `"failed"`.
   *
   * Guarded to never overwrite an already-terminal row — calling this more than once (a
   * Workflow finalization step that itself gets retried) is always harmless, satisfying
   * `docs/09-ARCHITECT.md`'s "its side effects must be idempotent" requirement.
   *
   * @param id Job id.
   */
  async setFailed(id: string): Promise<void> {
    await this.database
      .prepare(
        `UPDATE architecture_jobs SET status = 'failed', updated_at = ?
         WHERE id = ? AND status NOT IN ('ready', 'failed')`,
      )
      .bind(new Date().toISOString(), id)
      .run();
  }
}
