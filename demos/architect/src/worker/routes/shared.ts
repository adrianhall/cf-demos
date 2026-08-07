import { notFound } from "@adrianhall/cloudflare-toolkit/errors";
import { Hono } from "hono";
import { validateGraphDocument } from "../../graph/validation";
import type { AppBindings } from "../bindings";
import { readJsonBody } from "../lib/read-json-body";
import { requestBodyLimit } from "../middleware/body-limit";
import { requireSameOriginMutation } from "../middleware/mutation-guard";
import { digestShareToken } from "../shares/token";
import type { PublishedSnapshot } from "../shares/types";
import { validateResolveShareInput } from "../shares/validation";

/**
 * Anonymous public share resolution, mounted at `/shared` (not `/api/shared`) by `../index.ts`.
 *
 * Deliberately outside `accessMiddleware`'s protected paths — `../../access-policies.ts`'s
 * `/^\/shared(?:\/|$)/u` pattern already marks this whole prefix `authenticate: false`, so no
 * Cloudflare Access identity is ever required or read here. `wrangler.jsonc.tpl`'s
 * `assets.run_worker_first` already includes `/shared/*` (added in Phase 1, used starting here)
 * so this route actually reaches the Worker instead of falling through to static assets.
 *
 * This router never touches D1 or `DiagramRoom` — it reads only the `SHARES` KV entry and the
 * `SNAPSHOTS` R2 object it points at, per `docs/09-ARCHITECT.md`'s Product Responsibilities
 * table ("Fast anonymous share-token lookup to the current published R2 snapshot"). That is a
 * deliberate isolation boundary, not an optimization: an anonymous caller can therefore never
 * observe diagram membership, ownership, or any live editable room state, satisfying the
 * Non-Negotiable Tests' "public shares return only immutable published fields" requirement by
 * construction rather than by an extra field-filtering step.
 */
export const sharedRouter = new Hono<AppBindings>();

sharedRouter.use(requireSameOriginMutation);
sharedRouter.use(requestBodyLimit);

/**
 * Resolve a raw share token (from the public viewer's URL fragment, submitted in a same-origin
 * JSON body — never a URL path or query string, so it can never leak into a server or proxy
 * access log) to its currently published snapshot.
 *
 * Returns a generic `404` — via `../shares/validation.ts`'s `validateResolveShareInput()` for a
 * malformed token, and directly below for a well-formed but unknown/revoked one — so a caller
 * can never distinguish those cases from one another.
 */
sharedRouter.post("/resolve", async (context) => {
  const input = validateResolveShareInput(await readJsonBody(context.req.raw));
  const digest = await digestShareToken(input.token);

  const objectKey = await context.env.SHARES.get(digest);
  if (!objectKey) {
    throw notFound({ detail: "This share link is not valid." });
  }

  const object = await context.env.SNAPSHOTS.get(objectKey);
  if (!object) {
    throw notFound({ detail: "This share link is not valid." });
  }

  const snapshot = JSON.parse(await object.text()) as PublishedSnapshot;
  return context.json({
    document: validateGraphDocument(snapshot.document),
    revision: snapshot.revision,
    title: snapshot.title,
  });
});
