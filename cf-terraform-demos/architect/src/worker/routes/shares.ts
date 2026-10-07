import { Hono } from 'hono';
import type { AppBindings } from '../bindings.ts';

/**
 * The public share resolver, mounted at `/api/shares`.
 *
 * This is the only route in the application reachable without a verified identity beyond the health
 * probe, and three independent things have to agree for that to be both true and safe:
 *
 * - **`src/access-policies.ts`** lists `/api/shares/*` as unauthenticated _before_ the general
 *   `/api/` rule, so the Worker's own middleware lets it through. The local Access emulation reads
 *   the same list, so development and production behave identically.
 * - **`infra/access.tf`** simply omits this path from the authenticated application's destination
 *   list, so at the edge it falls through to the hostname-wide public bypass. The omission _is_ the
 *   mechanism; an `/api/*` wildcard there would take anonymous sharing away without touching a line
 *   of this file.
 * - **This router reads only.** There is no mutating route here and there must never be one: the
 *   same-origin middleware is a no-op for `GET`, deliberately, because an anonymous viewer may
 *   legitimately arrive cross-origin — from a link pasted into a chat client, for instance — and a
 *   read with no identity and no side effects is safe for them to make.
 *
 * Authorization is the token itself: a share link is a bearer capability, and holding it is the
 * whole of the permission. Everything that follows from that — the uniform `404`, the projection
 * that cannot name the diagram's owner — lives in `../application/share-service.ts`, so an MCP tool
 * resolving a share in a later phase gets the identical rules.
 *
 * @returns A Hono router serving the anonymous share resolver.
 */
export function createSharesRouter(): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  /**
   * Resolves a share token to the diagram's public, read-only fields.
   *
   * The response carries the diagram's **current** graph rather than a snapshot taken when the link
   * was created: sharing points at the live diagram, so an edit the owner makes afterwards is
   * visible through the same link immediately and there is no second copy to keep in step.
   *
   * @param context Hono request context carrying the untrusted `token` path parameter and the share
   *   service.
   * @returns A `200` response carrying `{ diagram }` with the id, title, description and graph —
   *   and deliberately not the owner.
   * @throws {ProblemDetailsError} `404` when the token is malformed, unknown, revoked, or points at
   *   a diagram that has since been deleted. All four are reported identically in status and body,
   *   so the endpoint cannot be used to probe for live links.
   * @throws {Error} When the repository cannot read the rows.
   */
  router.get('/:token', async (context) => {
    const diagram = await context.var.SHARE_SERVICE.resolve(context.req.param('token'));

    // No log line for a successful resolution. It would be one entry per anonymous page view, and
    // the only distinguishing value it could carry is the token — which is exactly the value that
    // must never be written down.
    return context.json({ diagram });
  });

  return router;
}
