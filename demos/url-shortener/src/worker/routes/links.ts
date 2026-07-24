import { Hono } from "hono";
import type { AppBindings } from "../bindings";
import { readJsonBody } from "../lib/read-json-body";
import { LinkRepository } from "../links/repository";
import { validateCode, validateLinkInput } from "../links/validation";
import { requestBodyLimit } from "../middleware/body-limit";

/**
 * Administrative short-link API, mounted at `/api/links` by `../index.ts`. Every route
 * here is behind Cloudflare Access in production (see `middleware/access.ts`).
 */
export const linksRouter = new Hono<AppBindings>();

linksRouter.use(requestBodyLimit);

/** List every short link, newest update first. */
linksRouter.get("/", async (context) => {
  const repository = new LinkRepository(context.env.LINKS);
  return context.json({ links: await repository.list() });
});

/** Create a short link from `{ "destination": "https://..." }`. */
linksRouter.post("/", async (context) => {
  const input = validateLinkInput(await readJsonBody(context.req.raw));
  const repository = new LinkRepository(context.env.LINKS);
  const link = await repository.create(input);
  return context.json({ link }, 201);
});

/** Read one short link by code. */
linksRouter.get("/:code", async (context) => {
  const repository = new LinkRepository(context.env.LINKS);
  const link = await repository.get(validateCode(context.req.param("code")));
  return context.json({ link });
});

/** Replace a short link's destination while preserving its code. */
linksRouter.put("/:code", async (context) => {
  const code = validateCode(context.req.param("code"));
  const input = validateLinkInput(await readJsonBody(context.req.raw));
  const repository = new LinkRepository(context.env.LINKS);
  return context.json({ link: await repository.update(code, input) });
});

/** Delete a short link. */
linksRouter.delete("/:code", async (context) => {
  const repository = new LinkRepository(context.env.LINKS);
  await repository.delete(validateCode(context.req.param("code")));
  return new Response(null, { status: 204 });
});
