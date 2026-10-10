import type { CloudflareToolkitVariables } from "@adrianhall/cloudflare-toolkit/hono";

/**
 * Hono context variables added by this Worker, including the request logger and verified
 * Cloudflare Access identity set by the toolkit middleware.
 */
export type AppVariables = CloudflareToolkitVariables;

/**
 * Hono environment shape shared by the top-level app and every sub-router/middleware in this
 * Worker, so `new Hono<AppBindings>()` is the single source of truth for `c.env` and
 * `c.get`/`c.set` typing across `src/worker`.
 */
export interface AppBindings {
  /** Wrangler-generated Worker bindings (the `AI` binding, static assets, log configuration). */
  Bindings: Env;
  /** Request-scoped application values set by this Worker's middleware. */
  Variables: AppVariables;
}
