import type { ReviewerRole } from "../review/roles";

/** Raw snake-cased `review_reviewers` row, as read back by {@link listReviewReviewers}. */
interface ReviewReviewerDbRow {
  role: string;
  model: string | null;
  status: string;
  skipped_reason: string | null;
  error_detail: string | null;
  raw_output: string | null;
}

/** `review_reviewers.status` values (`migrations/0001_create_review_tables.sql`'s `CHECK`
 * constraint). */
export type ReviewerStatus =
  | "queued"
  | "running"
  | "done"
  | "skipped"
  | "error";

/** `review_reviewers.cost_source` values. */
export type ReviewerCostSource = "pending" | "gateway";

/** Input to {@link upsertReviewReviewer}. */
export interface UpsertReviewReviewerInput {
  readonly runId: string;
  readonly role: ReviewerRole;
  readonly status: ReviewerStatus;
  /** The literal model id this reviewer ran, or `null` for a `"skipped"`/not-yet-`"done"` row. */
  readonly model: string | null;
  readonly skippedReason: string | null;
  readonly errorDetail: string | null;
  readonly aiGatewayLogId: string | null;
  readonly costUsd: number | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly costSource: ReviewerCostSource;
  /** This reviewer's full raw prose output, or `null` for a `"skipped"`/`"error"` row. */
  readonly rawOutput: string | null;
}

/**
 * Idempotently upsert one reviewer's execution record, keyed on `(run_id, role)`
 * (`migrations/0001_create_review_tables.sql`'s own `UNIQUE (run_id, role)` constraint) --
 * called from inside `ReviewPipelineWorkflow`'s own `review:<role>` step, which the Workflows
 * engine guarantees runs **at least once**, not exactly once (docs/07-PR-REVIEW-AGENT.md,
 * "Review Orchestration"). A plain `INSERT` would conflict or duplicate a row on a retried
 * step's second attempt; this `ON CONFLICT ... DO UPDATE` makes re-running the whole step safe.
 *
 * @param database D1 capability used to prepare the upsert.
 * @param input The reviewer row to upsert.
 */
export async function upsertReviewReviewer(
  database: Pick<D1Database, "prepare">,
  input: UpsertReviewReviewerInput,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO review_reviewers (
         id, run_id, role, model, status, skipped_reason, started_at, completed_at,
         error_detail, ai_gateway_log_id, cost_usd, tokens_in, tokens_out, cost_source,
         raw_output
       ) VALUES (
         ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?, ?, ?, ?, ?, ?
       )
       ON CONFLICT (run_id, role) DO UPDATE SET
         model = excluded.model,
         status = excluded.status,
         skipped_reason = excluded.skipped_reason,
         completed_at = excluded.completed_at,
         error_detail = excluded.error_detail,
         ai_gateway_log_id = excluded.ai_gateway_log_id,
         cost_usd = excluded.cost_usd,
         tokens_in = excluded.tokens_in,
         tokens_out = excluded.tokens_out,
         cost_source = excluded.cost_source,
         raw_output = excluded.raw_output`,
    )
    .bind(
      crypto.randomUUID(),
      input.runId,
      input.role,
      input.model,
      input.status,
      input.skippedReason,
      input.errorDetail,
      input.aiGatewayLogId,
      input.costUsd,
      input.tokensIn,
      input.tokensOut,
      input.costSource,
      input.rawOutput,
    )
    .run();
}

/**
 * Reconcile one reviewer's cost with AI Gateway's own authoritative logged figures
 * (docs/07-PR-REVIEW-AGENT.md, "Cost Tracking" / "Review Orchestration"'s
 * `reconcile-cost:<role>` step). Called only on a successful `getLog()` -- an exhausted
 * reconciliation leaves the row's `cost_source` at its existing `'pending'` value permanently,
 * with no write at all (docs/07-PR-REVIEW-AGENT.md: "leave `costSource` 'pending' permanently").
 *
 * @param database D1 capability used to prepare the update.
 * @param runId The run this reviewer belongs to.
 * @param role Which reviewer to reconcile.
 * @param cost AI Gateway's own logged `tokens_in`/`tokens_out`/`cost` figures
 * (docs/DECISIONS.md #16 -- not `prompt_tokens`/`completion_tokens`).
 */
export async function reconcileReviewerCost(
  database: Pick<D1Database, "prepare">,
  runId: string,
  role: ReviewerRole,
  cost: {
    readonly costUsd: number;
    readonly tokensIn: number;
    readonly tokensOut: number;
  },
): Promise<void> {
  await database
    .prepare(
      `UPDATE review_reviewers
       SET cost_usd = ?, tokens_in = ?, tokens_out = ?, cost_source = 'gateway'
       WHERE run_id = ? AND role = ?`,
    )
    .bind(cost.costUsd, cost.tokensIn, cost.tokensOut, runId, role)
    .run();
}

/** One `review_reviewers` row, as read back by {@link listReviewReviewers} -- only the columns
 * `../review/report.ts`'s `buildFullReport()` needs (role, model, status, skip/error reason,
 * raw output). Deliberately excludes cost/token columns; nothing in the report renders cost. */
export interface ReviewReviewerRow {
  readonly role: ReviewerRole;
  readonly model: string | null;
  readonly status: ReviewerStatus;
  readonly skippedReason: string | null;
  readonly errorDetail: string | null;
  readonly rawOutput: string | null;
}

/**
 * List every reviewer row for a run -- read once, inside the `merge-and-post-comment` step, to
 * build the full report's per-reviewer sections (docs/07-PR-REVIEW-AGENT.md, "Report Assembly
 * And Comment Posting"). Reading this back from D1 rather than threading each reviewer's own
 * `rawOutput` through `ReviewPipelineWorkflow.run()`'s own in-memory scope is what satisfies
 * Implementation Plan Phase 4, item 19's "never accumulate a reviewer's full raw output in a
 * variable that outlives its own step's D1 write" rule.
 *
 * @param database D1 capability used to prepare the query.
 * @param runId The run to list reviewers for.
 * @returns Every reviewer row recorded for this run so far, in no particular order.
 */
export async function listReviewReviewers(
  database: Pick<D1Database, "prepare">,
  runId: string,
): Promise<ReviewReviewerRow[]> {
  const { results } = await database
    .prepare(
      `SELECT role, model, status, skipped_reason, error_detail, raw_output
       FROM review_reviewers WHERE run_id = ?`,
    )
    .bind(runId)
    .all<ReviewReviewerDbRow>();
  return results.map((row) => ({
    role: row.role as ReviewerRole,
    model: row.model,
    status: row.status as ReviewerStatus,
    skippedReason: row.skipped_reason,
    errorDetail: row.error_detail,
    rawOutput: row.raw_output,
  }));
}

/** Raw snake-cased `review_reviewers` row, as read back by {@link listReviewerExecutions}. */
interface ReviewerExecutionDbRow {
  role: string;
  model: string | null;
  status: string;
  skipped_reason: string | null;
  error_detail: string | null;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_source: string;
  raw_output: string | null;
}

/** One `review_reviewers` row, as read back by {@link listReviewerExecutions} -- a superset of
 * {@link ReviewReviewerRow} that also carries cost/token figures, for `GET /api/reviews/:id`'s
 * full run detail (Implementation Plan Phase 5, item 23). Kept as a distinct function/type
 * (rather than widening {@link listReviewReviewers} itself) so `./reviewRuns.test.ts`'s and
 * `../workflows/ReviewPipelineWorkflow.ts`'s existing exact-shape assertions against
 * {@link listReviewReviewers} never have to change just because the run-detail endpoint needs
 * more columns. */
export interface ReviewerExecutionRow {
  readonly role: ReviewerRole;
  readonly model: string | null;
  readonly status: ReviewerStatus;
  readonly skippedReason: string | null;
  readonly errorDetail: string | null;
  readonly costUsd: number | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly costSource: ReviewerCostSource;
  /** This reviewer's full raw prose output -- not part of `GET /api/reviews/:id`'s own reviewer
   * response shape (that endpoint's full Markdown report already carries it), but read here so
   * `./reviewRuns.ts`'s `getReviewRunDetail()` can re-derive `findingCount` from it via
   * `../review/schema.ts`'s `parseFencedFindings()` -- see that function's doc comment for why
   * neither this table nor `review_findings` stores a per-reviewer finding count directly. */
  readonly rawOutput: string | null;
}

/**
 * List every reviewer row for a run with its cost/token figures included, for `GET
 * /api/reviews/:id`'s full run detail (docs/07-PR-REVIEW-AGENT.md, "API And Routing": "Full run
 * detail: reviewer rows, merged findings, the full Markdown report, and the posted comment
 * URL").
 *
 * @param database D1 capability used to prepare the query.
 * @param runId The run to list reviewer executions for.
 * @returns Every reviewer row recorded for this run so far, in no particular order.
 */
export async function listReviewerExecutions(
  database: Pick<D1Database, "prepare">,
  runId: string,
): Promise<ReviewerExecutionRow[]> {
  const { results } = await database
    .prepare(
      `SELECT role, model, status, skipped_reason, error_detail, cost_usd, tokens_in,
              tokens_out, cost_source, raw_output
       FROM review_reviewers WHERE run_id = ?`,
    )
    .bind(runId)
    .all<ReviewerExecutionDbRow>();
  return results.map((row) => ({
    role: row.role as ReviewerRole,
    model: row.model,
    status: row.status as ReviewerStatus,
    skippedReason: row.skipped_reason,
    errorDetail: row.error_detail,
    costUsd: row.cost_usd,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costSource: row.cost_source as ReviewerCostSource,
    rawOutput: row.raw_output,
  }));
}
