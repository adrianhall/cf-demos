import { Hono } from 'hono';
import type { AppBindings } from '../bindings';

/**
 * Public short-link redirect route, mounted at `/l`. It bypasses Cloudflare Access (see
 * `accessPolicies` in `src/access-policies.ts`) but still goes through application validation.
 */
export const redirectsRouter = new Hono<AppBindings>();

/**
 * Redirect a visitor to the configured destination and log the informational event.
 *
 * @param context Hono request context containing the public short-code path parameter.
 * @returns A `302` response with the validated destination in `Location` and `no-store` caching.
 * @throws {ProblemDetailsError} When the code is malformed or the link is absent.
 * @throws {Error} When persistence rejects the lookup.
 */
redirectsRouter.get('/:code', async (context) => {
  const link = await context.get('LINK_SERVICE').resolveDestination(context.req.param('code'));
  context.get('LOGGER').info('short_link_used', { code: link.code });
  return new Response(null, {
    headers: { 'Cache-Control': 'no-store', 'Location': link.destination },
    status: 302
  });
});
