import type { CloudflareToolkitVariables } from "@adrianhall/cloudflare-toolkit/hono";

/**
 * Hono context variables added by this Worker: the toolkit's own `AuthVariables` (set by
 * `cloudflareAccess()`, mounted globally in `src/worker/index.ts`) and `LoggerVariables`
 * (docs/07-PR-REVIEW-AGENT.md, "Access Model").
 */
export type AppVariables = CloudflareToolkitVariables;

/**
 * GitHub/GitLab credentials, configured as one-time `wrangler secret put` values rather than a
 * `wrangler.jsonc` `vars` entry or a Terraform output (docs/07-PR-REVIEW-AGENT.md, "Explicit
 * Exceptions" and "Git Provider Integration"). `generate-wrangler-types`/`wrangler types` cannot
 * see these -- unlike every other binding on `Env`, they are never declared in `wrangler.jsonc`
 * at all, and this demo's `.dev.vars` (the other source `wrangler types` reads secret-shaped
 * keys from) is itself gitignored per that same "Explicit Exceptions" entry, so it is never
 * guaranteed to exist on a clean checkout for type generation to pick up. Declared here by hand,
 * once, so `c.env.GITHUB_TOKEN` etc. type-check throughout `src/worker/providers` and
 * `src/worker/routes/webhooks.ts` regardless of whether a real `.dev.vars` happens to exist
 * locally.
 */
export interface ProviderSecrets {
  readonly GITHUB_TOKEN: string;
  readonly GITHUB_WEBHOOK_SECRET: string;
  readonly GITLAB_TOKEN: string;
  readonly GITLAB_WEBHOOK_SECRET: string;
  /** Base URL of the GitLab instance to call (`.dev.vars.example`'s default:
   * `https://gitlab.com`). Optional because a self-managed override is the exception, not the
   * rule -- `GitLabProviderClient` (`./providers/gitlab.ts`) falls back to the SaaS instance
   * when this is unset. */
  readonly GITLAB_BASE_URL?: string;
}

/**
 * Hono environment shape shared by the top-level app and every sub-router/middleware in this
 * Worker, so `new Hono<AppBindings>()` is the single source of truth for `c.env` and
 * `c.get`/`c.set` typing across `src/worker`.
 */
export interface AppBindings {
  /** Wrangler-generated Worker bindings (D1, Workers AI, AI Gateway id, the `REVIEW_RUN`
   * Durable Object and `REVIEW_PIPELINE` Workflow bindings, Access team domain), intersected
   * with the hand-declared {@link ProviderSecrets} `wrangler types` cannot generate. */
  Bindings: Env & ProviderSecrets;
  /** Request-scoped application values set by this Worker's middleware. */
  Variables: AppVariables;
}
