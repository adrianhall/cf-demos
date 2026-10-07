import { Hono } from 'hono';
import type { AppBindings } from '../bindings.ts';
import { requireAdmin } from '../middleware/require-admin.ts';

/**
 * Administrator-only router, mounted at `/api/admin`.
 *
 * Unlike the per-owner routes beside it, every route here deliberately operates across every
 * identity's data, which is exactly why the authorization check is mounted on the router rather
 * than written into each handler: a route added to this router is protected by construction, and
 * cannot be added without it. Hono runs router middleware before matching a path, so the check
 * covers a path that does not exist as readily as one that does — a non-administrator is answered
 * `403` for anything under this prefix, and never learns which administrative routes are real.
 *
 * Edge Access is not what makes this safe. The authenticated Access application admits every
 * identity in the account's Zero Trust team, because that is what "who is this" means; `/api/me`
 * then reports `isAdmin` so the client can decide whether to render the administrative link at all.
 * That report is presentation. {@link requireAdmin} re-derives the same comparison from the verified
 * JWT on every request here, so a browser that fabricated `isAdmin: true` gains exactly nothing.
 *
 * @returns A Hono router serving the administrative directory and moderation endpoints.
 */
export function createAdminRouter(): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  router.use(requireAdmin);

  /**
   * Lists one page of the user directory, most recently active identity first.
   *
   * The `limit` and `offset` the response echoes are the validated, defaulted values rather than
   * the raw query string: a client that sent neither still needs to know which window it got in
   * order to ask for the next one.
   *
   * @param context Hono request context carrying the untrusted pagination query and the admin
   *   service.
   * @returns A `200` response carrying the page, the directory's total size, and the window the
   *   page was read with.
   * @throws {ProblemDetailsError} `403` when the verified identity is not the configured
   *   administrator, and `422` when a pagination parameter is malformed or out of range.
   * @throws {NullError} When mounted without the Access middleware in front of it.
   * @throws {Error} When the repository cannot read the rows.
   */
  router.get('/users', async (context) =>
    context.json(await context.var.ADMIN_SERVICE.listUsers(context.req.query()))
  );

  /**
   * Reads any identity's diagram for moderation review.
   *
   * The response carries the same owner-blind projection the anonymous share viewer receives, so
   * this endpoint cannot disclose more about a diagram than somebody holding any share link already
   * could — see `../application/admin-service.ts` for why that scope is deliberate.
   *
   * @param context Hono request context carrying the untrusted `id` path parameter and the admin
   *   service.
   * @returns A `200` response carrying `{ diagram }` with the id, title, description and graph.
   * @throws {ProblemDetailsError} `403` when the verified identity is not the configured
   *   administrator, and `404` when the id is malformed or no diagram has it.
   * @throws {NullError} When mounted without the Access middleware in front of it.
   * @throws {Error} When the repository cannot read the row.
   */
  router.get('/diagrams/:id', async (context) => {
    const diagram = await context.var.ADMIN_SERVICE.getDiagram(context.req.param('id'));

    // The id alone, as everywhere else in this Worker. An administrator reading somebody's
    // diagram is worth recording; its title and graph are that person's content and do not belong
    // in an operational log.
    context.var.LOGGER.info('admin_diagram_opened', { diagramId: diagram.id });
    return context.json({ diagram });
  });

  /**
   * Deletes any identity's diagram, cascading the revocation of every share link to it.
   *
   * Moderation, not owner self-service — `./diagrams.ts`'s own `DELETE` already covers that. The
   * cascade is not repeated here: it lives in the delete use case, so a moderated diagram leaves
   * exactly the state an owner's own delete leaves.
   *
   * @param context Hono request context carrying the untrusted `id` path parameter and the admin
   *   service.
   * @returns A `204` response with no body, because there is nothing left to describe.
   * @throws {ProblemDetailsError} `403` when the verified identity is not the configured
   *   administrator, and `404` when the id is malformed or no diagram has it.
   * @throws {NullError} When mounted without the Access middleware in front of it.
   * @throws {Error} When the repository cannot delete or revoke a row.
   */
  router.delete('/diagrams/:id', async (context) => {
    const id = context.req.param('id');
    await context.var.ADMIN_SERVICE.removeDiagram(id);

    context.var.LOGGER.info('admin_diagram_deleted', { diagramId: id });
    return new Response(null, { status: 204 });
  });

  return router;
}
