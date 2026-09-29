import type { CloudflareToolkitVariables } from '@adrianhall/cloudflare-toolkit/hono';
import type { LinkService } from './application/link-service';

/**
 * Hono context variables added by this Worker: the toolkit's `Cloudflare_Access_Identity` and
 * `LOGGER`, plus the request-scoped {@link LinkService} that routes use instead of constructing
 * their own repository.
 */
export interface AppVariables extends CloudflareToolkitVariables {
  /**
   * Business-logic tier for short links, wired in `src/worker/index.ts`.
   */
  LINK_SERVICE: LinkService;
}

/**
 * Hono environment shape shared by the top-level app and every sub-router/middleware in this
 * Worker, so `new Hono<AppBindings>()` is the single source of truth for `c.env` and
 * `c.get`/`c.set` typing across `src/worker`.
 */
export interface AppBindings {
  /**
   * Worker bindings generated from `cloudflare.config.ts`. `ENVIRONMENT` intentionally does not
   * exist in local development: its absence selects the toolkit's development defaults without a
   * tracked `.dev.vars` file. Production binds it explicitly as `"production"`.
   */
  Bindings: Env & { ENVIRONMENT?: string };
  /**
   * Request-scoped application values set by this Worker's middleware.
   */
  Variables: AppVariables;
}
