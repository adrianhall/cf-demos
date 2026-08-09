import { notFound } from "@adrianhall/cloudflare-toolkit/errors";
import { Hono } from "hono";
import type { AppBindings } from "../bindings";
import { DiagramRepository } from "../diagrams/repository";
import { validateDiagramId } from "../diagrams/validation";
import { requireAdmin } from "../middleware/admin";
import { requestBodyLimit } from "../middleware/body-limit";
import { enforceSameOriginJson } from "../middleware/same-origin";
import { ShareRepository } from "../shares/repository";
import { UserRepository } from "../users/repository";
import { validateListUsersQuery } from "../users/validation";

/**
 * Administrator-only user directory and diagram moderation API, mounted at `/api/admin` by
 * `../index.ts`. Every route here requires a verified Cloudflare Access identity
 * (`accessMiddleware`, mounted on all of `/api/*` ahead of this router) *and* additionally
 * requires that identity to match the operator-configured `ADMIN_EMAIL` (`requireAdmin`) --
 * unlike `../routes/diagrams.ts`, which scopes every read/write to its own caller, every route
 * here deliberately operates across every identity's data (docs/09-ARCHITECT.md Phase 4: "a
 * read-only user directory plus diagram moderation (view/delete any user's diagram)").
 *
 * `GET /diagrams/:id` deliberately projects the same owner-blind fields as the anonymous share
 * viewer (`../routes/shares.ts`) rather than a full owner-scoped `Diagram` -- see that route's
 * own JSDoc for why this does not weaken docs/09-ARCHITECT.md's non-negotiable "a non-owner
 * cannot read another user's diagram" test for *ordinary* identities: this projection never
 * carries `ownerEmail`, so it exposes nothing an admin couldn't already see by holding any
 * diagram's share link.
 */
export const adminRouter = new Hono<AppBindings>();

adminRouter.use(requireAdmin);
adminRouter.use(requestBodyLimit);
adminRouter.on(["DELETE"], "*", enforceSameOriginJson);

/**
 * List a page of the `users` directory, most recently active identity first, each row annotated
 * with how many diagrams it currently owns. Accepts `?limit=` (default 20, max 100) and
 * `?offset=` query parameters (`../users/validation.ts`'s `validateListUsersQuery()`).
 */
adminRouter.get("/users", async (context) => {
  const { limit, offset } = validateListUsersQuery(context.req.query());
  const repository = new UserRepository(context.env.DB);
  const page = await repository.listWithDiagramCounts({ limit, offset });
  return context.json({ ...page, limit, offset });
});

/**
 * Load one diagram's read-only fields for moderation review, regardless of owner --
 * intentionally reusing `DiagramRepository.findPublicFields()`, the exact same owner-blind
 * projection the anonymous share viewer uses (`../routes/shares.ts`), so this route can never
 * expose more about a diagram than a random person holding *any* diagram's share link already
 * could. This is what lets the admin UI show what a diagram actually contains -- title,
 * description, graph -- before deciding whether to delete it, without adding a second way to
 * discover who owns it (`ownerEmail` is never selected by that projection).
 */
adminRouter.get("/diagrams/:id", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const repository = new DiagramRepository(context.env.DB);
  const diagram = await repository.findPublicFields(id);
  if (diagram === null) {
    throw notFound({ detail: "Diagram not found." });
  }
  return context.json({ diagram });
});

/**
 * Delete any user's diagram -- moderation, not owner self-service (`../routes/diagrams.ts`'s
 * `DELETE /api/diagrams/:id` already covers that). Cascades to revoke every share link for the
 * diagram, exactly like the owner-delete route, so a moderated diagram's share link can never
 * keep resolving.
 */
adminRouter.delete("/diagrams/:id", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const repository = new DiagramRepository(context.env.DB);
  const removed = await repository.removeAny(id);
  if (!removed) {
    throw notFound({ detail: "Diagram not found." });
  }
  await new ShareRepository(
    context.env.DB,
    context.env.SHARES,
  ).revokeAllForDiagram(id);
  context.get("LOGGER").info("admin_diagram_deleted", { diagramId: id });
  return new Response(null, { status: 204 });
});
