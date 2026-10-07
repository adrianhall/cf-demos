import type { MiddlewareHandler } from 'hono';
import type { AppBindings } from '../bindings.ts';

/**
 * Records the verified identity in the user directory as a best-effort side effect of an
 * authenticated request.
 *
 * Three properties make this safe to mount in the request path:
 *
 * - **It is a no-op without a verified identity.** A public route reaching this middleware — the
 *   health probe, the anonymous share resolver — writes nothing, so the directory only ever
 *   contains identities that genuinely authenticated.
 * - **It cannot fail the request.** The service absorbs a storage failure and reports it, because the
 *   directory is a convenience for the administrative view and nothing a user is trying to do
 *   should fail because a row could not be refreshed.
 * - **It is not an authorization source.** Nothing downstream reads the directory to decide what a
 *   caller may do; the administrator rule compares the verified email to `ADMIN_EMAIL` and consults
 *   no table at all.
 *
 * The write is awaited rather than deferred to `waitUntil`. It is a single indexed upsert, and
 * awaiting it means the Workers-runtime tests observe a deterministic result instead of racing the
 * assertion against a background task.
 */
export const recordUserMiddleware: MiddlewareHandler<AppBindings> = async (context, next) => {
  const identity = context.get('Cloudflare_Access_Identity');

  if (identity !== undefined) {
    const recorded = await context.var.USER_SERVICE.recordAuthenticatedRequest(identity.email);
    if (!recorded) {
      // Logged rather than swallowed: a persistently unwritable directory should be visible in
      // observability, not only as a mysteriously empty administrative table. The email is the
      // request's own verified identity, which the logger already correlates requests by.
      context.var.LOGGER.warn('user_directory_write_failed', { email: identity.email });
    }
  }

  await next();
};
