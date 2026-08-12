import type { Provider } from "../providers/types";
import type { MergedFinding, Priority } from "./merge";
import type { ReviewerRole } from "./roles";

/** The subset of a `review_runs` row {@link buildFullReport}/{@link buildCommentBody} need --
 * never the full `ReviewRun` type, so this module stays decoupled from `../data/reviewRuns.ts`. */
export interface ReviewRunReportSummary {
  readonly id: string;
  readonly provider: Provider;
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly prTitle: string;
}

/** One reviewer's outcome, for the full report's per-reviewer collapsible section. */
export interface ReviewerReportMeta {
  readonly role: ReviewerRole;
  /** The literal model id this reviewer ran (`src/models.ts`), or `null` when `status` is
   * `"skipped"` (no model was ever called). */
  readonly model: string | null;
  readonly status: "done" | "skipped" | "error";
  /** Populated only when `status` is `"skipped"`. */
  readonly skippedReason: string | null;
  /** Populated only when `status` is `"error"`. */
  readonly errorDetail: string | null;
  /** This reviewer's full raw prose output, or `null` when `status` is not `"done"`. */
  readonly rawOutput: string | null;
}

const ROLE_LABELS: Record<ReviewerRole, string> = {
  architecture: "Architecture",
  security: "Security",
  "code-quality": "Code Quality",
  accessibility: "Accessibility",
};

/** Human-readable label for a PR (GitHub) or MR (GitLab) -- reused everywhere both report
 * representations refer to the reviewed change. */
function prLabel(run: ReviewRunReportSummary): string {
  const kind = run.provider === "github" ? "PR" : "MR";
  return `${run.repoFullName} ${kind} #${run.prNumber} ("${run.prTitle}")`;
}

/** Escape a value for safe embedding in a single Markdown table cell -- collapse newlines to a
 * space and escape literal pipe characters, which would otherwise break the table's column
 * count. */
function escapeCell(value: string): string {
  return value.replaceAll("\n", " ").replaceAll("|", "\\|");
}

/** Count merged findings by {@link Priority}, always returning all four keys (zero-filled) so a
 * severity table never omits a row. */
function countByPriority(
  findings: readonly MergedFinding[],
): Record<Priority, number> {
  const counts: Record<Priority, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of findings) {
    counts[finding.priority] += 1;
  }
  return counts;
}

/** Build the P0-P3 severity count table Markdown, shared verbatim by both report
 * representations (docs/07-PR-REVIEW-AGENT.md, "Report Assembly And Comment Posting": "the
 * executive summary and severity table in full" for the comment). */
function buildSeverityTable(counts: Record<Priority, number>): string {
  const total = counts.P0 + counts.P1 + counts.P2 + counts.P3;
  return [
    "| Priority | Count |",
    "| --- | --- |",
    `| P0 | ${counts.P0} |`,
    `| P1 | ${counts.P1} |`,
    `| P2 | ${counts.P2} |`,
    `| P3 | ${counts.P3} |`,
    `| **Total** | **${total}** |`,
  ].join("\n");
}

/** Build a Markdown findings table for an arbitrary (already-filtered) subset of merged
 * findings -- shared by the full report's complete table and the comment's P0/P1-only table. */
function buildFindingsTable(findings: readonly MergedFinding[]): string {
  const rows = findings.map((finding) => {
    const location =
      finding.filePath === null
        ? "-"
        : finding.lineNumber === null
          ? finding.filePath
          : `${finding.filePath}:${finding.lineNumber}`;
    return (
      `| ${finding.priority} | ${escapeCell(finding.findingRef)} | ` +
      `${escapeCell(finding.category)} | ${escapeCell(location)} | ` +
      `${escapeCell(finding.finding)} | ${escapeCell(finding.recommendation)} |`
    );
  });
  return [
    "| Priority | Ref | Category | Location | Finding | Recommendation |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/** Build the executive summary paragraph, honest about an empty findings list rather than
 * manufacturing content (docs/07-PR-REVIEW-AGENT.md, "Report Assembly And Comment Posting":
 * "post a short, honest 'no findings' comment rather than an empty table"). */
function buildExecutiveSummary(
  run: ReviewRunReportSummary,
  mergedFindings: readonly MergedFinding[],
): string {
  if (mergedFindings.length === 0) {
    return `No findings were reported by any reviewer for ${prLabel(run)}.`;
  }
  const counts = countByPriority(mergedFindings);
  return (
    `Reviewed ${prLabel(run)}: ${mergedFindings.length} finding(s) total -- ` +
    `${counts.P0} P0, ${counts.P1} P1, ${counts.P2} P2, ${counts.P3} P3.`
  );
}

/**
 * Build the run's full canonical Markdown report -- an executive summary, the P0-P3 severity
 * count table, the complete findings table, and each reviewer's raw output under a collapsible
 * `<details>` section (docs/07-PR-REVIEW-AGENT.md, "Report Assembly And Comment Posting"). This
 * is what `review_runs.full_report` stores and the UI's report page renders.
 *
 * @param run The run's identifying summary.
 * @param mergedFindings The complete, already-merged findings list (`./merge.ts`).
 * @param reviewers Every reviewer's own outcome (done/skipped/error) and raw output.
 * @returns The complete Markdown document.
 */
export function buildFullReport(
  run: ReviewRunReportSummary,
  mergedFindings: readonly MergedFinding[],
  reviewers: readonly ReviewerReportMeta[],
): string {
  const sections = [
    `# PR Review Report: ${run.repoFullName} #${run.prNumber}`,
    "## Executive Summary",
    buildExecutiveSummary(run, mergedFindings),
    "## Severity Summary",
    buildSeverityTable(countByPriority(mergedFindings)),
    "## Findings",
    mergedFindings.length > 0
      ? buildFindingsTable(mergedFindings)
      : "No findings were reported by any reviewer.",
    "## Reviewer Output",
    reviewers
      .map((reviewer) => {
        const modelSuffix = reviewer.model ? `, ${reviewer.model}` : "";
        const body =
          reviewer.status === "skipped"
            ? (reviewer.skippedReason ?? "Skipped.")
            : reviewer.status === "error"
              ? `This reviewer failed: ${reviewer.errorDetail ?? "unknown error"}`
              : (reviewer.rawOutput ?? "_No output recorded._");
        return (
          `<details>\n<summary>${ROLE_LABELS[reviewer.role]} ` +
          `(${reviewer.status}${modelSuffix})</summary>\n\n${body}\n\n</details>`
        );
      })
      .join("\n\n"),
  ];
  return sections.join("\n\n");
}

/**
 * Build the trimmed comment body posted to the originating PR/MR: the executive summary and
 * severity table in full, then only the P0/P1 findings (P2/P3 omitted with a one-line note), and
 * a link back to the full report (docs/07-PR-REVIEW-AGENT.md, "Report Assembly And Comment
 * Posting"). Shares {@link MergedFinding} with {@link buildFullReport} so the two
 * representations can never drift from each other.
 *
 * @param run The run's identifying summary.
 * @param mergedFindings The complete, already-merged findings list (`./merge.ts`) -- this
 * function does its own P0/P1 filtering; callers must not pre-filter it.
 * @param reportBaseUrl The UI's own base URL (for example `https://review-agent.cfapps.uk`) --
 * passed in rather than hardcoded so this function stays testable with no network/environment
 * dependency.
 * @returns The comment Markdown.
 */
export function buildCommentBody(
  run: ReviewRunReportSummary,
  mergedFindings: readonly MergedFinding[],
  reportBaseUrl: string,
): string {
  const reportUrl = `${reportBaseUrl}/reviews/${run.id}`;
  const sections = [`## PR Review: ${run.repoFullName} #${run.prNumber}`];
  sections.push(buildExecutiveSummary(run, mergedFindings));

  if (mergedFindings.length > 0) {
    sections.push(buildSeverityTable(countByPriority(mergedFindings)));

    const topFindings = mergedFindings.filter(
      (finding) => finding.priority === "P0" || finding.priority === "P1",
    );
    const omittedCount = mergedFindings.length - topFindings.length;
    sections.push(
      topFindings.length > 0
        ? buildFindingsTable(topFindings)
        : "No P0/P1 findings -- see the full report for lower-priority findings.",
    );
    if (omittedCount > 0) {
      sections.push(
        `+${omittedCount} more finding(s) -- see the full report for the complete list.`,
      );
    }
  }

  sections.push(`[View the full report](${reportUrl})`);
  return sections.join("\n\n");
}
