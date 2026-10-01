import { Hono } from 'hono';
import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';
import { currentIdentity } from '@demos/worker-common';
import type { AppBindings } from '../bindings';
import { isPlausibleRunId } from '../domain/chat';

/**
 * Run metrics endpoint, mounted at `/api/runs`.
 *
 * The browser calls this after a run's `completed` event to resolve what the run cost. It is a
 * separate request from the answer on purpose: AI Gateway writes its log asynchronously, so folding
 * the cost into the answer would mean delaying every answer to display a number nobody is waiting
 * for.
 */
export const runsRouter = new Hono<AppBindings>();

/**
 * Returns the resolved or pending gateway metrics for one run.
 *
 * The answer is one of three honest states rather than a number: `available` with a total,
 * `pending` with a retry hint, or `unavailable`. There is no path that returns a zero cost for an
 * unmeasured run.
 *
 * A caller may only read their own runs. The check compares the run record's stored owner against
 * the current verified identity, and refuses with a problem document rather than an empty result,
 * so one identity probing another's run identifiers is a visible denial rather than a silent
 * blank.
 *
 * @param context Hono request context, carrying the verified Access identity and the request-scoped
 *   metrics service.
 * @returns A JSON `200` response carrying {@link RunMetrics}. When the status is `pending` a
 *   `Retry-After` header is set alongside the body's own hint, so a generic HTTP client and this
 *   demo's client both learn the same thing.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the run identifier is malformed;
 *   `notFound()` (404) when no such run is remembered; `forbidden()` (403) when the run belongs to
 *   another identity.
 */
runsRouter.get('/:runId/metrics', async (context) => {
  const runId = context.req.param('runId');

  // A malformed identifier is answered 400 rather than 404: the two mean different things, and
  // shape-checking before the lookup keeps an arbitrary string out of the repository entirely.
  if (!isPlausibleRunId(runId)) {
    throw badRequest({ detail: 'That is not a valid run identifier.' });
  }

  const identity = currentIdentity(context);
  const metrics = await context.var.METRICS_SERVICE.readRunMetrics(runId, {
    email: identity.email,
    sub: identity.sub
  });

  if (metrics.retryAfterMs !== undefined) {
    // `Retry-After` is in seconds and must be at least 1, so a sub-second hint rounds up rather
    // than to zero — a zero would invite an immediate retry and a tight polling loop.
    context.header('Retry-After', String(Math.max(1, Math.ceil(metrics.retryAfterMs / 1000))));
  }

  return context.json(metrics);
});
