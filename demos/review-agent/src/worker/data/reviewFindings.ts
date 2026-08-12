import type { MergedFinding, Priority, Severity } from "../review/merge";

/** One `review_findings` row, as read back by {@link listReviewFindings} -- every column except
 * the surrogate `id` (never exposed outside this repository) and `run_id` (redundant once the
 * caller already knows which run it queried for). */
export interface ReviewFindingRow {
  readonly findingRef: string;
  readonly priority: Priority;
  readonly severity: Severity;
  readonly category: string;
  readonly filePath: string | null;
  readonly lineNumber: number | null;
  readonly finding: string;
  readonly recommendation: string;
  /** Comma-separated contributing roles for a merged row, or `null` for a single-contributor
   * row (`./reviewRuns.ts`'s `getReviewRunDetail()` doc comment explains why a single
   * contributor's own role cannot be recovered from this column). */
  readonly mergedFrom: string | null;
}

/** Raw snake-cased `review_findings` row, as read back by {@link listReviewFindings}. */
interface ReviewFindingDbRow {
  finding_ref: string;
  priority: string;
  severity: string;
  category: string;
  file_path: string | null;
  line_number: number | null;
  finding: string;
  recommendation: string;
  merged_from: string | null;
}

/**
 * Idempotently replace a run's entire `review_findings` set with the freshly merged list
 * (docs/07-PR-REVIEW-AGENT.md, "Data Model": "Merged findings across every reviewer"). Called
 * once, from inside `ReviewPipelineWorkflow`'s own `merge-and-post-comment` step -- that step's
 * own already-posted-comment guard (re-reading `review_runs.comment_url` first) is what actually
 * makes a *retried* attempt of this step a no-op, so this function itself does not need its own
 * separate idempotency check; delete-then-insert is simply the simplest way to write "this run's
 * findings are exactly this list" in one call.
 *
 * @param database D1 capability used to prepare the delete/insert statements.
 * @param runId The run these findings belong to.
 * @param findings The complete, already-merged findings list (`../review/merge.ts`).
 */
export async function replaceMergedFindings(
  database: Pick<D1Database, "prepare">,
  runId: string,
  findings: readonly MergedFinding[],
): Promise<void> {
  await database
    .prepare("DELETE FROM review_findings WHERE run_id = ?")
    .bind(runId)
    .run();

  for (const finding of findings) {
    await database
      .prepare(
        `INSERT INTO review_findings (
           id, run_id, finding_ref, priority, severity, category, file_path, line_number,
           finding, recommendation, merged_from
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        runId,
        finding.findingRef,
        finding.priority,
        finding.severity,
        finding.category,
        finding.filePath,
        finding.lineNumber,
        finding.finding,
        finding.recommendation,
        finding.mergedFrom,
      )
      .run();
  }
}

/**
 * List a run's complete merged findings list, sorted by priority (`review_findings.priority`'s
 * own `P0`-`P3` values sort correctly as plain text, since `"P0" < "P1" < "P2" < "P3"`
 * lexically) and then file path -- the read side of {@link replaceMergedFindings}, used by
 * `../routes/reviews.ts`'s `GET /api/reviews/:id` (Implementation Plan Phase 5, item 23) via
 * `./reviewRuns.ts`'s `getReviewRunDetail()`.
 *
 * @param database D1 capability used to prepare the query.
 * @param runId The run to list findings for.
 * @returns Every merged finding recorded for this run, most severe first.
 */
export async function listReviewFindings(
  database: Pick<D1Database, "prepare">,
  runId: string,
): Promise<ReviewFindingRow[]> {
  const { results } = await database
    .prepare(
      `SELECT finding_ref, priority, severity, category, file_path, line_number, finding,
              recommendation, merged_from
       FROM review_findings WHERE run_id = ?
       ORDER BY priority ASC, file_path ASC`,
    )
    .bind(runId)
    .all<ReviewFindingDbRow>();
  return results.map((row) => ({
    findingRef: row.finding_ref,
    priority: row.priority as Priority,
    severity: row.severity as Severity,
    category: row.category,
    filePath: row.file_path,
    lineNumber: row.line_number,
    finding: row.finding,
    recommendation: row.recommendation,
    mergedFrom: row.merged_from,
  }));
}
