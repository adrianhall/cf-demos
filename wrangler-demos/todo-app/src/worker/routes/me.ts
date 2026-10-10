import { Hono } from "hono";
import type { AppBindings } from "../bindings";

/** Authenticated identity API mounted at `/api/me`. */
export const meRouter = new Hono<AppBindings>();

/** Return the email from the Access identity verified by the API middleware. */
meRouter.get("/", (context) => {
  return context.json({
    email: context.get("Cloudflare_Access_Identity").email,
  });
});
