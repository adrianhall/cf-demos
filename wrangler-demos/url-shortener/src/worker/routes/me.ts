import { throwIfNull } from "@adrianhall/cloudflare-toolkit/guards";
import { Hono } from "hono";
import type { AppBindings } from "../bindings";
import { requireAdmin } from "../middleware/require-admin";

/**
 * Reports the authenticated administrator's identity, mounted at `/api/me` by `../index.ts`.
 *
 * `/admin*` itself is served directly by the `ASSETS` binding rather than routed through this
 * Worker (see `wrangler.jsonc.tpl`), so the SPA calls this endpoint after mounting to confirm
 * the verified Cloudflare Access identity is actually this demo's configured administrator —
 * `requireAdmin` (`../middleware/require-admin.ts`) returns a `403` otherwise, which the client
 * renders as a "not allowed" state instead of the admin UI.
 */
export const meRouter = new Hono<AppBindings>();

meRouter.use(requireAdmin);

/** Return the verified administrator's email. `requireAdmin` has already confirmed it matches `ADMIN_EMAIL`. */
meRouter.get("/", (context) => {
  const identity = context.get("Cloudflare_Access_Identity");
  throwIfNull(identity, "requireAdmin must run before this handler");
  return context.json({ email: identity.email });
});
