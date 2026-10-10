import { throwIfNull } from "@adrianhall/cloudflare-toolkit/guards";
import { Hono } from "hono";
import type { AppBindings } from "../bindings";

/**
 * Reports the authenticated identity's email, mounted at `/api/me` by `../index.ts`
 * (docs/07-PR-REVIEW-AGENT.md, "API And Routing"). Behind `accessMiddleware`
 * (`../middleware/access.ts`'s `/^\/api\//` policy) like every other `/api/*` route, so a
 * request never reaches this handler without a verified Cloudflare Access identity already set.
 *
 * Unlike `demos/url-shortener`'s own `/api/me` (which layers `requireAdmin` on top of Access),
 * this route has no equivalent per-identity check: "every authenticated identity can see every
 * past run; there is no per-user or per-team scoping" (docs/07-PR-REVIEW-AGENT.md, "Out Of
 * Scope"). This endpoint exists only to surface the verified identity for the UI's header --
 * never to gate access to anything.
 */
export const meRouter = new Hono<AppBindings>();

/** Return the verified identity's email. `accessMiddleware` has already confirmed a valid
 * Cloudflare Access JWT was presented before this handler ever runs. */
meRouter.get("/", (context) => {
  const identity = context.get("Cloudflare_Access_Identity");
  throwIfNull(identity, "accessMiddleware must run before this handler");
  return context.json({ email: identity.email });
});
