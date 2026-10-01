import { Hono } from 'hono';
import { jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import type { AppBindings } from '../bindings';
import { requireAdmin } from '../middleware/require-admin';

/**
 * Administrative short-link API, mounted at `/api/links`. Every route here is behind Cloudflare
 * Access in production and additionally requires the verified identity to match `ADMIN_EMAIL`,
 * rather than merely any valid identity from the same Cloudflare Access team.
 */
export const linksRouter = new Hono<AppBindings>();

linksRouter.use(requireAdmin);
linksRouter.use(jsonBodyLimit());

/**
 * List every short link, newest update first.
 *
 * @param context Hono request context providing the request-scoped link service.
 * @returns A JSON `200` response containing the administrative link collection.
 * @throws {Error} When the repository cannot list links.
 */
linksRouter.get('/', async (context) =>
  context.json({ links: await context.get('LINK_SERVICE').listLinks() })
);

/**
 * Create a short link from `{ "destination": "https://..." }`.
 *
 * @param context Hono request context containing the bounded JSON request body and link service.
 * @returns A JSON `201` response containing the newly created link.
 * @throws {ProblemDetailsError} When the request body or destination is invalid.
 * @throws {Error} When persistence cannot allocate or store the link.
 */
linksRouter.post('/', async (context) => {
  const link = await context.get('LINK_SERVICE').createLink(await readJsonBody(context.req.raw));
  return context.json({ link }, 201);
});

/**
 * Read one short link by code.
 *
 * @param context Hono request context containing the untrusted `code` path parameter.
 * @returns A JSON `200` response containing the requested link.
 * @throws {ProblemDetailsError} When the code is malformed or the link is absent.
 * @throws {Error} When persistence rejects the read.
 */
linksRouter.get('/:code', async (context) =>
  context.json({
    link: await context.get('LINK_SERVICE').getLink(context.req.param('code'))
  })
);

/**
 * Replace a short link's destination while preserving its code.
 *
 * @param context Hono request context containing the path code, JSON body, and link service.
 * @returns A JSON `200` response containing the updated link.
 * @throws {ProblemDetailsError} When the code/body is invalid or the link is absent.
 * @throws {Error} When persistence rejects the update.
 */
linksRouter.put('/:code', async (context) =>
  context.json({
    link: await context
      .get('LINK_SERVICE')
      .updateLink(context.req.param('code'), await readJsonBody(context.req.raw))
  })
);

/**
 * Delete a short link.
 *
 * @param context Hono request context containing the untrusted `code` path parameter.
 * @returns An empty `204` response after successful deletion.
 * @throws {ProblemDetailsError} When the code is malformed or the link is absent.
 * @throws {Error} When persistence rejects the deletion.
 */
linksRouter.delete('/:code', async (context) => {
  await context.get('LINK_SERVICE').deleteLink(context.req.param('code'));
  return new Response(null, { status: 204 });
});
