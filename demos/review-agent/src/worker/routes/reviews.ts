import { badRequest, notFound } from "@adrianhall/cloudflare-toolkit/errors";
import { throwIfNull } from "@adrianhall/cloudflare-toolkit/guards";
import { Hono } from "hono";
import type { AppBindings } from "../bindings";
import {
  createOrGetReviewRun,
  getReviewRunDetail,
  listReviewRuns,
} from "../data/reviewRuns";
import { createProviderClient } from "../providers/factory";
import type { PrReference, ResolvedPrMetadata } from "../providers/types";
import { detectProviderAndRef } from "../review/detectProvider";
import {
  validateListReviewRunsQuery,
  validateManualTriggerBody,
} from "../review/reviewsValidation";
import { startRun } from "../review/startRun";

/**
 * The authenticated review-history and manual-trigger API, mounted at `/api/reviews` by
 * `../index.ts` (docs/07-PR-REVIEW-AGENT.md, "API And Routing"). Every route here runs behind
 * `accessMiddleware` (`../middleware/access.ts`'s `/^\/api\//` policy) -- there is no
 * per-route admin-equivalent check on top of it: "every authenticated identity can see every
 * past run" (docs/07-PR-REVIEW-AGENT.md, "Out Of Scope").
 */
export const reviewsRouter = new Hono<AppBindings>();

/**
 * `POST /api/reviews` -- accept a pasted PR/MR URL and start a review, converging on the exact
 * same run-creation path a webhook delivery uses (docs/07-PR-REVIEW-AGENT.md, "API And Routing":
 * "reuses the exact same run-creation path as a webhook, with `trigger: "manual"` and the
 * caller's verified email recorded").
 *
 * Order of operations, each guarding the next: validate the body shape -> detect which provider
 * (if either) the URL matches -> resolve the PR/MR's *current* head SHA/title/author/URL from
 * that provider (`GitProviderClient.resolvePrMetadata()`, since `parsePrUrl()` alone cannot know
 * any of that from a bare URL) -> idempotently create-or-return the run -> start it only if this
 * call actually created it.
 */
reviewsRouter.post("/", async (context) => {
  const logger = context.get("LOGGER");
  const identity = context.get("Cloudflare_Access_Identity");
  throwIfNull(identity, "accessMiddleware must run before this handler");

  const body = await context.req.json().catch(() => null);
  const { url } = validateManualTriggerBody(body);

  const githubClient = createProviderClient(context.env, "github");
  const gitlabClient = createProviderClient(context.env, "gitlab");
  const detected = detectProviderAndRef(githubClient, gitlabClient, url);
  if (detected === null) {
    throw badRequest({
      detail: "url must be a GitHub pull request or GitLab merge request URL.",
    });
  }

  let metadata: ResolvedPrMetadata;
  try {
    metadata = await detected.client.resolvePrMetadata(detected.ref);
  } catch (error) {
    logger.warn("manual_trigger_metadata_failed", {
      provider: detected.provider,
      repoFullName: detected.ref.repoFullName,
      prNumber: detected.ref.prNumber,
      error: error instanceof Error ? error.message : String(error),
    });
    throw badRequest({
      detail:
        "Could not read this PR/MR from the provider -- check the URL and try again.",
    });
  }

  const { run, created } = await createOrGetReviewRun(context.env.DB, {
    id: crypto.randomUUID(),
    provider: detected.provider,
    repoFullName: detected.ref.repoFullName,
    prNumber: detected.ref.prNumber,
    prUrl: metadata.url,
    prTitle: metadata.title,
    prAuthor: metadata.author,
    headSha: metadata.headSha,
    trigger: "manual",
    triggeredByEmail: identity.email,
    diffTruncated: false,
    changedFileCount: 0,
  });

  if (created) {
    logger.info("review_started", {
      provider: detected.provider,
      runId: run.id,
      repoFullName: run.repoFullName,
      prNumber: run.prNumber,
      trigger: "manual",
    });
    // Only a genuinely new run starts the pipeline -- a run this call raced a webhook (or an
    // earlier manual trigger) for and lost already has one running or completed. `resolvedRef`
    // carries the just-resolved real head SHA -- `detected.ref` alone still has the empty
    // `headSha` `parsePrUrl()` always returns.
    const resolvedRef: PrReference = {
      ...detected.ref,
      headSha: metadata.headSha,
    };
    await startRun(context.env, run, resolvedRef);
  }

  return context.json({ runId: run.id, status: run.status }, 202);
});

/**
 * `GET /api/reviews` -- paginated run history, newest first (docs/07-PR-REVIEW-AGENT.md, "API
 * And Routing": "id, provider, repo, PR number/title, status, total cost, created/completed
 * timestamps").
 */
reviewsRouter.get("/", async (context) => {
  const { page, pageSize } = validateListReviewRunsQuery({
    page: context.req.query("page"),
    pageSize: context.req.query("pageSize"),
  });
  const { runs, total } = await listReviewRuns(context.env.DB, {
    page,
    pageSize,
  });
  return context.json({ runs, total, page, pageSize });
});

/**
 * `GET /api/reviews/:id` -- one run's full detail: reviewer rows, merged findings, the full
 * Markdown report, and the posted comment URL (docs/07-PR-REVIEW-AGENT.md, "API And Routing").
 */
reviewsRouter.get("/:id", async (context) => {
  const id = context.req.param("id");
  const detail = await getReviewRunDetail(context.env.DB, id);
  if (detail === null) {
    throw notFound({ detail: `No review run found with id ${id}.` });
  }
  return context.json(detail);
});
