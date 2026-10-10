import type { ReviewerProgress, ReviewerState } from "./types";

/**
 * Apply one Workflow progress event to a `ReviewRunState.reviewers` array, producing a new array
 * (docs/07-PR-REVIEW-AGENT.md, "Review Orchestration": `ReviewRunAgent.onWorkflowProgress()`).
 * The **only** place a `"reviewer_started"` transition (`status: "running"`) is ever reflected
 * in `state` at all -- `ReviewPipelineWorkflow` deliberately never durably `mergeAgentState()`s
 * that specific transition (it is "fine to lose on a mid-flight interruption; it is only a UI
 * liveness cue, never the source of truth"). Every other event this function handles is also
 * separately, durably persisted by the Workflow's own `step.mergeAgentState()` call around the
 * same transition -- this function's role there is only to keep a *currently connected* client's
 * projection in sync a moment sooner, via the broadcast `onWorkflowProgress()` also sends.
 *
 * Factored out into its own pure function so `ReviewRunAgent.onWorkflowProgress()`'s own logic
 * is unit-testable with no Durable Object runtime involved.
 *
 * @param reviewers The state's current reviewers array.
 * @param progress The Workflow's own progress payload.
 * @returns A new array with the matching role's entry patched; every other entry unchanged
 * (by reference), and the input array itself never mutated.
 */
export function applyReviewerProgress(
  reviewers: readonly ReviewerState[],
  progress: ReviewerProgress,
): ReviewerState[] {
  return reviewers.map((reviewer) => {
    if (reviewer.role !== progress.role) {
      return reviewer;
    }
    switch (progress.event) {
      case "reviewer_started":
        return { ...reviewer, status: "running" as const };
      case "reviewer_completed":
        return {
          ...reviewer,
          status: "done" as const,
          findingCount: progress.findingCount ?? reviewer.findingCount,
        };
      case "reviewer_skipped":
        return { ...reviewer, status: "skipped" as const };
      case "reviewer_failed":
        return { ...reviewer, status: "error" as const };
      case "cost_reconciled":
        return {
          ...reviewer,
          costUsd: progress.costUsd ?? reviewer.costUsd,
          costSource: "gateway" as const,
        };
      default:
        return reviewer;
    }
  });
}
