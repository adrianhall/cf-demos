import { Agent, callable } from "agents";
import { markRunFailed } from "../data/reviewRuns";
import { applyReviewerProgress } from "../review/progress";
import { REVIEW_EXECUTION_ORDER } from "../review/roles";
import type {
  ReviewerProgress,
  ReviewRunState,
  ReviewTrigger,
} from "../review/types";
import { REVIEW_RUN_INITIAL_STATE } from "../review/types";

/**
 * Owns a review run's **live connection** -- the addressable Durable Object a client's WebSocket
 * connects to for a run's lifetime, and the only place `state`/`broadcast()` are called from
 * (docs/07-PR-REVIEW-AGENT.md, "Review Orchestration"). This class holds no pipeline logic, no
 * D1 writes of its own besides {@link ReviewRunAgent.onWorkflowError}'s `markRunFailed()` call,
 * and no in-memory sequencing -- the actual fetch-diff -> review -> merge -> post-comment
 * pipeline is `../workflows/ReviewPipelineWorkflow.ts`, which this class starts and then only
 * reacts to via three lifecycle callbacks.
 */
export class ReviewRunAgent extends Agent<Env, ReviewRunState> {
  initialState: ReviewRunState = REVIEW_RUN_INITIAL_STATE;

  /**
   * Accept a trigger and start this run's pipeline. Called once, immediately after the D1
   * `review_runs` row already exists (`../routes/webhooks.ts`; Implementation Plan Phase 5's
   * manual `POST /api/reviews`), and does the minimum to answer quickly, per the Agents SDK's
   * own "respond quickly" webhook guidance: `setState()` every reviewer to `queued` (the real
   * accessibility-skip decision is made later, by the Workflow itself, right after its own
   * `fetch-diff` step resolves the real changed-file list -- see `../review/types.ts`'s
   * `ReviewTrigger` doc comment for why), start `ReviewPipelineWorkflow`, record its instance id,
   * and return.
   *
   * @param payload The normalized trigger (run id + PR/MR reference).
   */
  @callable()
  async start(payload: ReviewTrigger): Promise<void> {
    this.setState({
      runId: payload.runId,
      workflowInstanceId: null,
      status: "running",
      reviewers: REVIEW_EXECUTION_ORDER.map((role) => ({
        role,
        status: "queued",
        costUsd: null,
        costSource: "pending",
        findingCount: 0,
      })),
    });

    // `runWorkflow()`'s first argument is the Workflow BINDING name ("REVIEW_PIPELINE"), not the
    // class name -- confirmed by reading the installed `agents` package's own
    // `_findWorkflowBindingByName()` implementation (`this.env[workflowName]`), which diverges
    // from this SDK's own doc examples (including this repository's `agents-sdk` skill
    // reference), all of which show a class-name string. `agentBinding` is passed explicitly
    // (rather than relying on `runWorkflow()`'s own class-name-based auto-detection of *this*
    // Agent's own binding) so starting a run never depends on this Worker's bundler preserving
    // `ReviewRunAgent`'s runtime `constructor.name`.
    const workflowInstanceId = await this.runWorkflow<ReviewTrigger>(
      "REVIEW_PIPELINE",
      payload,
      { agentBinding: "REVIEW_RUN" },
    );
    this.setState({ ...this.state, workflowInstanceId });
  }

  /**
   * Translate one Workflow progress report into the durable `setState()` + live `broadcast()`
   * pair (docs/07-PR-REVIEW-AGENT.md, "Review Orchestration"). `progress` is declared `unknown`
   * on the base `Agent` class (an Agent can own more than one Workflow type, each with its own
   * progress shape) -- narrowed here to {@link ReviewerProgress}, the only shape
   * `ReviewPipelineWorkflow` ever sends.
   */
  async onWorkflowProgress(
    _workflowName: string,
    _workflowId: string,
    progress: unknown,
  ): Promise<void> {
    const typedProgress = progress as ReviewerProgress;
    this.setState({
      ...this.state,
      reviewers: applyReviewerProgress(this.state.reviewers, typedProgress),
    });
    // `Agent.broadcast()` accepts only a string/binary payload -- unlike `AgentWorkflow`'s own
    // `broadcastToClients()` helper (which JSON-stringifies for its caller), this class must
    // stringify explicitly.
    this.broadcast(
      JSON.stringify({ type: typedProgress.event, ...typedProgress }),
    );
  }

  /**
   * The Workflow finished successfully -- mark the run completed and broadcast the posted
   * comment's URL.
   *
   * @param result The Workflow's own return value, `{ commentUrl: string }`
   * (`../workflows/ReviewPipelineWorkflow.ts`). Declared `unknown` on the base `Agent` class for
   * the same reason as {@link ReviewRunAgent.onWorkflowProgress}'s `progress` parameter.
   */
  async onWorkflowComplete(
    _workflowName: string,
    _workflowId: string,
    result?: unknown,
  ): Promise<void> {
    const commentUrl =
      (result as { commentUrl?: string } | undefined)?.commentUrl ?? null;
    this.setState({ ...this.state, status: "completed" });
    this.broadcast(JSON.stringify({ type: "review_completed", commentUrl }));
  }

  /**
   * The Workflow failed -- mark the D1 `review_runs` row `failed` (the only D1 write this class
   * ever performs), reflect it in `state`, and broadcast the failure so any client watching this
   * run's detail page can show it immediately.
   *
   * @param error The Workflow's own error message. A plain `string` on the installed `agents`
   * package's actual `onWorkflowError()` signature -- not an `Error` instance, despite this
   * repository's `agents-sdk` skill reference and docs/07-PR-REVIEW-AGENT.md's own pseudocode
   * both showing `error: Error`. Confirmed by reading `node_modules/agents/dist/*.d.ts` directly.
   */
  async onWorkflowError(
    _workflowName: string,
    _workflowId: string,
    error: string,
  ): Promise<void> {
    await markRunFailed(this.env.DB, this.state.runId, error);
    this.setState({ ...this.state, status: "failed" });
    this.broadcast(JSON.stringify({ type: "review_failed", detail: error }));
  }
}
