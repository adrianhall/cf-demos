import { Hono } from 'hono';
import type { AppBindings } from '../bindings';

/**
 * Authenticated, caller-scoped operational dashboard API.
 */
export const dashboardRouter = new Hono<AppBindings>();

/**
 * Return D1-derived metrics without FAQ, transcript, or identity content.
 *
 * @param context Hono request context containing the resolved actor and request clock.
 * @returns A JSON dashboard snapshot.
 * @throws {ProblemDetailsError} `notFound()` when the actor has no dashboard role.
 * @throws {Error} When D1 cannot calculate the aggregates.
 */
dashboardRouter.get('/', async (context) => {
  const metrics = await context
    .get('DASHBOARD_SERVICE')
    .metrics(context.get('ACTOR'), context.get('NOW'));
  context.get('LOGGER').info('dashboard_read', {
    correlationId: context.get('CORRELATION_ID'),
    openCount: metrics.openCount,
    indexingBacklog: metrics.indexingBacklog
  });
  return context.json({ metrics });
});
