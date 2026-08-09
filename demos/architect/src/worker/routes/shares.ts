import { notFound } from "@adrianhall/cloudflare-toolkit/errors";
import { Hono } from "hono";
import type { AppBindings } from "../bindings";
import { DiagramRepository } from "../diagrams/repository";
import { ShareRepository } from "../shares/repository";
import { validateShareToken } from "../shares/validation";

/**
 * Public, anonymous share-token resolver mounted at `/api/share` by `../index.ts`. Exempted from
 * `accessMiddleware` by an explicit `authenticate: false` entry in `../../access-policies.ts`
 * (ahead of the general `/api` policy) and, in production, by `infra/access.tf`'s authenticated
 * `app` Access application listing narrower destinations than a bare `/api/*` wildcard so this
 * path falls through to the hostname-wide public `bypass` application instead
 * (docs/09-ARCHITECT.md's Access Model). No `enforceSameOriginJson`/`requestBodyLimit`
 * middleware here: this router only ever serves anonymous `GET` requests, never a
 * state-changing one, and an anonymous viewer may legitimately load this page cross-origin
 * (e.g. a link pasted into chat).
 */
export const sharesRouter = new Hono<AppBindings>();

/**
 * Resolve a share token to its diagram's read-only fields. A malformed, unknown, or revoked
 * token is reported identically -- `404` -- so a caller can never distinguish "never existed"
 * from "was revoked" (docs/09-ARCHITECT.md's non-negotiable tests). Always reads the diagram's
 * *current* `graph_data` (the live-pointer sharing model, docs/09-ARCHITECT.md's Decisions #3):
 * there is no snapshot to keep in sync, so an edit the owner makes after sharing is immediately
 * visible through this same link.
 */
sharesRouter.get("/:token", async (context) => {
  const token = validateShareToken(context.req.param("token"));
  const shareRepository = new ShareRepository(
    context.env.DB,
    context.env.SHARES,
  );
  const diagramId = await shareRepository.resolve(token);
  if (diagramId === null) {
    throw notFound({ detail: "Share link not found or revoked." });
  }

  const diagramRepository = new DiagramRepository(context.env.DB);
  const diagram = await diagramRepository.findPublicFields(diagramId);
  if (diagram === null) {
    throw notFound({ detail: "Share link not found or revoked." });
  }

  return context.json({ diagram });
});
