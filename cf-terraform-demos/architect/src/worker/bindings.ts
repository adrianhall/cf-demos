import type { CloudflareToolkitVariables } from '@adrianhall/cloudflare-toolkit/hono';

/**
 * Hono context variables added by this Worker: the toolkit's `Cloudflare_Access_Identity` and
 * `LOGGER`.
 *
 * Later phases attach request-scoped application services here, set once by the composition root in
 * `src/worker/index.ts`, so a route never constructs a repository of its own.
 */
export interface AppVariables extends CloudflareToolkitVariables {}

/**
 * Hono environment shape shared by the top-level app and every sub-router/middleware in this
 * Worker, so `new Hono<AppBindings>()` is the single source of truth for `c.env` and
 * `c.get`/`c.set` typing across `src/worker`.
 */
export interface AppBindings {
  /**
   * Worker bindings generated from `cloudflare.config.ts` by `cf workers types`.
   *
   * `ENVIRONMENT` intentionally does not exist in local development: its absence selects the
   * toolkit's development logging defaults without needing an untracked `.dev.vars` file.
   * Production binds it explicitly as `"production"`.
   */
  Bindings: Env & { ENVIRONMENT?: string };
  /**
   * Request-scoped application values set by this Worker's middleware.
   */
  Variables: AppVariables;
}
