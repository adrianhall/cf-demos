import { Hono } from "hono";
import type { AppBindings } from "../bindings";

/**
 * Authenticated identity API mounted at `/api/me`.
 *
 * Unlike `demos/url-shortener`'s admin-only `/api/me`, every authenticated identity gets a
 * `200` here — the client uses `isAdmin` to conditionally render admin UI (added in Phase 4)
 * without a separate round trip or a `403` for ordinary users.
 */
export const meRouter = new Hono<AppBindings>();

/**
 * Return the verified identity's email and whether it matches the operator-configured
 * `ADMIN_EMAIL`. This is the only place admin status is computed — there is no D1 role column
 * (docs/09-ARCHITECT.md's Access Model).
 */
meRouter.get("/", (context) => {
  const identity = context.get("Cloudflare_Access_Identity");
  return context.json({
    email: identity.email,
    isAdmin: identity.email === context.env.ADMIN_EMAIL,
  });
});
