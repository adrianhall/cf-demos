import { badRequest, notFound } from "@adrianhall/cloudflare-toolkit/errors";
import { Hono } from "hono";
import { BLUEPRINT_MAP } from "../../blueprints";
import type { AppBindings } from "../bindings";
import { CollaboratorRepository } from "../collaborators/repository";
import {
  validateAddCollaboratorInput,
  validateCollaboratorEmailParam,
} from "../collaborators/validation";
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
import { UserRepository } from "../users/repository";

/**
 * Build a {@link CollaboratorRepository} wired to this request's D1 binding, for the
 * collaborator-management routes below. A small local helper rather than a module-level
 * singleton -- every other repository in this router is likewise constructed fresh per request
 * from `context.env.DB`, matching this app's existing pattern.
 */
function collaboratorRepositoryFor(env: AppBindings["Bindings"]) {
  const diagrams = new DiagramRepository(env.DB);
  const users = new UserRepository(env.DB);
  return new CollaboratorRepository(env.DB, diagrams, users);
}

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
  context
    .get("LOGGER")
    .info("diagram_created", { diagramId: diagram.id, via: "api" });
  return context.json({ diagram }, 201);
});

/** List the signed-in identity's own diagrams, most recently updated first. */
diagramsRouter.get("/", async (context) => {
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;
  const repository = new DiagramRepository(context.env.DB);
  return context.json({ diagrams: await repository.listOwned(ownerEmail) });
});

/**
 * List diagrams the signed-in identity collaborates on (never diagrams it owns) --
 * docs/09C-COLLABORATIVE-EDITING.md's Collaborator Model API table. Deliberately registered
 * ahead of `GET /:id` below: if a request for this path were ever matched against `/:id`
 * instead, `id` would be the literal string `"shared-with-me"`, which `../diagrams/validation.ts`'s
 * `validateDiagramId()` rejects as a malformed id (`404`) -- silently breaking this route
 * instead of ever returning the shared-diagram list. Hono's router already prefers a static path
 * segment over a same-position `:param` regardless of registration order, but registering it
 * first here keeps that reliance visible in the source rather than depending on a router
 * internal a future refactor could silently invalidate --
 * `../../tests/integration/diagrams.test.ts` asserts the actual runtime behavior directly.
 */
diagramsRouter.get("/shared-with-me", async (context) => {
  const email = context.get("Cloudflare_Access_Identity").email;
  const repository = new DiagramRepository(context.env.DB);
  return context.json({ diagrams: await repository.listSharedWith(email) });
});

/**
 * Load one diagram the signed-in identity may access -- either because it owns it, or because
 * it has been granted collaborator access (docs/09C-COLLABORATIVE-EDITING.md's Access Model).
 */
diagramsRouter.get("/:id", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const email = context.get("Cloudflare_Access_Identity").email;
  const repository = new DiagramRepository(context.env.DB);
  const accessible = await repository.findAccessible(id, email);
  if (accessible === null) {
    throw notFound({ detail: "Diagram not found." });
  }
  context.get("LOGGER").info("diagram_opened", { diagramId: id });
  return context.json({ diagram: accessible.diagram });
});

/**
 * Live-sync WebSocket upgrade (docs/09C-COLLABORATIVE-EDITING.md's Live-Editing Architecture):
 * the editor's `DiagramCanvas` opens this connection when a diagram loads, receives a
 * `graph_snapshot` immediately, and both sends and receives discrete `operation` frames for as
 * long as it stays open. Access is verified here -- owner or collaborator, per
 * docs/09C-COLLABORATIVE-EDITING.md's Access Model -- before the request ever reaches the
 * `DiagramSession` Durable Object -- that object performs no authorization of its own, matching
 * this repository's usual pattern of authorization living at the Worker/API boundary.
 *
 * The verified identity is forwarded to `DiagramSession` as an `identity` query parameter on a
 * cloned request -- `context.req.raw` itself is never mutated, so this modification only ever
 * exists on the request the Worker hands to the Durable Object, never on the original inbound
 * request the browser sent.
 */
diagramsRouter.get("/:id/live", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  if (context.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    throw badRequest({ detail: "Expected a WebSocket upgrade request." });
  }

  const email = context.get("Cloudflare_Access_Identity").email;
  const repository = new DiagramRepository(context.env.DB);
  if ((await repository.findAccessible(id, email)) === null) {
    throw notFound({ detail: "Diagram not found." });
  }

  const forwardedUrl = new URL(context.req.raw.url);
  forwardedUrl.searchParams.set("identity", email);
  const forwardedRequest = new Request(forwardedUrl, context.req.raw);
  return context.env.DIAGRAM_SESSIONS.getByName(id).fetch(forwardedRequest);
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
    .info("diagram_updated", { diagramId: id, kind: "metadata", via: "api" });
  return context.json({ diagram });
});

/**
 * Autosave a diagram's complete graph. This is *not* the primary write path any more
 * (docs/09C-COLLABORATIVE-EDITING.md's "Retiring The Whole-Graph Autosave") -- the editor's live
 * WebSocket sends discrete `operation` frames instead once connected. This route stays as a
 * resilience fallback for a client whose live socket has not yet (re)connected, and the client
 * still debounces this call and always sends the full graph -- there is no partial-patch
 * protocol.
 *
 * A collaborator (not just the owner) may call this route (docs/09C-COLLABORATIVE-EDITING.md's
 * Access Model), so the underlying `DiagramSession.applyWholeGraphReplace()` call is scoped by
 * the diagram's *owner* email at hydration time -- read from `../diagram-session/diagram-session.ts`'s
 * own hydration, not from the caller's identity here -- since that method's D1 write is scoped
 * by owner, not by whichever identity is currently editing.
 */
diagramsRouter.put("/:id/graph", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const email = context.get("Cloudflare_Access_Identity").email;
  const graphData = validateGraphDataInput(await readJsonBody(context.req.raw));

  const repository = new DiagramRepository(context.env.DB);
  if ((await repository.findAccessible(id, email)) === null) {
    throw notFound({ detail: "Diagram not found." });
  }

  const { updatedAt } = await context.env.DIAGRAM_SESSIONS.getByName(
    id,
  ).applyWholeGraphReplace(graphData, email, "human");
  context
    .get("LOGGER")
    .info("diagram_updated", { diagramId: id, kind: "graph", via: "api" });
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
  context.get("LOGGER").info("diagram_shared", { diagramId: id, via: "api" });
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
  context
    .get("LOGGER")
    .info("diagram_share_revoked", { diagramId: id, via: "api" });
  return new Response(null, { status: 204 });
});

/**
 * List a diagram's collaborators -- available to the owner and to any existing collaborator
 * (`findAccessible`), so a co-editor can see who else has access, not only the owner
 * (docs/09C-COLLABORATIVE-EDITING.md's Collaborator Model API table).
 */
diagramsRouter.get("/:id/collaborators", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const email = context.get("Cloudflare_Access_Identity").email;
  const diagramRepository = new DiagramRepository(context.env.DB);
  if ((await diagramRepository.findAccessible(id, email)) === null) {
    throw notFound({ detail: "Diagram not found." });
  }

  const collaboratorRepository = collaboratorRepositoryFor(context.env);
  return context.json({
    collaborators: await collaboratorRepository.list(id),
  });
});

/**
 * Grant a specific, already-known Access identity full edit access to a diagram -- owner only.
 * `CollaboratorRepository.add()` itself enforces the `404` (never signed in) and `400` (the
 * owner's own email) rejection cases (docs/09C-COLLABORATIVE-EDITING.md's Collaborator Model API
 * table); this handler does not duplicate that logic.
 */
diagramsRouter.post("/:id/collaborators", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;
  const email = validateAddCollaboratorInput(
    await readJsonBody(context.req.raw),
  );

  const collaboratorRepository = collaboratorRepositoryFor(context.env);
  const collaborator = await collaboratorRepository.add(id, ownerEmail, email);
  context.get("LOGGER").info("collaborator_added", {
    collaboratorEmail: collaborator.email,
    diagramId: id,
  });
  return context.json({ collaborator }, 201);
});

/**
 * Remove one collaborator from a diagram -- allowed for the owner (removing anyone) or for the
 * named collaborator removing themselves ("Leave diagram"). `204` in both cases; `404` if the
 * row does not exist, or if `actorEmail` is neither the owner nor `email` itself
 * (`CollaboratorRepository.remove()` enforces that combination -- see its own JSDoc).
 */
diagramsRouter.delete("/:id/collaborators/:email", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const email = validateCollaboratorEmailParam(context.req.param("email"));
  const actorEmail = context.get("Cloudflare_Access_Identity").email;

  const collaboratorRepository = collaboratorRepositoryFor(context.env);
  const removed = await collaboratorRepository.remove(id, actorEmail, email);
  if (!removed) {
    throw notFound({ detail: "Collaborator not found." });
  }
  context
    .get("LOGGER")
    .info("collaborator_removed", { collaboratorEmail: email, diagramId: id });
  return new Response(null, { status: 204 });
});
