import { throwIfNull } from "@adrianhall/cloudflare-toolkit/guards";
import { Hono } from "hono";
import type { AppBindings } from "../bindings";

/** Authenticated identity endpoint, mounted at `/api/me`. */
export const meRouter = new Hono<AppBindings>();

/** Return the identity Cloudflare Access verified for this request. */
meRouter.get("/", (context) => {
  const identity = context.get("Cloudflare_Access_Identity");
  throwIfNull(identity, "cloudflareAccess must run before /api/me");
  context.get("LOGGER").info("identity_read");
  return context.json({ email: identity.email });
});
