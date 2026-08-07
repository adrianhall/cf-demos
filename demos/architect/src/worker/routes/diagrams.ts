import { unprocessableContent } from "@adrianhall/cloudflare-toolkit/errors";
import { Hono } from "hono";
import { getBlueprint } from "../../graph/blueprints";
import type { AppBindings } from "../bindings";
import { DiagramRepository } from "../diagrams/repository";
import { validateOperationInput } from "../diagrams/operation-input";
import {
  validateCreateDiagramInput,
  validateDiagramId,
  validateUpdateDiagramInput,
} from "../diagrams/validation";
import { readJsonBody } from "../lib/read-json-body";
import { requestBodyLimit } from "../middleware/body-limit";
import { requireSameOriginMutation } from "../middleware/mutation-guard";

/**
 * Owner-scoped diagram library and document API, mounted at `/api/diagrams` by `../index.ts`.
 *
 * Every route runs after `accessMiddleware` (see `../middleware/access.ts`), so
 * `Cloudflare_Access_Identity` is always set. Phase 2 has no editor membership yet, so every
 * lookup checks D1 ownership (`owner_email`) directly; Phase 3 extends this to
 * `diagram_members` without changing this router's request/response shapes.
 */
export const diagramsRouter = new Hono<AppBindings>();

diagramsRouter.use(requireSameOriginMutation);
diagramsRouter.use(requestBodyLimit);

/** List every diagram owned by the caller, most recently updated first. */
diagramsRouter.get("/", async (context) => {
  const identity = context.get("Cloudflare_Access_Identity").email;
  const repository = new DiagramRepository(context.env.DB);
  return context.json({ diagrams: await repository.listOwnedBy(identity) });
});

/**
 * Create a diagram, its owner membership row, and seed its `DiagramRoom` document from a
 * starter blueprint (`{ "title": "...", "blueprintId"?: "blank" | "static-site" | "api-storage" }`).
 */
diagramsRouter.post("/", async (context) => {
  const identity = context.get("Cloudflare_Access_Identity").email;
  const input = validateCreateDiagramInput(await readJsonBody(context.req.raw));
  const repository = new DiagramRepository(context.env.DB);
  const diagram = await repository.create(identity, input.title);

  const blueprint = getBlueprint(input.blueprintId);
  const room = context.env.DIAGRAM_ROOM.getByName(diagram.id);
  await room.applyOperation({
    operationId: crypto.randomUUID(),
    baseRevision: 0,
    kind: "replace_document",
    payload: { document: blueprint.document },
  });

  context.get("LOGGER").info("diagram_created", { diagramId: diagram.id });
  return context.json({ diagram }, 201);
});

/** Read one diagram's directory metadata plus its `DiagramRoom`'s current revision/document. */
diagramsRouter.get("/:id", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const identity = context.get("Cloudflare_Access_Identity").email;
  const repository = new DiagramRepository(context.env.DB);
  const diagram = await repository.getOwned(identity, id);

  const room = context.env.DIAGRAM_ROOM.getByName(id);
  const snapshot = await room.readDocument();

  context.get("LOGGER").info("diagram_opened", { diagramId: id });
  return context.json({
    diagram,
    revision: snapshot.revision,
    document: snapshot.document,
  });
});

/** Rename a diagram (`{ "title": "..." }`). Phase 2 supports no other mutable field. */
diagramsRouter.patch("/:id", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const identity = context.get("Cloudflare_Access_Identity").email;
  const input = validateUpdateDiagramInput(await readJsonBody(context.req.raw));
  const repository = new DiagramRepository(context.env.DB);
  const diagram = await repository.rename(identity, id, input.title);

  context.get("LOGGER").info("diagram_updated", { diagramId: id });
  return context.json({ diagram });
});

/**
 * Forward one revisioned document edit to `DiagramRoom.applyOperation`
 * (`{ "operationId": "...", "baseRevision": 0, "kind": "...", "payload": {...} }`).
 *
 * Phase 2 is single-user, but edits still flow through this exact revisioned-command endpoint so
 * Phase 4's WebSocket transport can be added without replacing the persistence model.
 */
diagramsRouter.post("/:id/operations", async (context) => {
  const id = validateDiagramId(context.req.param("id"));
  const identity = context.get("Cloudflare_Access_Identity").email;
  const repository = new DiagramRepository(context.env.DB);
  await repository.getOwned(identity, id);

  const operation = validateOperationInput(await readJsonBody(context.req.raw));
  const room = context.env.DIAGRAM_ROOM.getByName(id);
  const result = await room.applyOperation(operation);

  if (result.status === "rejected") {
    throw unprocessableContent({ detail: result.error });
  }
  if (result.status === "accepted") {
    await repository.touchUpdatedAt(id);
  }

  context.get("LOGGER").info("diagram_updated", {
    diagramId: id,
    status: result.status,
  });
  return context.json({ result });
});
