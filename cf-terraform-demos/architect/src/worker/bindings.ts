import type { CloudflareToolkitVariables } from '@adrianhall/cloudflare-toolkit/hono';
import type { UserService } from './application/user-service.ts';

/**
 * Hono context variables added by this Worker, on top of the toolkit's `Cloudflare_Access_Identity`
 * and `LOGGER`.
 *
 * The services here are set once by the composition root in `src/worker/index.ts` and read by
 * middleware and route handlers. A handler therefore receives a service ready-made and never
 * constructs a repository of its own, which is what keeps the routes → application → domain →
 * infrastructure dependency direction one-way: nothing in `routes/` imports from
 * `infrastructure/`.
 */
export interface AppVariables extends CloudflareToolkitVariables {
  /**
   * User-directory use cases, backed by the D1 adapter the composition root injected.
   */
  USER_SERVICE: UserService;
}

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
