import { throwIfNull } from "@adrianhall/cloudflare-toolkit/guards";
import { Hono } from "hono";
import type { AppBindings } from "../bindings";

/**
 * Reports the authenticated user's verified Cloudflare Access identity, mounted at `/api/me` by
 * `../index.ts`. The browser header uses this to label the signed-in identity and render the
 * logout control; any authenticated user is a legitimate user of the playground, so there is no
 * additional per-email authorization check here (contrast with `demos/url-shortener`'s
 * `requireAdmin`).
 */
export const meRouter = new Hono<AppBindings>();

/** Return the verified identity. `accessMiddleware` has already rejected any unauthenticated request. */
meRouter.get("/", (context) => {
  const identity = context.get("Cloudflare_Access_Identity");
  throwIfNull(identity, "accessMiddleware must run before this handler");
  return context.json({ email: identity.email });
});
