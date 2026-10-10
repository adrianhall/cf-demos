import type { PrReference } from "../providers/types";
import type { ReviewerRole } from "./roles";

/**
 * The payload `ReviewRunAgent.start()` receives and forwards, unmodified, to
 * `ReviewPipelineWorkflow.run()` as its Workflow params (docs/07-PR-REVIEW-AGENT.md, "Review
 * Orchestration"). Deliberately minimal: `runId` addresses both the Agent and the Workflow
 * instance it owns; `ref` is everything `GitProviderClient.fetchDiff()`/`getFileContent()`/
 * `postComment()` need to act on this PR/MR.
 *
 * This demo's actual webhook/manual-trigger payload (`../routes/webhooks.ts`, Implementation
 * Plan Phase 5's `POST /api/reviews`) never carries a changed-file list at trigger time --
 * neither GitHub's `pull_request` event nor GitLab's `Merge Request Hook` payload includes one
 * (`../providers/types.ts`'s `WebhookEvent.changedFiles` doc comment), and fetching one eagerly
 * before calling `start()` would duplicate `ReviewPipelineWorkflow`'s own `fetch-diff` step and
 * slow down the "respond quickly" webhook-acceptance path this repository's Agents SDK guidance
 * favors. Consequently the accessibility-skip decision (docs/07-PR-REVIEW-AGENT.md, "Review
 * Orchestration": "skipping accessibility up front ... from the changed-file list the trigger
 * payload already carries") is made by the Workflow immediately *after* its own `fetch-diff`
 * step resolves the real changed-file list, not by `ReviewRunAgent.start()` before the Workflow
 * even begins -- see `ReviewPipelineWorkflow.ts`'s own comment at that call site for the full
 * reasoning. This is a deliberate, documented deviation from the scenario doc's literal
 * "payload already carries" phrasing, made because Phase 3's actual webhook payload shape makes
 * the literal reading impossible without duplicating work the Workflow already does.
 */
export interface ReviewTrigger {
  /** The `review_runs.id` this trigger is for -- also this run's `ReviewRunAgent`/Durable
   * Object instance name (`getAgentByName(env.REVIEW_RUN, runId)`). */
  readonly runId: string;
  /** The normalized PR/MR reference to review. */
  readonly ref: PrReference;
}

/** One reviewer's live status, mirrored between D1 (`review_reviewers`, the durable source of
 * truth) and `ReviewRunAgent.state` (a live projection for whichever run is currently open --
 * docs/07-PR-REVIEW-AGENT.md, "Data Model"). */
export interface ReviewerState {
  readonly role: ReviewerRole;
  readonly status: "queued" | "running" | "done" | "skipped" | "error";
  readonly costUsd: number | null;
  readonly costSource: "pending" | "gateway";
  readonly findingCount: number;
}

/**
 * `ReviewRunAgent`'s full live state (docs/07-PR-REVIEW-AGENT.md, "Review Orchestration").
 * `workflowInstanceId` is nullable here -- unlike the scenario doc's own pseudocode interface --
 * because it is genuinely unknown for the brief window between `start()` calling `setState()`
 * for the initial `reviewers` array and `this.runWorkflow(...)` actually resolving an instance
 * id; a non-null `string` would force a placeholder value with no honest meaning.
 */
export interface ReviewRunState {
  readonly runId: string;
  readonly workflowInstanceId: string | null;
  readonly status: "running" | "completed" | "failed";
  readonly reviewers: readonly ReviewerState[];
}

/** The `initialState` a freshly created `ReviewRunAgent` Durable Object starts with, before
 * `start()` is ever called. Every field is a placeholder discarded the instant `start()` runs. */
export const REVIEW_RUN_INITIAL_STATE: ReviewRunState = {
  runId: "",
  workflowInstanceId: null,
  status: "running",
  reviewers: [],
};

/**
 * The typed progress payload `ReviewPipelineWorkflow.reportProgress()` sends and
 * `ReviewRunAgent.onWorkflowProgress()` receives (docs/07-PR-REVIEW-AGENT.md, "Review
 * Orchestration"). One event per reviewer-lifecycle transition the UI needs to animate; never
 * carries diff text, finding text, or a provider token (Implementation Plan Phase 4, item 22).
 */
export interface ReviewerProgress {
  readonly role: ReviewerRole;
  readonly event:
    | "reviewer_started"
    | "reviewer_completed"
    | "reviewer_skipped"
    | "reviewer_failed"
    | "cost_reconciled";
  /** Populated only for `"cost_reconciled"` -- the confirmed AI Gateway figures. */
  readonly costUsd?: number;
  /** Populated only for `"reviewer_skipped"`. */
  readonly skippedReason?: string;
  /** Populated only for `"reviewer_completed"`. */
  readonly findingCount?: number;
  /** Populated only for `"reviewer_failed"`. */
  readonly errorDetail?: string;
}
