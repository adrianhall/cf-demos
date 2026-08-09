import { notFound } from "@adrianhall/cloudflare-toolkit/errors";
import { Hono } from "hono";
import { BLUEPRINT_MAP } from "../../blueprints";
import type { AppBindings } from "../bindings";
import { DiagramRepository } from "../diagrams/repository";
import {
  validateCreateDiagramInput,
  validateDiagramId,
  validateGraphDataInput,
  validateUpdateDiagramInput,
} from "../diagrams/validation";
import { readJsonBody } from "../lib/read-json-body";
import { requestBodyLimit } from "../middleware/body-limit";
import { enforceSameOriginJson } from "../middleware/same-origin";
import { ShareRepository } from "../shares/repository";

/**
 * Owner-scoped diagram directory and autosave API, mounted at `/api/diagrams` by `../index.ts`.
 * Every route requires a verified Cloudflare Access identity (`accessMiddleware`, mounted on all
 * of `/api/*` ahead of this router) and scopes every read/write to that identity's own diagrams
 * (`DiagramRepository`'s `owner_email`-scoped queries) -- a diagram id that exists but belongs
 * to a different identity is reported identically to one that does not exist at all (`404`),
 * never `403`, so a client can never confirm another user's diagram id is valid.
 */
export const diagramsRouter = new Hono<AppBindings>();

diagramsRouter.use(requestBodyLimit);
diagramsRouter.on(
  ["POST", "PUT", "PATCH", "DELETE"],
  "*",
  enforceSameOriginJson,
);

/**
 * Create a new diagram owned by the signed-in identity. When the request carries a
 * `blueprintId`, it is resolved against `BLUEPRINT_MAP` -- one of the eight static templates in
 * `../../blueprints.ts` -- and that blueprint's `graphData` seeds the new diagram; an unknown
 * `blueprintId` is rejected as `404` before any D1 write. There is deliberately no
 * `blueprint_id` column to persist (docs/09-ARCHITECT.md's Data Model): once cloned, a diagram's
 * graph is independent of the blueprint it started from.
 */
diagramsRouter.post("/", async (context) => {
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;
  const input = validateCreateDiagramInput(await readJsonBody(context.req.raw));

  let graphData: string | undefined;
  if (input.blueprintId !== undefined) {
    const blueprint = BLUEPRINT_MAP.get(input.blueprintId);
    if (blueprint === undefined) {
      throw notFound({ detail: `Blueprint "${input.blueprintId}" not found.` });
    }
    graphData = blueprint.graphData;
  }

  const repository = new DiagramRepository(context.env.DB);
  const diagram = await repository.create(ownerEmail, { ...input, graphData });
  context.get("LOGGER").info("diagram_created", { diagramId: diagram.id });
  return context.json({ diagram }, 201);
});

/** List the signed-in identity's own diagrams, most recently updated first. */
diagramsRouter.get("/", async (context) => {
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;
  const repository = new DiagramRepository(context.env.DB);
  return context.json({ diagrams: await repository.listOwned(ownerEmail) });
});

/** Load one diagram owned by the signed-in identity. */
diagramsRouter.get("/:id", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;
  const repository = new DiagramRepository(context.env.DB);
  const diagram = await repository.findOwned(id, ownerEmail);
  if (diagram === null) {
    throw notFound({ detail: "Diagram not found." });
  }
  context.get("LOGGER").info("diagram_opened", { diagramId: id });
  return context.json({ diagram });
});

/** Rename a diagram and/or change its description. */
diagramsRouter.patch("/:id", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;
  const input = validateUpdateDiagramInput(await readJsonBody(context.req.raw));

  const repository = new DiagramRepository(context.env.DB);
  const diagram = await repository.updateMetadata(id, ownerEmail, input);
  if (diagram === null) {
    throw notFound({ detail: "Diagram not found." });
  }
  context
    .get("LOGGER")
    .info("diagram_updated", { diagramId: id, kind: "metadata" });
  return context.json({ diagram });
});

/**
 * Autosave a diagram's complete graph. The client debounces this call client-side (see
 * `src/client/components/editor/DiagramCanvas.tsx`) and always sends the full graph -- there is
 * no partial-patch protocol.
 */
diagramsRouter.put("/:id/graph", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;
  const graphData = validateGraphDataInput(await readJsonBody(context.req.raw));

  const repository = new DiagramRepository(context.env.DB);
  const updatedAt = await repository.saveGraphData(id, ownerEmail, graphData);
  if (updatedAt === null) {
    throw notFound({ detail: "Diagram not found." });
  }
  context
    .get("LOGGER")
    .info("diagram_updated", { diagramId: id, kind: "graph" });
  return context.json({ updatedAt });
});

/**
 * Delete a diagram owned by the signed-in identity, cascading to revoke every share link for it
 * -- a deleted diagram must never keep resolving through a link minted before it was removed
 * (docs/09-ARCHITECT.md's non-negotiable tests). The cascade only ever runs after `remove()`
 * itself reports a real deletion, so it can never be used to probe or revoke another owner's
 * share by guessing at a diagram id.
 */
diagramsRouter.delete("/:id", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;
  const repository = new DiagramRepository(context.env.DB);
  const removed = await repository.remove(id, ownerEmail);
  if (!removed) {
    throw notFound({ detail: "Diagram not found." });
  }
  await new ShareRepository(
    context.env.DB,
    context.env.SHARES,
  ).revokeAllForDiagram(id);
  return new Response(null, { status: 204 });
});

/**
 * Owner-only share status: whether a read-only link is currently active for this diagram, and
 * when it was created. Never returns the link itself -- see `../shares/types.ts`'s
 * `ShareStatus` JSDoc for why the server cannot recover a token once minted.
 */
diagramsRouter.get("/:id/share", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;
  const diagramRepository = new DiagramRepository(context.env.DB);
  if ((await diagramRepository.findOwned(id, ownerEmail)) === null) {
    throw notFound({ detail: "Diagram not found." });
  }

  const shareRepository = new ShareRepository(
    context.env.DB,
    context.env.SHARES,
  );
  return context.json(await shareRepository.getStatus(id));
});

/**
 * Create (or rotate) the diagram's read-only share link. Any share link previously active for
 * this diagram is revoked in the same operation -- at most one active link exists per diagram at
 * a time (`../shares/repository.ts`'s class-level JSDoc) -- and the newly minted raw token is
 * returned in this response only: per docs/09-ARCHITECT.md's Decisions #3, only a SHA-256
 * digest of the token is ever persisted, so this is the one and only moment the owner can be
 * handed a working link.
 */
diagramsRouter.post("/:id/share", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;
  const diagramRepository = new DiagramRepository(context.env.DB);
  if ((await diagramRepository.findOwned(id, ownerEmail)) === null) {
    throw notFound({ detail: "Diagram not found." });
  }

  const shareRepository = new ShareRepository(
    context.env.DB,
    context.env.SHARES,
  );
  const share = await shareRepository.rotate(id);
  context.get("LOGGER").info("diagram_shared", { diagramId: id });
  const url = new URL(`/s/${share.token}`, context.req.url).toString();
  return context.json({ ...share, url }, 201);
});

/** Revoke the diagram's active share link, if any. */
diagramsRouter.delete("/:id/share", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;
  const diagramRepository = new DiagramRepository(context.env.DB);
  if ((await diagramRepository.findOwned(id, ownerEmail)) === null) {
    throw notFound({ detail: "Diagram not found." });
  }

  const shareRepository = new ShareRepository(
    context.env.DB,
    context.env.SHARES,
  );
  const revoked = await shareRepository.revokeActive(id);
  if (!revoked) {
    throw notFound({ detail: "No active share link for this diagram." });
  }
  context.get("LOGGER").info("diagram_share_revoked", { diagramId: id });
  return new Response(null, { status: 204 });
});
