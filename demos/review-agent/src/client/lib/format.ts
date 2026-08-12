import type {
  FindingPriority,
  ReviewerCostSource,
  ReviewerRole,
  ReviewerStatus,
  ReviewRunStatus,
} from "../stores/reviews";

/** Human-readable label for each reviewer role, matching
 * `../../worker/review/report.ts`'s `ROLE_LABELS` (duplicated -- a plain four-entry lookup
 * table, not worth a cross-boundary import for). */
export const ROLE_LABELS: Record<ReviewerRole, string> = {
  architecture: "Architecture",
  security: "Security",
  "code-quality": "Code Quality",
  accessibility: "Accessibility",
};

/** Human-readable label for a run's own overall status. */
export const RUN_STATUS_LABELS: Record<ReviewRunStatus, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

/** Vuetify theme color name for a run's overall status chip -- always paired with
 * {@link RUN_STATUS_LABELS}'s text label, never color alone (WCAG 1.4.1 "Use of Color"). */
export const RUN_STATUS_COLORS: Record<ReviewRunStatus, string> = {
  running: "info",
  completed: "success",
  failed: "error",
};

/** Human-readable label for one reviewer's own lifecycle status. */
export const REVIEWER_STATUS_LABELS: Record<ReviewerStatus, string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  skipped: "Skipped",
  error: "Failed",
};

/** Vuetify theme color name for one reviewer's status chip. */
export const REVIEWER_STATUS_COLORS: Record<ReviewerStatus, string> = {
  queued: "surface-variant",
  running: "info",
  done: "success",
  skipped: "surface-variant",
  error: "error",
};

/** Vuetify theme color name for a severity/priority chip (`P0` most severe). */
export const PRIORITY_COLORS: Record<FindingPriority, string> = {
  P0: "error",
  P1: "warning",
  P2: "info",
  P3: "surface-variant",
};

/**
 * Format a confirmed or pending cost for display, always labeled with its source
 * (docs/07-PR-REVIEW-AGENT.md, "Cost Tracking": "never blended into a single ambiguous number").
 *
 * @param costUsd The reviewer's/run's cost, or `null` when nothing has been confirmed yet.
 * @param costSource Whether `costUsd` (when non-`null`) is an AI-Gateway-confirmed figure.
 * Ignored when `costUsd` is `null` -- there is nothing to attribute a source to yet.
 * @returns A short display string, for example `"$0.0021 (AI Gateway)"` or `"Pending"`.
 */
export function formatCost(
  costUsd: number | null,
  costSource?: ReviewerCostSource,
): string {
  if (costUsd === null) {
    return "Pending";
  }
  const amount = `$${costUsd.toFixed(4)}`;
  return costSource === "gateway" ? `${amount} (AI Gateway)` : amount;
}

/**
 * Format an ISO 8601 timestamp for display in the browser's own locale, or a placeholder for a
 * run that has not completed yet.
 *
 * @param isoTimestamp The timestamp to format, or `null`.
 * @returns A locale-formatted date/time string, or `"—"` when `isoTimestamp` is `null`.
 */
export function formatTimestamp(isoTimestamp: string | null): string {
  if (isoTimestamp === null) {
    return "—";
  }
  return new Date(isoTimestamp).toLocaleString();
}
