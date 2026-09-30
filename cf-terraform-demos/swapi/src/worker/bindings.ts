import type { CloudflareToolkitVariables } from '@adrianhall/cloudflare-toolkit/hono';

/**
 * Hono context variables available to this Worker.
 *
 * Only the toolkit's own: `Cloudflare_Access_Identity`, set by the Access middleware, and `LOGGER`,
 * set by the logger middleware. Unlike the sibling `todo` demo there is no application service on
 * the context, because this Worker's single route builds its GraphQL context per request (see
 * `src/worker/application/request-context.ts`) and passes it directly to GraphQL Yoga rather than
 * through Hono's variable map.
 */
export type AppVariables = CloudflareToolkitVariables;

/**
 * Hono environment shape shared by the top-level app and every sub-router and middleware in this
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
   * Request-scoped values set by this Worker's middleware.
   */
  Variables: AppVariables;
}
