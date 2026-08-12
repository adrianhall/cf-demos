/**
 * @file The four reviewer roles and their two distinct fixed orderings
 * (docs/07-PR-REVIEW-AGENT.md, "Reviewer Personas And Structured Findings" and "Review
 * Orchestration"). This demo deliberately uses **two different** role orderings for two
 * different purposes -- see {@link REVIEW_EXECUTION_ORDER} and {@link MERGE_SORT_ROLE_ORDER}'s
 * own doc comments for why that is intentional, not a typo.
 */

/** One of the four specialist reviewer passes (`migrations/0001_create_review_tables.sql`'s
 * `review_reviewers.role` `CHECK` constraint). */
export type ReviewerRole =
  | "architecture"
  | "security"
  | "code-quality"
  | "accessibility";

/**
 * The fixed order `ReviewPipelineWorkflow` actually runs the reviewers in
 * (docs/07-PR-REVIEW-AGENT.md, "Review Orchestration", step 2): cheaper/faster passes first, and
 * still one at a time, "so a presenter can narrate live". `accessibility` is skipped entirely
 * (no step, no billing) when no changed file has a UI-relevant extension --
 * `src/worker/review/uiFiles.ts`'s `hasUiRelevantChangedFile()`.
 */
export const REVIEW_EXECUTION_ORDER: readonly ReviewerRole[] = [
  "code-quality",
  "accessibility",
  "architecture",
  "security",
];

/**
 * The fixed order `mergeFindings()` (`./merge.ts`) sorts a merged finding's contributing role by,
 * after priority -- reused verbatim from the local `review-orchestrator` subagent's own sort
 * rule (docs/07-PR-REVIEW-AGENT.md, "Reviewer Personas And Structured Findings": "Sort the final
 * list by priority, then role (`architecture, security, code-quality, accessibility`)...").
 * Deliberately **different** from {@link REVIEW_EXECUTION_ORDER} -- one orders *when work runs*
 * (cost/speed-driven), the other orders *how results read* (severity-domain-driven, security and
 * architecture findings surfacing before code-quality/accessibility ones of equal priority) --
 * confirmed intentional by the scenario doc itself, not reconciled into one list.
 */
export const MERGE_SORT_ROLE_ORDER: readonly ReviewerRole[] = [
  "architecture",
  "security",
  "code-quality",
  "accessibility",
];
