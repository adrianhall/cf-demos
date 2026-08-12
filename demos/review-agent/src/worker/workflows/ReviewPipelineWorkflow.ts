import { NonRetryableError } from "cloudflare:workflows";
import { throwIfNull } from "@adrianhall/cloudflare-toolkit/guards";
import {
  createLogger,
  resolveLoggerConfig,
} from "@adrianhall/cloudflare-toolkit/logging";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import { AgentWorkflow } from "agents/workflows";
import { modelIdForTier } from "../../models";
import type { ReviewRunAgent } from "../agents/ReviewRunAgent";
import type { ProviderSecrets } from "../bindings";
import { replaceMergedFindings } from "../data/reviewFindings";
import {
  listReviewReviewers,
  reconcileReviewerCost,
  upsertReviewReviewer,
} from "../data/reviewReviewers";
import {
  getReviewRunById,
  markRunCompleted,
  recordFetchDiffOutcome,
} from "../data/reviewRuns";
import { createProviderClient } from "../providers/factory";
import { mergeFindings } from "../review/merge";
import { PERSONAS } from "../review/personas";
import { isPermanentFetchDiffError } from "../review/providerErrors";
import type {
  ReviewerReportMeta,
  ReviewRunReportSummary,
} from "../review/report";
import { buildCommentBody, buildFullReport } from "../review/report";
import { REVIEW_EXECUTION_ORDER, type ReviewerRole } from "../review/roles";
import { ReviewerJsonInvalidError, runReviewer } from "../review/runReviewer";
import type { RawFinding } from "../review/schema";
import type {
  ReviewerProgress,
  ReviewerState,
  ReviewTrigger,
} from "../review/types";
import { hasUiRelevantChangedFile } from "../review/uiFiles";

/** Structured logging field shapes emitted by this Workflow (Implementation Plan Phase 4, item
 * 22) -- never diff text, finding text, or a provider token, only role/model/duration/
 * finding-count/token-count fields. */
type ReviewerLogFields = Record<string, string | number | boolean | null>;

/**
 * The deterministic fetch-diff -> review -> merge -> post-comment pipeline
 * (docs/07-PR-REVIEW-AGENT.md, "Review Orchestration"). Every step is independently retried by
 * the Workflows engine per its own configuration; a transient failure in one reviewer's call
 * never re-runs (or re-bills) an already-completed step.
 *
 * `Env` is explicitly widened to `Env & ProviderSecrets` (rather than the default
 * `Cloudflare.Env`) because this Workflow constructs a `GitProviderClient` directly from
 * `this.env`, and the GitHub/GitLab tokens/webhook secrets are hand-declared in
 * `../bindings.ts`'s `ProviderSecrets` -- `wrangler types` cannot see them (they are Wrangler
 * secrets, never a `wrangler.jsonc` binding).
 */
export class ReviewPipelineWorkflow extends AgentWorkflow<
  ReviewRunAgent,
  ReviewTrigger,
  ReviewerProgress,
  Env & ProviderSecrets
> {
  async run(
    event: AgentWorkflowEvent<ReviewTrigger>,
    step: AgentWorkflowStep,
  ): Promise<{ commentUrl: string }> {
    const { runId, ref } = event.payload;
    const client = createProviderClient(this.env, ref.provider);
    // A plain `createLogger()` call, not `cloudflareLogger()` -- a Workflow has no Hono request
    // context to attach a logger to (docs/07-PR-REVIEW-AGENT.md, Implementation Plan Phase 4,
    // item 11). `.child({ runId })` correlates every log line from this run, per "Demo Flow"'s
    // "correlated by runId" instruction.
    const logger = createLogger(
      resolveLoggerConfig(this.env.ENVIRONMENT, "worker"),
    ).child({ runId });

    // Step 1: fetch this PR/MR's diff. A permanent provider response (403/404) is converted to
    // NonRetryableError immediately -- retrying cannot help, and it also skips every reviewer
    // and reconciliation step below, since none of them ever ran (docs/07-PR-REVIEW-AGENT.md,
    // "Review Orchestration", step 1).
    const diffResult = await step.do(
      "fetch-diff",
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
      async () => {
        let result: Awaited<ReturnType<typeof client.fetchDiff>>;
        try {
          result = await client.fetchDiff(ref);
        } catch (error) {
          if (isPermanentFetchDiffError(error)) {
            const message =
              error instanceof Error ? error.message : String(error);
            throw new NonRetryableError(
              `fetch-diff failed permanently for ${ref.repoFullName}#${ref.prNumber}: ${message}`,
            );
          }
          throw error;
        }
        await recordFetchDiffOutcome(this.env.DB, runId, {
          workflowInstanceId: this.workflowId,
          diffTruncated: result.truncated,
          changedFileCount: result.changedFiles.length,
        });
        return result;
      },
    );

    // The accessibility skip decision happens exactly once here, from the real fetched
    // changed-file list -- not from the trigger payload (see `../review/types.ts`'s own
    // `ReviewTrigger` doc comment for why this deviates from the scenario doc's literal "the
    // trigger payload already carries" phrasing) and not inside the per-reviewer loop below.
    const runAccessibility = hasUiRelevantChangedFile(diffResult.changedFiles);
    const activeRoles = REVIEW_EXECUTION_ORDER.filter(
      (role) => role !== "accessibility" || runAccessibility,
    );

    // This run's own live projection of every reviewer's state -- rebuilt deterministically on
    // every replay from each step's own memoized result, per the Workflows durable-execution
    // model (`run()` re-executes top to bottom on resume; `step.do()` short-circuits work that
    // already completed). Never carries a reviewer's raw prose output -- only small, structured
    // fields -- so it stays safe to keep in this closure across every step below.
    const reviewerStates = new Map<ReviewerRole, ReviewerState>(
      REVIEW_EXECUTION_ORDER.map((role) => [
        role,
        {
          role,
          status: activeRoles.includes(role) ? "queued" : "skipped",
          costUsd: null,
          costSource: "pending",
          findingCount: 0,
        },
      ]),
    );
    const currentReviewers = (): ReviewerState[] =>
      REVIEW_EXECUTION_ORDER.map(
        (role) => reviewerStates.get(role) as ReviewerState,
      );
    const setReviewerState = (
      role: ReviewerRole,
      patch: Partial<ReviewerState>,
    ): void => {
      reviewerStates.set(role, {
        ...(reviewerStates.get(role) as ReviewerState),
        ...patch,
      });
    };

    if (!runAccessibility) {
      const skippedReason = "No changed file has a UI-relevant extension.";
      await step.do(
        "skip-accessibility",
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
        async () => {
          await upsertReviewReviewer(this.env.DB, {
            runId,
            role: "accessibility",
            status: "skipped",
            model: null,
            skippedReason,
            errorDetail: null,
            aiGatewayLogId: null,
            costUsd: null,
            tokensIn: null,
            tokensOut: null,
            costSource: "pending",
            rawOutput: null,
          });
        },
      );
      await step.mergeAgentState({ reviewers: currentReviewers() });
      await this.reportProgress({
        role: "accessibility",
        event: "reviewer_skipped",
        skippedReason,
      });
      logger.info("reviewer_skipped", { role: "accessibility", skippedReason });
    }

    // Each active reviewer's own validated findings, kept in memory across the loop -- small,
    // structured data (never the reviewer's own raw prose output, which is written to and later
    // read back from D1 instead -- see `../data/reviewReviewers.ts`'s `listReviewReviewers()`
    // doc comment for why).
    const perReviewerFindings: Partial<Record<ReviewerRole, RawFinding[]>> = {};

    for (const role of activeRoles) {
      const modelId = modelIdForTier(PERSONAS[role].modelTier);
      setReviewerState(role, { status: "running" });
      await this.reportProgress({ role, event: "reviewer_started" });

      let reviewOutcome: {
        findings: RawFinding[];
        aiGatewayLogId: string | null;
      } | null = null;
      try {
        reviewOutcome = await step.do(
          `review:${role}`,
          {
            retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
            timeout: "3 minutes",
          },
          async () => {
            try {
              const result = await runReviewer({
                role,
                ref,
                diff: diffResult.diff,
                changedFiles: diffResult.changedFiles,
                client,
                ai: this.env.AI,
                gatewayId: this.env.AI_GATEWAY_ID,
              });
              // Idempotent upsert keyed on (run_id, role) -- a retried step re-running this
              // callback (Workflows steps run at-least-once) must not conflict or duplicate.
              await upsertReviewReviewer(this.env.DB, {
                runId,
                role,
                status: "done",
                model: modelId,
                skippedReason: null,
                errorDetail: null,
                aiGatewayLogId: result.aiGatewayLogId,
                costUsd: null,
                tokensIn: null,
                tokensOut: null,
                costSource: "pending",
                rawOutput: result.rawOutput,
              });
              return {
                findings: result.findings,
                aiGatewayLogId: result.aiGatewayLogId,
              };
            } catch (error) {
              if (error instanceof ReviewerJsonInvalidError) {
                // The bounded one-shot repair retry inside runReviewer() is already exhausted --
                // repeating this exact prompt against an uncooperative model is unlikely to
                // help, so this step's own retry config must not re-run it (Implementation Plan
                // Phase 4, item 19).
                await upsertReviewReviewer(this.env.DB, {
                  runId,
                  role,
                  status: "error",
                  model: modelId,
                  skippedReason: null,
                  errorDetail: error.message,
                  aiGatewayLogId: null,
                  costUsd: null,
                  tokensIn: null,
                  tokensOut: null,
                  costSource: "pending",
                  rawOutput: null,
                });
                throw new NonRetryableError(error.message);
              }
              throw error;
            }
          },
        );
      } catch (error) {
        // Every retry exhausted (a transient failure that never recovered) or the
        // NonRetryableError conversion above -- record this reviewer as errored and continue
        // with the rest of the run; a single reviewer's failure never aborts the whole instance
        // (docs/07-PR-REVIEW-AGENT.md, "Review Orchestration").
        const message = error instanceof Error ? error.message : String(error);
        perReviewerFindings[role] = [];
        setReviewerState(role, { status: "error", findingCount: 0 });
        await step.mergeAgentState({ reviewers: currentReviewers() });
        await this.reportProgress({
          role,
          event: "reviewer_failed",
          errorDetail: message,
        });
        logger.warn("reviewer_failed", {
          role,
          model: modelId,
          errorDetail: message,
        });
        continue;
      }

      perReviewerFindings[role] = reviewOutcome.findings;
      setReviewerState(role, {
        status: "done",
        findingCount: reviewOutcome.findings.length,
      });
      await step.mergeAgentState({ reviewers: currentReviewers() });
      await this.reportProgress({
        role,
        event: "reviewer_completed",
        findingCount: reviewOutcome.findings.length,
      });
      logger.info("reviewer_completed", {
        role,
        model: modelId,
        findingCount: reviewOutcome.findings.length,
      } satisfies ReviewerLogFields);

      // Reconcile cost as Workflow steps, not a hand-rolled schedule -- the step's own retry
      // configuration *is* the reconciliation backoff (docs/07-PR-REVIEW-AGENT.md, "Review
      // Orchestration" / "Cost Tracking"). Skipped entirely when the binding never populated an
      // `aiGatewayLogId` at all -- there is nothing to reconcile.
      if (reviewOutcome.aiGatewayLogId !== null) {
        const aiGatewayLogId = reviewOutcome.aiGatewayLogId;
        await step.sleep(`reconcile-wait:${role}`, "5 seconds");
        try {
          const log = await step.do(
            `reconcile-cost:${role}`,
            {
              retries: {
                limit: 3,
                delay: "15 seconds",
                backoff: "exponential",
              },
              timeout: "2 minutes",
            },
            () =>
              this.env.AI.gateway(this.env.AI_GATEWAY_ID).getLog(
                aiGatewayLogId,
              ),
          );
          const costUsd = log.cost ?? 0;
          await reconcileReviewerCost(this.env.DB, runId, role, {
            costUsd,
            tokensIn: log.tokens_in ?? 0,
            tokensOut: log.tokens_out ?? 0,
          });
          setReviewerState(role, { costUsd, costSource: "gateway" });
          await step.mergeAgentState({ reviewers: currentReviewers() });
          await this.reportProgress({
            role,
            event: "cost_reconciled",
            costUsd,
          });
        } catch {
          // `getLog()` throws `AiGatewayLogNotFound` (docs/DECISIONS.md #16) until AI Gateway
          // indexes the log; once `step.do()`'s own three retries are exhausted, that error
          // propagates here as a legitimate, permanent "stayed pending" outcome -- not a
          // Workflow failure. `cost_source` is simply never updated, so it stays 'pending'.
        }
      }
    }

    // Step 3: merge and post -- its own idempotent already-posted-comment guard is what makes a
    // retried attempt of this step (a network blip after a successful post, for example) safe.
    const result = await step.do(
      "merge-and-post-comment",
      { retries: { limit: 2, delay: "10 seconds" } },
      async () => {
        const run = await getReviewRunById(this.env.DB, runId);
        throwIfNull(
          run,
          `review_runs row for ${runId} disappeared before merge-and-post-comment`,
        );
        if (run.commentUrl !== null) {
          return { commentUrl: run.commentUrl };
        }

        const merged = mergeFindings(perReviewerFindings);
        await replaceMergedFindings(this.env.DB, runId, merged);

        const reviewerRows = await listReviewReviewers(this.env.DB, runId);
        const reviewerMeta: ReviewerReportMeta[] = reviewerRows.map((row) => ({
          role: row.role,
          model: row.model,
          status:
            row.status === "done" || row.status === "skipped"
              ? row.status
              : "error",
          skippedReason: row.skippedReason,
          errorDetail: row.errorDetail,
          rawOutput: row.rawOutput,
        }));

        const runSummary: ReviewRunReportSummary = {
          id: run.id,
          provider: run.provider,
          repoFullName: run.repoFullName,
          prNumber: run.prNumber,
          prTitle: run.prTitle,
        };
        const fullReport = buildFullReport(runSummary, merged, reviewerMeta);
        const commentBody = buildCommentBody(
          runSummary,
          merged,
          this.env.PUBLIC_BASE_URL,
        );

        const posted = await client.postComment(ref, commentBody);
        await markRunCompleted(this.env.DB, runId, {
          commentUrl: posted.url,
          fullReport,
        });
        return { commentUrl: posted.url };
      },
    );

    logger.info("review_posted", { commentUrl: result.commentUrl });
    await step.reportComplete({ commentUrl: result.commentUrl });
    return result;
  }
}
