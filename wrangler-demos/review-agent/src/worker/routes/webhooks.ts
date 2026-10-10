import { unauthorized } from "@adrianhall/cloudflare-toolkit/errors";
import type { Logger } from "@adrianhall/cloudflare-toolkit/logging";
import { Hono } from "hono";
import type { AppBindings } from "../bindings";
import { createOrGetReviewRun } from "../data/reviewRuns";
import {
  claimWebhookDelivery,
  linkWebhookDeliveryToRun,
} from "../data/webhookDeliveries";
import { GitHubProviderClient } from "../providers/github";
import { GitLabProviderClient } from "../providers/gitlab";
import type { GitProviderClient, Provider } from "../providers/types";
import { startRun } from "../review/startRun";

/**
 * `POST /api/webhooks/github` and `POST /api/webhooks/gitlab` (docs/07-PR-REVIEW-AGENT.md, "API
 * And Routing"). Both routes are carved out of Cloudflare Access entirely by
 * `src/worker/access-policies.ts`'s `{ pattern: /^\/api\/webhooks\//, authenticate: false }`
 * entry -- GitHub and GitLab call these with no Access identity at all, so every rejection this
 * router produces is an ordinary application-level `401`, never something to blame on a missing
 * Access identity. Nothing in this router (or the `GitProviderClient`s it constructs) reads
 * `c.get("Cloudflare_Access_Identity")`.
 */
export const webhooksRouter = new Hono<AppBindings>();

/**
 * Shared handling for both provider webhook routes, implementing Implementation Plan Phase 3's
 * item 12 exactly: verify → parse → dedupe → idempotent insert-or-return-existing run → respond
 * `202` quickly. `client.verifyWebhook()` itself performs the "parse" step -- it returns an
 * already-normalized `WebhookEvent` (or `null`) rather than a separately callable parse stage,
 * per the `GitProviderClient` interface (`../providers/types.ts`).
 *
 * Structured logs (`webhook_rejected`, `webhook_received`, `webhook_duplicate_delivery`,
 * `review_started`) are each placed immediately after the guard they reflect, per AGENTS.md's
 * "place logging after the guard it should reflect" rule -- `webhook_received` never logs for a
 * request that failed verification, and `review_started` never logs for a duplicate delivery.
 * None of them include the raw request body, the webhook secret, or the provider token.
 *
 * @param provider Which provider this request claims to be from -- selects both the logging
 * fields and the `review_webhook_deliveries` composite key's namespace; the caller already
 * picked `client` to match the route it mounted, so this never changes which verification path
 * runs.
 * @param client The provider client to verify this request against and, later (Implementation
 * Plan Phase 4), fetch/comment through.
 * @param request The raw inbound webhook `Request`.
 * @param env This Worker's bindings -- `env.DB` for the idempotency guard and run repository,
 * `env.REVIEW_RUN` to start the accepted run's `ReviewRunAgent`.
 * @param logger This request's `cloudflareLogger()`-scoped logger.
 * @returns The Hono-ready JSON body and status for this delivery: `202` with the run's `id`/
 * `status` for a newly accepted delivery, or for one that already has a run; `202` with
 * `{ status: "duplicate" }` for a delivery already claimed by an earlier request.
 * @throws {ProblemDetailsError} `401`, via `unauthorized()`, on any signature/token mismatch,
 * unparseable body, unrecognized payload shape, or untracked action -- `verifyWebhook()`
 * collapses all of these into a single `null` return, so this function cannot distinguish (or
 * leak, via a different response shape) which one occurred.
 */
async function handleWebhook(
  provider: Provider,
  client: GitProviderClient,
  request: Request,
  env: AppBindings["Bindings"],
  logger: Logger,
): Promise<{ body: Record<string, unknown>; status: 202 }> {
  const database = env.DB;
  const rawBody = await request.text();
  const event = await client.verifyWebhook(request, rawBody);
  if (!event) {
    logger.warn("webhook_rejected", { provider });
    throw unauthorized({
      detail: `Could not verify the ${provider} webhook signature or token.`,
    });
  }

  logger.info("webhook_received", {
    provider,
    action: event.action,
    repoFullName: event.ref.repoFullName,
    prNumber: event.ref.prNumber,
  });

  const claimed = await claimWebhookDelivery(
    database,
    provider,
    event.deliveryId,
  );
  if (!claimed) {
    logger.info("webhook_duplicate_delivery", {
      provider,
      repoFullName: event.ref.repoFullName,
      prNumber: event.ref.prNumber,
    });
    return { body: { status: "duplicate" }, status: 202 };
  }

  const { run, created } = await createOrGetReviewRun(database, {
    id: crypto.randomUUID(),
    provider,
    repoFullName: event.ref.repoFullName,
    prNumber: event.ref.prNumber,
    prUrl: event.prUrl,
    prTitle: event.prTitle,
    prAuthor: event.prAuthor,
    headSha: event.ref.headSha,
    trigger: "webhook",
    triggeredByEmail: null,
    diffTruncated: false,
    changedFileCount: event.changedFiles?.length ?? 0,
  });
  await linkWebhookDeliveryToRun(database, provider, event.deliveryId, run.id);

  if (created) {
    logger.info("review_started", {
      provider,
      runId: run.id,
      repoFullName: run.repoFullName,
      prNumber: run.prNumber,
    });
    // Only a genuinely new run starts the pipeline -- a duplicate/idempotent-existing run
    // (`created === false`) already has one running or completed, and starting a second
    // `ReviewPipelineWorkflow` instance for the same run id would double-review and double-post
    // a comment. `startRun()` (`../review/startRun.ts`) is the same helper Implementation Plan
    // Phase 5's manual-trigger route (`./reviews.ts`) calls, so both triggers share this exact
    // run-starting path, not only `createOrGetReviewRun()`'s D1 insert above.
    await startRun(env, run, event.ref);
  }

  return { body: { runId: run.id, status: run.status }, status: 202 };
}

webhooksRouter.post("/github", async (c) => {
  const { body, status } = await handleWebhook(
    "github",
    new GitHubProviderClient({
      token: c.env.GITHUB_TOKEN,
      webhookSecret: c.env.GITHUB_WEBHOOK_SECRET,
    }),
    c.req.raw,
    c.env,
    c.get("LOGGER"),
  );
  return c.json(body, status);
});

webhooksRouter.post("/gitlab", async (c) => {
  const { body, status } = await handleWebhook(
    "gitlab",
    new GitLabProviderClient({
      token: c.env.GITLAB_TOKEN,
      webhookSecret: c.env.GITLAB_WEBHOOK_SECRET,
      baseUrl: c.env.GITLAB_BASE_URL,
    }),
    c.req.raw,
    c.env,
    c.get("LOGGER"),
  );
  return c.json(body, status);
});
