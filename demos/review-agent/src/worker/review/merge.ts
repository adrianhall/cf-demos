import { MERGE_SORT_ROLE_ORDER, type ReviewerRole } from "./roles";
import type { RawFinding } from "./schema";

/** `review_findings.priority` values (`migrations/0001_create_review_tables.sql`'s `CHECK`
 * constraint). */
export type Priority = "P0" | "P1" | "P2" | "P3";

/** A single reviewer finding's own severity, reused from {@link RawFinding}. */
export type Severity = RawFinding["severity"];

/**
 * One row of a run's final, deduplicated findings list -- the output of {@link mergeFindings}
 * and the input every consumer (`./report.ts`, the eventual `review_findings` insert) shares, so
 * the full report and the posted comment can never drift from each other
 * (docs/07-PR-REVIEW-AGENT.md, "Report Assembly And Comment Posting").
 */
export interface MergedFinding {
  /** The higher-priority contributor's own ref, with a trailing `+` when this row merged more
   * than one reviewer's finding; unchanged (no `+`) for a single-contributor row. */
  readonly findingRef: string;
  readonly priority: Priority;
  readonly severity: Severity;
  readonly category: string;
  readonly filePath: string | null;
  readonly lineNumber: number | null;
  readonly finding: string;
  readonly recommendation: string;
  /** Comma-separated contributing roles (`./roles.ts`'s `MERGE_SORT_ROLE_ORDER` order), or
   * `null` for a single-contributor row. */
  readonly mergedFrom: string | null;
  /** The primary (highest-priority) contributing role -- used for this module's own sort rule
   * and by `./report.ts`; not a `review_findings` column (that table records contribution via
   * `merged_from` instead), so callers persisting a row should not assume this survives a D1
   * round trip. */
  readonly role: ReviewerRole;
}

/** Severity -> priority mapping, reused verbatim from the local `review-orchestrator` subagent
 * and NEVER overridden by anything else in this module (docs/07-PR-REVIEW-AGENT.md, "Reviewer
 * Personas And Structured Findings" / "Explicit Exceptions": "never overrides this mapping with
 * judgment"). A `critical` finding is always `P0`, full stop -- merging it with a lower-severity
 * finding at the same location can only ever keep or improve its priority, never demote it,
 * because {@link mergeFindings} always selects the LOWEST-ranked (highest-priority) contributor
 * as the merged row's own priority. */
const SEVERITY_TO_PRIORITY: Record<Severity, Priority> = {
  critical: "P0",
  high: "P1",
  medium: "P2",
  low: "P3",
};

/** Numeric rank for sorting/comparing priorities -- lower is higher-priority (`P0` sorts and
 * "wins" first). */
const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Numeric rank for {@link MERGE_SORT_ROLE_ORDER}, computed once. */
const ROLE_RANK: ReadonlyMap<ReviewerRole, number> = new Map(
  MERGE_SORT_ROLE_ORDER.map((role, index) => [role, index]),
);

/** One reviewer's contribution to a (possibly later-merged) finding group, tracked internally
 * while grouping. */
interface Contribution {
  readonly role: ReviewerRole;
  readonly raw: RawFinding;
  readonly priority: Priority;
}

/**
 * Deterministically merge every reviewer's own raw findings into one final list
 * (docs/07-PR-REVIEW-AGENT.md, "Reviewer Personas And Structured Findings"): two (or more)
 * findings from different reviewers merge into a single row only when they share an identical,
 * non-null `(filePath, lineNumber)` pair. This is a **pure, deterministic function** -- no model
 * call, no judgment about whether two differently-located findings share a root cause (that is
 * the real `review-orchestrator`'s job, deliberately not reproduced here -- see
 * docs/07-PR-REVIEW-AGENT.md, "Explicit Exceptions").
 *
 * @param perReviewerFindings Each active reviewer's own validated findings, keyed by role. A
 * role with no entry (skipped, or contributed nothing) is treated as an empty list.
 * @returns The final, sorted findings list -- priority ascending (`P0` first), then role
 * (`./roles.ts`'s `MERGE_SORT_ROLE_ORDER`), then `filePath` (nulls sorted last).
 */
export function mergeFindings(
  perReviewerFindings: Partial<Record<ReviewerRole, readonly RawFinding[]>>,
): MergedFinding[] {
  const groups = new Map<string, Contribution[]>();
  let ungroupedCounter = 0;

  // Iterate roles in a fixed order so groups with more than one contributor always encounter
  // contributions in the same deterministic order, regardless of the caller's own key order.
  for (const role of MERGE_SORT_ROLE_ORDER) {
    for (const raw of perReviewerFindings[role] ?? []) {
      const priority = SEVERITY_TO_PRIORITY[raw.severity];
      const key =
        raw.filePath !== null && raw.lineNumber !== null
          ? `${raw.filePath}:${raw.lineNumber}`
          : // A unique key per un-locatable finding -- these never merge with anything, per the
            // "non-null (filePath, lineNumber) pair" requirement above.
            `__ungrouped_${ungroupedCounter++}`;
      const contribution: Contribution = { role, raw, priority };
      const existing = groups.get(key);
      if (existing) {
        existing.push(contribution);
      } else {
        groups.set(key, [contribution]);
      }
    }
  }

  const merged: MergedFinding[] = [];
  for (const contributions of groups.values()) {
    // The merged row's priority/severity/text always come from the highest-priority (lowest
    // PRIORITY_RANK) contributor -- this is what makes "no override" structurally true: a
    // critical finding's P0 can only ever be kept, never replaced by a lower-priority
    // contributor's fields.
    let primary = contributions[0] as Contribution;
    for (const contribution of contributions.slice(1)) {
      if (
        PRIORITY_RANK[contribution.priority] < PRIORITY_RANK[primary.priority]
      ) {
        primary = contribution;
      }
    }

    const isMerged = contributions.length > 1;
    const mergedFrom = isMerged
      ? [...new Set(contributions.map((c) => c.role))]
          .sort((a, b) => (ROLE_RANK.get(a) ?? 0) - (ROLE_RANK.get(b) ?? 0))
          .join(",")
      : null;

    merged.push({
      findingRef: isMerged
        ? `${primary.raw.findingRef}+`
        : primary.raw.findingRef,
      priority: primary.priority,
      severity: primary.raw.severity,
      category: primary.raw.category,
      filePath: primary.raw.filePath,
      lineNumber: primary.raw.lineNumber,
      finding: primary.raw.finding,
      recommendation: primary.raw.recommendation,
      mergedFrom,
      role: primary.role,
    });
  }

  return merged.sort((a, b) => {
    const priorityDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    const roleDiff =
      (ROLE_RANK.get(a.role) ?? 0) - (ROLE_RANK.get(b.role) ?? 0);
    if (roleDiff !== 0) {
      return roleDiff;
    }
    if (a.filePath === b.filePath) {
      return 0;
    }
    if (a.filePath === null) {
      return 1;
    }
    if (b.filePath === null) {
      return -1;
    }
    return a.filePath.localeCompare(b.filePath);
  });
}
