import { throwIfNull } from "@adrianhall/cloudflare-toolkit/guards";
import type { Provider } from "../providers/types";
import {
  listReviewerExecutions,
  type ReviewerCostSource,
  type ReviewerStatus,
} from "./reviewReviewers";
import { listReviewFindings, type ReviewFindingRow } from "./reviewFindings";
import { parseFencedFindings } from "../review/schema";
import type { ReviewerRole } from "../review/roles";

/** `review_runs.status` values (`migrations/0001_create_review_tables.sql`'s `CHECK`
 * constraint). */
export type ReviewRunStatus = "running" | "completed" | "failed";

/** `review_runs.trigger` values. */
export type ReviewRunTrigger = "webhook" | "manual";

/** A `review_runs` row, mapped to camelCase (docs/07-PR-REVIEW-AGENT.md, "Data Model"). */
export interface ReviewRun {
  readonly id: string;
  readonly workflowInstanceId: string | null;
  readonly provider: Provider;
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly prTitle: string;
  readonly prAuthor: string;
  readonly headSha: string;
  readonly trigger: ReviewRunTrigger;
  readonly triggeredByEmail: string | null;
  readonly status: ReviewRunStatus;
  readonly diffTruncated: boolean;
  readonly changedFileCount: number;
  readonly commentUrl: string | null;
  readonly errorDetail: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

/** Input to {@link createOrGetReviewRun}. */
export interface CreateReviewRunInput {
  /** A pre-minted `crypto.randomUUID()`, only actually persisted when this call wins the race
   * to create the row -- see {@link createOrGetReviewRun}'s own doc comment. */
  readonly id: string;
  readonly provider: Provider;
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly prTitle: string;
  readonly prAuthor: string;
  readonly headSha: string;
  readonly trigger: ReviewRunTrigger;
  readonly triggeredByEmail: string | null;
  readonly diffTruncated: boolean;
  readonly changedFileCount: number;
}

/** The result of {@link createOrGetReviewRun}. */
export interface CreateOrGetReviewRunResult {
  readonly run: ReviewRun;
  /** Whether this call actually inserted `run` (`true`), or found and returned a pre-existing
   * row for the same `(provider, repoFullName, prNumber, headSha)` tuple instead (`false`). */
  readonly created: boolean;
}

/** Raw snake-cased `review_runs` row as returned by D1. */
interface ReviewRunRow {
  id: string;
  workflow_instance_id: string | null;
  provider: string;
  repo_full_name: string;
  pr_number: number;
  pr_url: string;
  pr_title: string;
  pr_author: string;
  head_sha: string;
  trigger: string;
  triggered_by_email: string | null;
  status: string;
  diff_truncated: number;
  changed_file_count: number;
  comment_url: string | null;
  error_detail: string | null;
  created_at: string;
  completed_at: string | null;
}

/** Every `review_runs` column this repository ever selects -- never `SELECT *`. Deliberately
 * excludes `full_report`: every current caller of {@link getReviewRunById} (the
 * `merge-and-post-comment` step's own already-posted-comment guard) only ever needs
 * `comment_url`/`status`, and the full Markdown report can be tens of kilobytes -- no reason to
 * pull it off disk for a guard that only reads `comment_url`. */
const REVIEW_RUN_COLUMNS = `id, workflow_instance_id, provider, repo_full_name, pr_number,
  pr_url, pr_title, pr_author, head_sha, trigger, triggered_by_email, status, diff_truncated,
  changed_file_count, comment_url, error_detail, created_at, completed_at`;

/** Convert a raw D1 row into a {@link ReviewRun}. */
function toReviewRun(row: ReviewRunRow): ReviewRun {
  return {
    id: row.id,
    workflowInstanceId: row.workflow_instance_id,
    provider: row.provider as Provider,
    repoFullName: row.repo_full_name,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    prTitle: row.pr_title,
    prAuthor: row.pr_author,
    headSha: row.head_sha,
    trigger: row.trigger as ReviewRunTrigger,
    triggeredByEmail: row.triggered_by_email,
    status: row.status as ReviewRunStatus,
    diffTruncated: row.diff_truncated === 1,
    changedFileCount: row.changed_file_count,
    commentUrl: row.comment_url,
    errorDetail: row.error_detail,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/**
 * Look up an existing review run by the same tuple `review_runs` is `UNIQUE`-constrained on.
 * Only ever called by {@link createOrGetReviewRun}'s fallback path, after an `INSERT ...
 * ON CONFLICT DO NOTHING` has already reported a conflict.
 */
async function getReviewRunByUniqueKey(
  database: Pick<D1Database, "prepare">,
  provider: Provider,
  repoFullName: string,
  prNumber: number,
  headSha: string,
): Promise<ReviewRun | null> {
  const row = await database
    .prepare(
      `SELECT ${REVIEW_RUN_COLUMNS} FROM review_runs
       WHERE provider = ? AND repo_full_name = ? AND pr_number = ? AND head_sha = ?
       LIMIT 1`,
    )
    .bind(provider, repoFullName, prNumber, headSha)
    .first<ReviewRunRow>();
  return row === null ? null : toReviewRun(row);
}

/**
 * Idempotently create a review run, or return the existing one for the same
 * `(provider, repoFullName, prNumber, headSha)` tuple (docs/07-PR-REVIEW-AGENT.md, "Git
 * Provider Integration" and "Data Model" -- the `review_runs.UNIQUE (provider, repo_full_name,
 * pr_number, head_sha)` constraint). A webhook retry whose delivery-id row already expired, a
 * legitimate second delivery, or a manual trigger racing a webhook for the same commit all
 * converge on the one row this returns, rather than erroring or creating a duplicate run --
 * "the same idempotent-upsert philosophy demo 6 uses for its admin bootstrap"
 * (`demos/agentic-ai-chat/src/worker/users/repository.ts`'s `ensureUser()`).
 *
 * Uses `INSERT ... ON CONFLICT DO NOTHING RETURNING *` (confirmed against D1's actual SQLite
 * dialect via `wrangler d1 execute --local` -- `DO NOTHING` correctly yields zero `RETURNING`
 * rows on a conflict, never an error) so the common "this is a new run" path is a single round
 * trip; only the conflict path performs a second, fallback `SELECT`.
 *
 * @param database D1 capability used to prepare the repository's statements.
 * @param input Caller-supplied run details, including a pre-minted `id` that is only actually
 * used when this call wins the race to create the row.
 * @returns The run (new or pre-existing) and whether this call created it.
 * @throws {NullError} If a conflict is detected but the fallback `SELECT` still finds no row --
 * a defensive guard against an impossible state (the `UNIQUE` constraint guarantees some row
 * exists for that tuple once a conflict has been reported), not an expected outcome.
 */
export async function createOrGetReviewRun(
  database: Pick<D1Database, "prepare">,
  input: CreateReviewRunInput,
): Promise<CreateOrGetReviewRunResult> {
  const inserted = await database
    .prepare(
      `INSERT INTO review_runs (
         id, provider, repo_full_name, pr_number, pr_url, pr_title, pr_author, head_sha,
         trigger, triggered_by_email, status, diff_truncated, changed_file_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
       ON CONFLICT (provider, repo_full_name, pr_number, head_sha) DO NOTHING
       RETURNING ${REVIEW_RUN_COLUMNS}`,
    )
    .bind(
      input.id,
      input.provider,
      input.repoFullName,
      input.prNumber,
      input.prUrl,
      input.prTitle,
      input.prAuthor,
      input.headSha,
      input.trigger,
      input.triggeredByEmail,
      input.diffTruncated ? 1 : 0,
      input.changedFileCount,
    )
    .first<ReviewRunRow>();

  if (inserted !== null) {
    return { run: toReviewRun(inserted), created: true };
  }

  const existing = await getReviewRunByUniqueKey(
    database,
    input.provider,
    input.repoFullName,
    input.prNumber,
    input.headSha,
  );
  throwIfNull(
    existing,
    `review_runs conflicted for (${input.provider}, ${input.repoFullName}, ` +
      `#${input.prNumber}@${input.headSha}) but the fallback SELECT still found no row`,
  );
  return { run: existing, created: false };
}

/**
 * Look up a run by its own `id` -- used by `ReviewPipelineWorkflow`'s `merge-and-post-comment`
 * step's own idempotent already-posted-comment guard (docs/07-PR-REVIEW-AGENT.md, "Review
 * Orchestration": "its first line re-reads the `review_runs` row and returns immediately if
 * `comment_url` is already set").
 *
 * @param database D1 capability used to prepare the query.
 * @param runId The run to look up.
 * @returns The run, or `null` if no row with this `id` exists.
 */
export async function getReviewRunById(
  database: Pick<D1Database, "prepare">,
  runId: string,
): Promise<ReviewRun | null> {
  const row = await database
    .prepare(
      `SELECT ${REVIEW_RUN_COLUMNS} FROM review_runs WHERE id = ? LIMIT 1`,
    )
    .bind(runId)
    .first<ReviewRunRow>();
  return row === null ? null : toReviewRun(row);
}

/**
 * Record the real outcome of `ReviewPipelineWorkflow`'s `fetch-diff` step: the Workflow instance
 * id (unknown at trigger time, since `ReviewRunAgent.start()` calls `this.runWorkflow()` only
 * after the D1 row already exists) and the diff's real truncation/changed-file-count figures
 * (placeholders at trigger time -- neither GitHub's `pull_request` nor GitLab's `Merge Request
 * Hook` webhook payload includes a changed-file list, so `../routes/webhooks.ts` can only ever
 * insert `0`/`false` for these two columns). Called from inside the `fetch-diff` step itself, so
 * a step retry re-runs this idempotently (every field is a plain overwrite, never an increment).
 *
 * @param database D1 capability used to prepare the update.
 * @param runId The run this diff was fetched for.
 * @param input The real workflow instance id and diff outcome.
 */
export async function recordFetchDiffOutcome(
  database: Pick<D1Database, "prepare">,
  runId: string,
  input: {
    readonly workflowInstanceId: string;
    readonly diffTruncated: boolean;
    readonly changedFileCount: number;
  },
): Promise<void> {
  await database
    .prepare(
      `UPDATE review_runs
       SET workflow_instance_id = ?, diff_truncated = ?, changed_file_count = ?
       WHERE id = ?`,
    )
    .bind(
      input.workflowInstanceId,
      input.diffTruncated ? 1 : 0,
      input.changedFileCount,
      runId,
    )
    .run();
}

/**
 * Mark a run `completed` once its comment has been posted (docs/07-PR-REVIEW-AGENT.md, "Review
 * Orchestration", the `merge-and-post-comment` step: "updates `review_runs` with
 * `status: "completed"`, `comment_url`, the full report, and `completed_at`").
 *
 * @param database D1 capability used to prepare the update.
 * @param runId The run to mark completed.
 * @param input The posted comment's URL and the run's full Markdown report
 * (`../review/report.ts`'s `buildFullReport()`).
 */
export async function markRunCompleted(
  database: Pick<D1Database, "prepare">,
  runId: string,
  input: { readonly commentUrl: string; readonly fullReport: string },
): Promise<void> {
  await database
    .prepare(
      `UPDATE review_runs
       SET status = 'completed', comment_url = ?, full_report = ?,
           completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .bind(input.commentUrl, input.fullReport, runId)
    .run();
}

/**
 * Mark a run `failed` with the Workflow's own error message (docs/07-PR-REVIEW-AGENT.md,
 * "Review Orchestration": `ReviewRunAgent.onWorkflowError()` calls this). The only D1 write
 * `ReviewRunAgent` itself ever performs (Implementation Plan Phase 4, item 20: "This class holds
 * no pipeline logic, no D1 writes of its own besides `markRunFailed()`").
 *
 * @param database D1 capability used to prepare the update.
 * @param runId The run to mark failed.
 * @param errorMessage The Workflow's own error message -- never a raw stack trace or provider
 * token; `AgentWorkflow`'s `onWorkflowError()` callback already receives only a plain `string`.
 */
export async function markRunFailed(
  database: Pick<D1Database, "prepare">,
  runId: string,
  errorMessage: string,
): Promise<void> {
  await database
    .prepare(
      `UPDATE review_runs
       SET status = 'failed', error_detail = ?,
           completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .bind(errorMessage, runId)
    .run();
}

/** A page of `review_runs` history rows, exactly what `GET /api/reviews`'s history list needs
 * (docs/07-PR-REVIEW-AGENT.md, "API And Routing": "id, provider, repo, PR number/title, status,
 * total cost, created/completed timestamps") -- deliberately excludes every column the list
 * view never renders (`pr_url`, `pr_author`, `head_sha`, `trigger`, `triggered_by_email`,
 * `diff_truncated`, `changed_file_count`, `comment_url`, `error_detail`, `full_report`), which
 * `GET /api/reviews/:id`'s full detail view (`getReviewRunDetail()`) covers instead. */
export interface ReviewRunSummary {
  readonly id: string;
  readonly provider: Provider;
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly prTitle: string;
  readonly status: ReviewRunStatus;
  /**
   * The sum of every one of this run's `review_reviewers.cost_usd` values recorded so far
   * (docs/07-PR-REVIEW-AGENT.md, "Cost Tracking"). SQL's `SUM()` ignores `NULL` inputs and
   * itself returns `NULL` when every input was `NULL` (or there are no reviewer rows at all
   * yet) -- surfaced here as `null` rather than `0` so a run with zero *confirmed* cost so far
   * is never indistinguishable from a run AI Gateway has confirmed actually cost nothing,
   * matching this scenario's own "never blend a 'pending' reviewer into a number that looks
   * confirmed" cost-tracking rule.
   */
  readonly totalCostUsd: number | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

/** Raw snake-cased row returned by {@link listReviewRuns}'s own joined/aggregated query. */
interface ReviewRunSummaryDbRow {
  id: string;
  provider: string;
  repo_full_name: string;
  pr_number: number;
  pr_title: string;
  status: string;
  total_cost_usd: number | null;
  created_at: string;
  completed_at: string | null;
}

/** Input to {@link listReviewRuns}. */
export interface ListReviewRunsInput {
  /** 1-indexed page number. Values below `1` are clamped up to `1` defensively -- primary
   * validation of caller-supplied input belongs to `../review/reviewsValidation.ts`, called by
   * `../routes/reviews.ts` before this repository function ever runs. */
  readonly page: number;
  /** Rows per page, clamped to `[1, 100]` for the same defense-in-depth reason as `page`. */
  readonly pageSize: number;
}

/** The result of {@link listReviewRuns}. */
export interface ListReviewRunsResult {
  readonly runs: readonly ReviewRunSummary[];
  /** The total number of `review_runs` rows across every page, for the UI's own pagination
   * controls -- not merely `runs.length`, which is at most one page's worth. */
  readonly total: number;
}

/**
 * List a paginated page of run history, newest first (docs/07-PR-REVIEW-AGENT.md, "Data Model":
 * "let a signed-in user browse a paginated history of past runs"). One `LEFT JOIN` against
 * `review_reviewers` computes each run's running cost total in the same query, rather than a
 * separate per-run round trip -- `GROUP BY r.id` collapses the join back to one row per run.
 *
 * @param database D1 capability used to prepare the paginated query and the total-count query.
 * @param input The requested page and page size.
 * @returns This page's runs and the total row count across every page.
 */
export async function listReviewRuns(
  database: Pick<D1Database, "prepare">,
  input: ListReviewRunsInput,
): Promise<ListReviewRunsResult> {
  const page = Math.max(1, Math.trunc(input.page));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(input.pageSize)));
  const offset = (page - 1) * pageSize;

  const [{ results }, countRow] = await Promise.all([
    database
      .prepare(
        `SELECT r.id, r.provider, r.repo_full_name, r.pr_number, r.pr_title, r.status,
                r.created_at, r.completed_at, SUM(rv.cost_usd) AS total_cost_usd
         FROM review_runs r
         LEFT JOIN review_reviewers rv ON rv.run_id = r.id
         GROUP BY r.id
         ORDER BY r.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(pageSize, offset)
      .all<ReviewRunSummaryDbRow>(),
    database
      .prepare(`SELECT COUNT(*) AS count FROM review_runs`)
      .first<{ count: number }>(),
  ]);

  return {
    runs: results.map((row) => ({
      id: row.id,
      provider: row.provider as Provider,
      repoFullName: row.repo_full_name,
      prNumber: row.pr_number,
      prTitle: row.pr_title,
      status: row.status as ReviewRunStatus,
      totalCostUsd: row.total_cost_usd,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    })),
    total: countRow?.count ?? 0,
  };
}

/** One reviewer's outcome for `GET /api/reviews/:id`'s full run detail (docs/07-PR-REVIEW-AGENT.md,
 * "API And Routing"). */
export interface ReviewerDetail {
  readonly role: ReviewerRole;
  readonly model: string | null;
  readonly status: ReviewerStatus;
  readonly skippedReason: string | null;
  readonly errorDetail: string | null;
  readonly costUsd: number | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly costSource: ReviewerCostSource;
  /** This reviewer's own pre-merge finding count, re-derived from its persisted raw output --
   * see {@link countReviewerFindings}'s own doc comment for why neither `review_reviewers` nor
   * `review_findings` stores this number directly. */
  readonly findingCount: number;
}

/** The full assembled response for `GET /api/reviews/:id` (docs/07-PR-REVIEW-AGENT.md, "API And
 * Routing": "Full run detail: reviewer rows, merged findings, the full Markdown report, and the
 * posted comment URL"). */
export interface ReviewRunDetail {
  readonly run: ReviewRun & { readonly fullReport: string | null };
  readonly reviewers: readonly ReviewerDetail[];
  readonly findings: readonly ReviewFindingRow[];
}

/** Raw snake-cased `review_runs` row as read by {@link getReviewRunDetail}'s own query -- every
 * {@link ReviewRunRow} column plus `full_report`, which {@link REVIEW_RUN_COLUMNS} deliberately
 * excludes for every other reader (see that constant's own doc comment). */
interface ReviewRunDetailDbRow extends ReviewRunRow {
  full_report: string | null;
}

/**
 * Re-derive one reviewer's own pre-merge finding count from its persisted raw output. Neither
 * `review_reviewers` nor `review_findings` stores a per-reviewer finding count directly once
 * findings are merged: `review_findings.merged_from` only records contribution for a genuinely
 * merged (multiple-contributor) row -- a single-contributor row's originating role (and
 * therefore which reviewer it came from) is not preserved in D1 at all, by design (see
 * `../review/merge.ts`'s `MergedFinding.role` doc comment: "not a `review_findings` column ...
 * callers persisting a row should not assume this survives a D1 round trip"). Re-parsing this
 * reviewer's own `raw_output` with the same `parseFencedFindings()` the Workflow itself already
 * used to validate that output the first time (`../review/runReviewer.ts`) is the only faithful
 * way to recover this number for a completed run's read-only detail view, without adding a new
 * D1 column purely to cache a value already fully recoverable from data persisted for a
 * different reason (the full report's own per-reviewer collapsible section).
 *
 * @param reviewer The reviewer row to compute a finding count for.
 * @returns The number of findings this reviewer's own raw output validated to, or `0` for a
 * `"skipped"`/`"error"` reviewer (no raw output at all) or the defensive fallback below.
 */
function countReviewerFindings(reviewer: {
  readonly status: ReviewerStatus;
  readonly rawOutput: string | null;
}): number {
  if (reviewer.status !== "done" || reviewer.rawOutput === null) {
    return 0;
  }
  try {
    return parseFencedFindings(reviewer.rawOutput).length;
  } catch {
    // Defensive only -- `runReviewer()` already validated this exact text via the same parser
    // before persisting it (`../workflows/ReviewPipelineWorkflow.ts`'s `review:<role>` step), so
    // a parse failure here would mean the persisted text has since diverged from what was
    // validated. Fail soft (treat as zero) rather than making the whole detail endpoint 500
    // over one reviewer's display-only count.
    return 0;
  }
}

/**
 * Assemble `GET /api/reviews/:id`'s full run detail: the run itself (including its full
 * Markdown report), every reviewer's execution outcome (with a re-derived finding count -- see
 * {@link countReviewerFindings}), and the complete merged findings list
 * (docs/07-PR-REVIEW-AGENT.md, "API And Routing"). Three repository queries composed here
 * (rather than in `../routes/reviews.ts`) so this exact assembly is reusable and independently
 * testable, mirroring how `../workflows/ReviewPipelineWorkflow.ts`'s own `merge-and-post-comment`
 * step already composes `getReviewRunById()` + `listReviewReviewers()` for the *write* side of
 * the same run.
 *
 * @param database D1 capability used to prepare every underlying query.
 * @param runId The run to look up.
 * @returns The full assembled detail, or `null` when no run with this `id` exists.
 */
export async function getReviewRunDetail(
  database: Pick<D1Database, "prepare">,
  runId: string,
): Promise<ReviewRunDetail | null> {
  const row = await database
    .prepare(
      `SELECT ${REVIEW_RUN_COLUMNS}, full_report FROM review_runs WHERE id = ? LIMIT 1`,
    )
    .bind(runId)
    .first<ReviewRunDetailDbRow>();
  if (row === null) {
    return null;
  }

  const [reviewerRows, findings] = await Promise.all([
    listReviewerExecutions(database, runId),
    listReviewFindings(database, runId),
  ]);

  const reviewers: ReviewerDetail[] = reviewerRows.map((reviewer) => ({
    role: reviewer.role,
    model: reviewer.model,
    status: reviewer.status,
    skippedReason: reviewer.skippedReason,
    errorDetail: reviewer.errorDetail,
    costUsd: reviewer.costUsd,
    tokensIn: reviewer.tokensIn,
    tokensOut: reviewer.tokensOut,
    costSource: reviewer.costSource,
    findingCount: countReviewerFindings(reviewer),
  }));

  return {
    run: { ...toReviewRun(row), fullReport: row.full_report },
    reviewers,
    findings,
  };
}
