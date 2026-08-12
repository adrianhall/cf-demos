import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler,
} from "@adrianhall/cloudflare-toolkit/hono";
import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { ReviewRunAgent } from "./agents/ReviewRunAgent";
import type { AppBindings } from "./bindings";
import { accessMiddleware } from "./middleware/access";
import { meRouter } from "./routes/me";
import { reviewsRouter } from "./routes/reviews";
import { webhooksRouter } from "./routes/webhooks";
import { ReviewPipelineWorkflow } from "./workflows/ReviewPipelineWorkflow";

/**
 * Wrangler resolves a `durable_objects`/`workflows` binding's `class_name` against a named
 * export of the Worker's main module -- re-exporting these two classes here is what makes
 * `wrangler.jsonc`'s `REVIEW_RUN` and `REVIEW_PIPELINE` bindings resolve at all (without it,
 * Miniflare fails to start with "Class extends value undefined"). Both now carry their real
 * Phase 4 behavior (docs/07-PR-REVIEW-AGENT.md, "Review Orchestration") -- `ReviewRunAgent` owns
 * a run's live WebSocket connection and `state`/`broadcast()`; `ReviewPipelineWorkflow` owns the
 * deterministic fetch-diff -> review -> merge -> post-comment pipeline.
 */
export { ReviewPipelineWorkflow, ReviewRunAgent };

const app = new Hono<AppBindings>();

app.use(cloudflareLogger());

/**
 * Cloudflare Access, mounted once and globally (docs/07-PR-REVIEW-AGENT.md, "Access Model" and
 * Implementation Plan Phase 2, item 8). `accessPolicies` carves the two webhook paths out as
 * unauthenticated; every other `/api/*`/`/agents/*` route this Worker handles requires a
 * verified Access identity. Positioned before every route handler below so later phases only
 * need to add routes after it.
 */
app.use(accessMiddleware);

/**
 * Phase-1 placeholder health check. Kept (rather than removed now that Phase 3 adds the first
 * real `/api/*` router below) because it is a harmless, useful smoke-test endpoint on its own --
 * `GET /api/reviews`/`/api/me` (Phase 5) will eventually make it redundant for verifying the
 * Worker is up, but nothing about this phase requires removing it yet.
 */
app.get("/api/health", (c) => c.json({ status: "ok" }));

/**
 * `POST /api/webhooks/github` and `POST /api/webhooks/gitlab` (docs/07-PR-REVIEW-AGENT.md, "API
 * And Routing" and Implementation Plan Phase 3, item 12). Mounted after `accessMiddleware`
 * above -- harmless for this pair of paths specifically, since `accessPolicies`
 * (`./access-policies.ts`) already carves `/^\/api\/webhooks\//` out as unauthenticated, so
 * `cloudflareAccess()` never requires a JWT here regardless of mount order; the real security
 * boundary for these two routes is each provider's own signature/token verification inside
 * `./routes/webhooks.ts`, not Access.
 */
app.route("/api/webhooks", webhooksRouter);

/**
 * `POST /api/reviews`, `GET /api/reviews`, `GET /api/reviews/:id` (docs/07-PR-REVIEW-AGENT.md,
 * "API And Routing" and Implementation Plan Phase 5, item 23) and `GET /api/me`. Both mounted
 * after `accessMiddleware` above -- every path under `/api/*` other than the two webhook routes
 * requires a verified Cloudflare Access identity per `accessPolicies`, so every route in both
 * routers can assume `c.get("Cloudflare_Access_Identity")` is already set.
 */
app.route("/api/reviews", reviewsRouter);
app.route("/api/me", meRouter);

/**
 * `/agents/review-run/:id` -- the Agents SDK's own WebSocket routing convention
 * (docs/07-PR-REVIEW-AGENT.md, "API And Routing"), used only while a run's detail page is open
 * (`../client/composables/useReviewRun.ts`, Implementation Plan Phase 6, item 26). Mounted after
 * `accessMiddleware` above, so a request never reaches `routeAgentRequest()` without a verified
 * Cloudflare Access identity already set, per `accessPolicies`'s `/^\/agents\//` policy.
 * `routeAgentRequest()` resolves `ReviewRunAgent` from `wrangler.jsonc`'s `REVIEW_RUN` binding
 * purely by matching the URL's kebab-case agent segment (`review-run`) against that binding's
 * `class_name` -- no additional wiring is needed for it to find the right Durable Object.
 * Returns `undefined` for a request this Worker's own `/agents/*` prefix matched but that is not
 * actually a well-formed agent route (for example a malformed instance segment); `context.notFound()`
 * covers that defensively, though `accessPolicies`/`run_worker_first` already ensure only
 * `/agents/*` requests ever reach this handler at all.
 */
app.all("/agents/*", async (context) => {
  const response = await routeAgentRequest(context.req.raw, context.env);
  return response ?? context.notFound();
});

app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;
