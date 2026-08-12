import { getAgentByName } from "agents";
import type { AppBindings } from "../bindings";
import type { ReviewRun } from "../data/reviewRuns";
import type { PrReference } from "../providers/types";
import type { ReviewTrigger } from "./types";

/**
 * Start a newly created review run's pipeline -- the one call the webhook route
 * (`../routes/webhooks.ts`) and the manual-trigger route (`../routes/reviews.ts`) share, so "the
 * exact same run-creation path" (docs/07-PR-REVIEW-AGENT.md, "Behavior": "Normalize either
 * trigger into the same ... record" and "API And Routing": "reuses the exact same run-creation
 * path as a webhook") extends to *starting* the run, not only to `createOrGetReviewRun()`'s D1
 * insert. Extracted out of `../routes/webhooks.ts` in this phase specifically so a second
 * caller never has to duplicate the `ReviewTrigger` payload shape or the `getAgentByName()` call
 * convention documented on `ReviewRunAgent.start()`.
 *
 * MUST only be called for a genuinely new run (`created === true` from
 * `createOrGetReviewRun()`) -- calling this for a run that already exists (a duplicate webhook
 * delivery, or a race between a webhook and a manual trigger for the same commit) would start a
 * second `ReviewPipelineWorkflow` instance for the same run id, double-reviewing and
 * double-posting a comment. Both current callers already only reach this function inside their
 * own `if (created)` guard.
 *
 * @param env This Worker's bindings -- `env.REVIEW_RUN` to resolve the run's `ReviewRunAgent`
 * Durable Object stub.
 * @param run The just-created run. Only `id` is read; a caller may pass the full
 * {@link ReviewRun} returned by `createOrGetReviewRun()` directly.
 * @param ref The normalized PR/MR reference this run reviews -- for a webhook trigger, the
 * event's own `ref` (already carrying a real `headSha`); for a manual trigger, the reference
 * `GitProviderClient.resolvePrMetadata()` resolved (`../providers/types.ts`'s
 * `ResolvedPrMetadata` doc comment).
 */
export async function startRun(
  env: AppBindings["Bindings"],
  run: Pick<ReviewRun, "id">,
  ref: PrReference,
): Promise<void> {
  const payload: ReviewTrigger = { runId: run.id, ref };
  const agent = await getAgentByName(env.REVIEW_RUN, run.id);
  await agent.start(payload);
}
