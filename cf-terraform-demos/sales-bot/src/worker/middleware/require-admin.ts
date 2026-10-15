import type { MiddlewareHandler } from 'hono';
import { forbidden } from '@adrianhall/cloudflare-toolkit/errors';
import type { AppBindings } from '../bindings';
import { isAdministrator } from '../domain/actor';

/**
 * Require that the resolved actor administers this installation.
 *
 * Mounted on the administrator router as a second, structural barrier. It is not the only check —
 * {@link import('../application/documentation-service').DocumentationService} re-checks the same
 * actor, because a service that is only safe when reached through the right router is a service
 * whose safety depends on routing, and the next caller would not know that.
 *
 * The role comes from `ACTOR`, which the composition root derives from the verified Access identity
 * and D1. Every Access application in a team shares a JWKS, so a valid JWT proves only that
 * somebody in the team signed in; the role check is what makes this an authorization boundary
 * rather than an authentication one.
 *
 * @param context Hono request context carrying the resolved actor.
 * @param next Middleware continuation, invoked only after authorization succeeds.
 * @returns A promise fulfilled after the downstream handler completes.
 * @throws {ProblemDetailsError} `forbidden()` (403) when the actor is not an administrator. `403`
 *   rather than `404` because the administration surface is not a secret; a PM who reaches it
 *   should be told they lack the role, not be left to conclude the endpoint does not exist.
 */
export const requireAdmin: MiddlewareHandler<AppBindings> = async (context, next) => {
  const actor = context.get('ACTOR');
  if (!isAdministrator(actor)) {
    context.get('LOGGER').warn('admin_access_denied', { role: actor.role });
    throw forbidden({ detail: 'This operation requires the administrator role.' });
  }
  await next();
};
