import { Hono } from 'hono';
import { jsonBodyLimit } from '@demos/worker-common';
import manifest from '../../documentation-manifest.json' with { type: 'json' };
import type { AppBindings } from '../bindings';
import { requireAdmin } from '../middleware/require-admin';

/**
 * Administrator API for the knowledge base, mounted at `/api/admin`.
 *
 * {@link requireAdmin} gates the whole router, and every application service behind it re-checks the
 * same actor. The duplication is intentional: a service that is only safe when reached through the
 * right router is a service whose safety depends on routing, and the next transport to call it — a
 * queue consumer, a scheduled handler — would not know.
 */
export const adminRouter = new Hono<AppBindings>();

/**
 * Largest number of rows any administrator listing returns.
 *
 * These views exist to show an operator what is stale or failing, not to export the knowledge base,
 * so a fixed ceiling is better than client-controlled paging the first version would get wrong.
 */
const LIST_LIMIT = 200;

adminRouter.use(jsonBodyLimit());
adminRouter.use(requireAdmin);

/**
 * Import the committed documentation manifest.
 *
 * The manifest is a build-time import rather than a request body. It is the approval list: an
 * administrator reviews it in version control, and accepting one over HTTP would let a signed-in
 * administrator approve content nobody reviewed. The endpoint therefore triggers an import of what
 * is committed rather than supplying what to import.
 *
 * @param context Hono request context providing the actor and documentation service.
 * @returns A JSON `200` response containing the imported and unchanged counts and the source
 *   revision.
 * @throws {NullError} When the route is reached without Access identity verification.
 * @throws {ProblemDetailsError} `forbidden()` (403) when the actor is not an administrator;
 *   `unprocessableContent()` (422) when the committed manifest is malformed, which is a build error
 *   surfaced at runtime rather than a client mistake.
 * @throws {Error} When the repository cannot be read or written.
 */
adminRouter.post('/documentation/import', async (context) => {
  const summary = await context
    .get('DOCUMENTATION_SERVICE')
    .importManifest(
      context.get('ACTOR'),
      context.get('CORRELATION_ID'),
      manifest,
      context.get('NOW')
    );
  context.get('LOGGER').info('documentation_imported', {
    revision: summary.revision,
    imported: summary.imported,
    unchanged: summary.unchanged
  });
  return context.json(summary);
});

/**
 * List approved documentation pages and their indexing state.
 *
 * @param context Hono request context providing the actor and documentation service.
 * @returns A JSON `200` response containing the approved pages.
 * @throws {NullError} When the route is reached without Access identity verification.
 * @throws {ProblemDetailsError} `forbidden()` (403) when the actor is not an administrator.
 * @throws {Error} When the repository cannot list the pages.
 */
adminRouter.get('/documentation', async (context) =>
  context.json({
    sources: await context
      .get('DOCUMENTATION_SERVICE')
      .listSources(context.get('ACTOR'), LIST_LIMIT)
  })
);

/**
 * Show the freshness of the search index.
 *
 * This is the view the Phase 2 checkpoint asks for: an administrator can see that an answer is
 * durable in D1 but not yet searchable, and whether its indexing is pending, being retried, or has
 * exhausted its attempts. The response carries no FAQ content — only identifiers, counts, and
 * reason codes.
 *
 * @param context Hono request context providing the index-job service.
 * @returns A JSON `200` response containing recent index jobs.
 * @throws {NullError} When the route is reached without Access identity verification.
 * @throws {ProblemDetailsError} `forbidden()` (403) when the actor is not an administrator.
 * @throws {Error} When the repository cannot list the jobs.
 */
adminRouter.get('/index-jobs', async (context) =>
  context.json({ jobs: await context.get('INDEX_JOB_SERVICE').listRecent(LIST_LIMIT) })
);

/**
 * Work through the pending index jobs once.
 *
 * Exposed as an administrator action as well as being driven by scheduled maintenance, so a
 * demonstration does not have to wait for a cron tick to show a published answer becoming
 * searchable.
 *
 * @param context Hono request context providing the index-job service.
 * @returns A JSON `200` response containing the indexed, retrying, and failed counts.
 * @throws {NullError} When the route is reached without Access identity verification.
 * @throws {ProblemDetailsError} `forbidden()` (403) when the actor is not an administrator.
 * @throws {Error} When the job repository cannot be read. A single job failing against the index is
 *   reported in the counts rather than thrown.
 */
adminRouter.post('/index-jobs/run', async (context) => {
  const summary = await context.get('INDEX_JOB_SERVICE').runPending(context.get('CORRELATION_ID'));
  context.get('LOGGER').info('index_jobs_run', { ...summary });
  return context.json(summary);
});

/**
 * Read recent audit entries.
 *
 * @param context Hono request context providing the actor and audit service.
 * @returns A JSON `200` response containing recent audit events, newest first.
 * @throws {NullError} When the route is reached without Access identity verification.
 * @throws {ProblemDetailsError} `forbidden()` (403) when the actor is not an administrator;
 *   `unprocessableContent()` (422) when the `action` filter is not a recognized action.
 * @throws {Error} When the repository cannot list the entries.
 */
adminRouter.get('/audit', async (context) =>
  context.json({
    events: await context
      .get('AUDIT_SERVICE')
      .listEvents(context.get('ACTOR'), context.req.query('action'))
  })
);
