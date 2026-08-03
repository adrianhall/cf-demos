import type { CloudflareToolkitVariables } from "@adrianhall/cloudflare-toolkit/hono";

/**
 * Hono context variables added by this Worker. Currently limited to the toolkit's own
 * `Cloudflare_Access_Identity` and `LOGGER` variables; extend this when a route or
 * middleware needs to share additional request-scoped state.
 */
export type AppVariables = CloudflareToolkitVariables;

/**
 * Hono environment shape shared by the top-level app and every sub-router/middleware in
 * this Worker, so `new Hono<AppBindings>()` is the single source of truth for `c.env` and
 * `c.get`/`c.set` typing across `src/worker`.
 */
export interface AppBindings {
  /** Wrangler-generated Worker bindings (D1, Workers AI, Access team domain, admin email, log
   * configuration). */
  Bindings: Env;
  /** Request-scoped application values set by this Worker's middleware. */
  Variables: AppVariables;
}
