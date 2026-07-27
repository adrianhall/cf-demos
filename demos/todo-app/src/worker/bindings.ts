import type { LoggerVariables } from "@adrianhall/cloudflare-toolkit/hono";

/**
 * Hono context variables added by this Worker. Limited to the toolkit's own `LOGGER` variable
 * for now; Phase 2 (Cloudflare Access) extends this to `CloudflareToolkitVariables` once
 * `cloudflareAccess()` middleware is wired in, adding the verified `Cloudflare_Access_Identity`.
 */
export type AppVariables = LoggerVariables;

/**
 * Hono environment shape shared by the top-level app and every sub-router/middleware in this
 * Worker, so `new Hono<AppBindings>()` is the single source of truth for `c.env` and
 * `c.get`/`c.set` typing across `src/worker`.
 */
export interface AppBindings {
  /** Wrangler-generated Worker bindings (D1, static assets, log configuration). */
  Bindings: Env;
  /** Request-scoped application values set by this Worker's middleware. */
  Variables: AppVariables;
}
