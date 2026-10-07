import { Hono } from 'hono';
import type { AppBindings } from '../bindings.ts';
import { requireAdmin } from '../middleware/require-admin.ts';

/**
 * Administrator-only router, mounted at `/api/admin`.
 *
 * Unlike the per-owner routes added in later phases, every route here deliberately operates across
 * every identity's data, which is exactly why the authorization check is mounted on the router
 * rather than written into each handler: a route added to this router is protected by construction,
 * and cannot be added without it.
 *
 * **Phase 2 scope.** The router carries its authorization and no handlers yet; the user directory
 * and diagram moderation endpoints arrive in Phase 6. That is not a placeholder — Hono runs router
 * middleware before matching a path, so the check is live today: a non-administrator is answered
 * `403` for any path under this prefix, and the administrator is answered `404` for a route that
 * genuinely does not exist yet. Adding the authorization first means no window exists in which an
 * administrative path is reachable without it.
 *
 * @returns A Hono router admitting only the configured administrator.
 */
export function createAdminRouter(): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  router.use(requireAdmin);

  return router;
}
