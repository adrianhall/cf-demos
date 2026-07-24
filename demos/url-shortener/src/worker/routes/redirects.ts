import { Hono } from "hono";
import type { AppBindings } from "../bindings";
import { LinkRepository } from "../links/repository";
import { validateCode } from "../links/validation";

/**
 * Public short-link redirect route, mounted at `/l` by `../index.ts`. Bypasses
 * Cloudflare Access (see `accessPolicies` in `../../access-policies.ts`).
 */
export const redirectsRouter = new Hono<AppBindings>();

/** Redirect a visitor to the configured destination and log the informational event. */
redirectsRouter.get("/:code", async (context) => {
  const repository = new LinkRepository(context.env.LINKS);
  const link = await repository.get(validateCode(context.req.param("code")));
  context.get("LOGGER").info("short_link_used", { code: link.code });
  return new Response(null, {
    headers: { "Cache-Control": "no-store", Location: link.destination },
    status: 302,
  });
});
