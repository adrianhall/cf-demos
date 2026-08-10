import { notFound } from "@adrianhall/cloudflare-toolkit/errors";
import type { Logger } from "@adrianhall/cloudflare-toolkit/logging";
import { strToU8, zipSync } from "fflate";
import { BLUEPRINT_MAP } from "../../blueprints";
import { generateScaffold } from "../../client/lib/scaffold";
import type { DiagramSession } from "../diagram-session/diagram-session";
import {
  type AddEdgeInput,
  type AddNodeInput,
  addEdge,
  addNode,
  autoLayout,
  type EdgePatch,
  type NodePatch,
  removeEdge,
  removeNode,
  updateEdge,
  updateNode,
} from "../diagrams/graph-mutations";
import { DiagramRepository } from "../diagrams/repository";
import type { Diagram, GraphData } from "../diagrams/types";
import {
  canonicalizeGraphData,
  validateCreateDiagramInput,
  validateUpdateDiagramInput,
} from "../diagrams/validation";
import { ShareRepository } from "../shares/repository";
import type { CreatedShare, ShareStatus } from "../shares/types";

/**
 * Everything an MCP tool handler (`./server.ts`) needs to act on one authenticated caller's own
 * diagrams -- resolved once per `/mcp` request from the same verified Cloudflare Access identity
 * every `/api/*` route already uses (docs/09B-ARCHITECT-MCP.md's Access Model), never from the
 * MCP SDK's own OAuth/`getMcpAuthContext()` plumbing. Narrow `Pick<...>` binding shapes (matching
 * `DiagramRepository`/`ShareRepository`'s own constructor parameters) so every function here is
 * unit-testable against the same fixture D1/KV doubles `repository.test.ts` already uses, with no
 * Worker runtime involved.
 */
export interface McpToolContext {
  /** Verified Cloudflare Access identity's email -- every read/write below is scoped to it. */
  ownerEmail: string;
  /** D1 capability backing `DiagramRepository`/`ShareRepository`. */
  db: Pick<D1Database, "prepare">;
  /** `SHARES` KV capability backing `ShareRepository`. */
  sharesKv: Pick<KVNamespace, "get" | "put" | "delete">;
  /**
   * Request-scoped structured logger, matching `context.get("LOGGER")` on every `/api/*` route.
   * Narrowed to `info` -- the only method any tool below calls -- so a fixture logger double
   * needs no more than a single stub method.
   */
  logger: Pick<Logger, "info">;
  /**
   * Resolve the live-sync `DiagramSession` Durable Object stub for one diagram id
   * (`../diagram-session/diagram-session.ts`, docs/09B-ARCHITECT-MCP.md's Live Sync
   * Architecture). Every graph-mutating tool below calls `notifyGraphUpdated()` on it
   * immediately after a successful D1 write. Narrowed to that one RPC method, so a unit test can
   * fake it with a plain `{ notifyGraphUpdated: vi.fn() }` double -- no real Durable Object
   * involved.
   */
  getDiagramSession: (
    diagramId: string,
  ) => Pick<DurableObjectStub<DiagramSession>, "notifyGraphUpdated">;
  /**
   * The incoming `/mcp` request's own URL, used only to resolve `create_share_link`'s returned
   * `url` against this Worker's real origin -- `new URL("/s/<token>", requestUrl)` -- exactly
   * like `../routes/diagrams.ts`'s `POST /:id/share` resolves it against `context.req.url`.
   */
  requestUrl: string;
}

/**
 * The trimmed-down diagram shape `list_diagrams` returns -- deliberately omitting `graphData`
 * (unlike `DiagramRepository.listOwned()`'s dashboard-oriented full rows) so listing many
 * diagrams stays cheap for a calling model's context window
 * (docs/09B-ARCHITECT-MCP.md's Remote MCP Tool Catalog).
 */
export interface DiagramSummary {
  /** Server-generated UUID, immutable for the diagram's lifetime. */
  id: string;
  /** User-editable title. */
  title: string;
  /** Optional free-text description, `null` when never set. */
  description: string | null;
  /** ISO-8601 timestamp of the most recent metadata or graph update. */
  updatedAt: string;
}

/**
 * Project a full {@link Diagram} down to its {@link DiagramSummary} fields.
 *
 * @param diagram Full diagram row.
 * @returns The trimmed-down summary shape.
 */
function toSummary(diagram: Diagram): DiagramSummary {
  return {
    description: diagram.description,
    id: diagram.id,
    title: diagram.title,
    updatedAt: diagram.updatedAt,
  };
}

/**
 * `list_diagrams` tool logic: every diagram owned by the authenticated caller, most recently
 * updated first, as lightweight summaries.
 *
 * @param context Resolved MCP tool context.
 * @returns The caller's own diagrams.
 */
export async function listDiagramsTool(
  context: McpToolContext,
): Promise<{ diagrams: DiagramSummary[] }> {
  const repository = new DiagramRepository(context.db);
  const diagrams = await repository.listOwned(context.ownerEmail);
  return { diagrams: diagrams.map(toSummary) };
}

/**
 * `get_diagram` tool logic, also reused by the `architect://diagrams/{id}` resource reader
 * (`./server.ts`) -- both need the identical owner-scoped lookup.
 *
 * @param context Resolved MCP tool context.
 * @param diagramId Diagram id supplied by the caller.
 * @returns The full diagram, including its parsed graph.
 * @throws {ProblemDetailsError} `notFound()` when the diagram does not exist or is owned by a
 * different identity -- indistinguishable, matching every existing diagram route's
 * information-disclosure posture.
 */
export async function getDiagramTool(
  context: McpToolContext,
  diagramId: string,
): Promise<{ diagram: Diagram }> {
  const repository = new DiagramRepository(context.db);
  const diagram = await repository.findOwned(diagramId, context.ownerEmail);
  if (diagram === null) {
    throw notFound({ detail: "Diagram not found." });
  }
  return { diagram };
}

/**
 * `create_diagram` tool logic. Reuses `validateCreateDiagramInput()` -- the same title-length,
 * description-length, and `blueprintId` shape checks `POST /api/diagrams` already enforces --
 * so an MCP-created diagram can never bypass limits a browser-created one is held to.
 *
 * @param context Resolved MCP tool context.
 * @param input Raw tool arguments (already zod-typed by the MCP SDK, but re-validated here for
 * the same business-rule limits the REST route enforces).
 * @returns The newly created diagram.
 * @throws {ProblemDetailsError} When `input` fails validation, or `blueprintId` does not match
 * any known blueprint.
 */
export async function createDiagramTool(
  context: McpToolContext,
  input: unknown,
): Promise<Diagram> {
  const validated = validateCreateDiagramInput(input);

  let graphData: string | undefined;
  if (validated.blueprintId !== undefined) {
    const blueprint = BLUEPRINT_MAP.get(validated.blueprintId);
    if (blueprint === undefined) {
      throw notFound({
        detail: `Blueprint "${validated.blueprintId}" not found.`,
      });
    }
    graphData = blueprint.graphData;
  }

  const repository = new DiagramRepository(context.db);
  const diagram = await repository.create(context.ownerEmail, {
    ...validated,
    graphData,
  });
  context.logger.info("diagram_created", { diagramId: diagram.id, via: "mcp" });
  return diagram;
}

/**
 * `rename_diagram` tool logic. Reuses `validateUpdateDiagramInput()` exactly like
 * `PATCH /api/diagrams/:id`.
 *
 * @param context Resolved MCP tool context.
 * @param diagramId Diagram id to update.
 * @param input Raw tool arguments (`title`/`description`).
 * @returns The updated diagram.
 * @throws {ProblemDetailsError} `notFound()` when the diagram does not exist or is owned by a
 * different identity; a validation error when `input` carries neither field.
 */
export async function renameDiagramTool(
  context: McpToolContext,
  diagramId: string,
  input: unknown,
): Promise<Diagram> {
  const validated = validateUpdateDiagramInput(input);
  const repository = new DiagramRepository(context.db);
  const diagram = await repository.updateMetadata(
    diagramId,
    context.ownerEmail,
    validated,
  );
  if (diagram === null) {
    throw notFound({ detail: "Diagram not found." });
  }
  context.logger.info("diagram_updated", {
    diagramId,
    kind: "metadata",
    via: "mcp",
  });
  return diagram;
}

/**
 * `delete_diagram` tool logic. Cascades share-link revocation exactly like
 * `DELETE /api/diagrams/:id` -- a deleted diagram must never keep resolving through a link
 * minted before it was removed.
 *
 * @param context Resolved MCP tool context.
 * @param diagramId Diagram id to delete.
 * @throws {ProblemDetailsError} `notFound()` when the diagram does not exist or is owned by a
 * different identity.
 */
export async function deleteDiagramTool(
  context: McpToolContext,
  diagramId: string,
): Promise<void> {
  const repository = new DiagramRepository(context.db);
  const removed = await repository.remove(diagramId, context.ownerEmail);
  if (!removed) {
    throw notFound({ detail: "Diagram not found." });
  }
  await new ShareRepository(context.db, context.sharesKv).revokeAllForDiagram(
    diagramId,
  );
}

/**
 * The shared pipeline every graph-mutating MCP tool follows (docs/09B-ARCHITECT-MCP.md's Shared
 * Graph Mutation Service): `findOwned()` the diagram, apply one pure mutation function
 * (`../diagrams/graph-mutations.ts`) to its parsed graph, re-canonicalize
 * (`../diagrams/validation.ts`'s `canonicalizeGraphData()`), persist, log, and push the fresh
 * graph to every open live-sync WebSocket for this diagram
 * (`../diagram-session/diagram-session.ts`).
 *
 * @param context Resolved MCP tool context.
 * @param diagramId Diagram id to mutate.
 * @param mutate Pure function applying one graph mutation. May throw (for example `notFound()`
 * for an unknown node/edge id) -- that error propagates unchanged, and nothing is persisted.
 * @returns The diagram with its new `graphData` and `updatedAt`.
 * @throws {ProblemDetailsError} `notFound()` when the diagram does not exist or is owned by a
 * different identity, or when `mutate` itself throws one (an unknown node/edge id).
 */
async function applyGraphMutation(
  context: McpToolContext,
  diagramId: string,
  mutate: (graph: GraphData) => GraphData,
): Promise<Diagram> {
  const repository = new DiagramRepository(context.db);
  const diagram = await repository.findOwned(diagramId, context.ownerEmail);
  if (diagram === null) {
    throw notFound({ detail: "Diagram not found." });
  }

  const parsed = JSON.parse(diagram.graphData) as GraphData;
  const mutated = mutate(parsed);
  const canonicalGraphData = canonicalizeGraphData(mutated);

  const updatedAt = await repository.saveGraphData(
    diagramId,
    context.ownerEmail,
    canonicalGraphData,
  );
  if (updatedAt === null) {
    throw notFound({ detail: "Diagram not found." });
  }

  context.logger.info("diagram_updated", {
    diagramId,
    kind: "graph",
    via: "mcp",
  });
  await context
    .getDiagramSession(diagramId)
    .notifyGraphUpdated(canonicalGraphData, updatedAt);

  return { ...diagram, graphData: canonicalGraphData, updatedAt };
}

/**
 * `add_node` tool logic: append a new node to the diagram's graph.
 *
 * @param context Resolved MCP tool context.
 * @param diagramId Diagram id to mutate.
 * @param input Fields for the new node.
 * @returns The diagram with the node appended.
 * @throws {ProblemDetailsError} `notFound()` when the diagram does not exist or is owned by a
 * different identity.
 */
export async function addNodeTool(
  context: McpToolContext,
  diagramId: string,
  input: AddNodeInput,
): Promise<Diagram> {
  return applyGraphMutation(context, diagramId, (graph) =>
    addNode(graph, input),
  );
}

/**
 * `update_node` tool logic: merge a partial patch into an existing node.
 *
 * @param context Resolved MCP tool context.
 * @param diagramId Diagram id to mutate.
 * @param nodeId Id of the node to update.
 * @param patch Fields to merge in.
 * @returns The diagram with the matching node updated.
 * @throws {ProblemDetailsError} `notFound()` when the diagram does not exist or is owned by a
 * different identity, or when `nodeId` does not exist in the diagram's graph.
 */
export async function updateNodeTool(
  context: McpToolContext,
  diagramId: string,
  nodeId: string,
  patch: NodePatch,
): Promise<Diagram> {
  return applyGraphMutation(context, diagramId, (graph) =>
    updateNode(graph, nodeId, patch),
  );
}

/**
 * `remove_node` tool logic: remove a node, cascading removal of every edge touching it.
 *
 * @param context Resolved MCP tool context.
 * @param diagramId Diagram id to mutate.
 * @param nodeId Id of the node to remove.
 * @returns The diagram with the node (and any edges touching it) removed.
 * @throws {ProblemDetailsError} `notFound()` when the diagram does not exist or is owned by a
 * different identity, or when `nodeId` does not exist in the diagram's graph.
 */
export async function removeNodeTool(
  context: McpToolContext,
  diagramId: string,
  nodeId: string,
): Promise<Diagram> {
  return applyGraphMutation(context, diagramId, (graph) =>
    removeNode(graph, nodeId),
  );
}

/**
 * `add_edge` tool logic: connect two existing nodes.
 *
 * @param context Resolved MCP tool context.
 * @param diagramId Diagram id to mutate.
 * @param input Fields for the new edge.
 * @returns The diagram with the edge appended.
 * @throws {ProblemDetailsError} `notFound()` when the diagram does not exist or is owned by a
 * different identity, or when `input.source`/`input.target` does not reference an existing node.
 */
export async function addEdgeTool(
  context: McpToolContext,
  diagramId: string,
  input: AddEdgeInput,
): Promise<Diagram> {
  return applyGraphMutation(context, diagramId, (graph) =>
    addEdge(graph, input),
  );
}

/**
 * `update_edge` tool logic: merge a partial patch into an existing edge.
 *
 * @param context Resolved MCP tool context.
 * @param diagramId Diagram id to mutate.
 * @param edgeId Id of the edge to update.
 * @param patch Fields to merge in.
 * @returns The diagram with the matching edge updated.
 * @throws {ProblemDetailsError} `notFound()` when the diagram does not exist or is owned by a
 * different identity, or when `edgeId` does not exist in the diagram's graph.
 */
export async function updateEdgeTool(
  context: McpToolContext,
  diagramId: string,
  edgeId: string,
  patch: EdgePatch,
): Promise<Diagram> {
  return applyGraphMutation(context, diagramId, (graph) =>
    updateEdge(graph, edgeId, patch),
  );
}

/**
 * `remove_edge` tool logic: remove an edge.
 *
 * @param context Resolved MCP tool context.
 * @param diagramId Diagram id to mutate.
 * @param edgeId Id of the edge to remove.
 * @returns The diagram with the edge removed.
 * @throws {ProblemDetailsError} `notFound()` when the diagram does not exist or is owned by a
 * different identity, or when `edgeId` does not exist in the diagram's graph.
 */
export async function removeEdgeTool(
  context: McpToolContext,
  diagramId: string,
  edgeId: string,
): Promise<Diagram> {
  return applyGraphMutation(context, diagramId, (graph) =>
    removeEdge(graph, edgeId),
  );
}

/**
 * `auto_layout_diagram` tool logic: rearrange every node onto a deterministic grid
 * (`../diagrams/graph-mutations.ts`'s `autoLayout()` -- not the editor's own `elkjs`-based
 * layout; see that function's JSDoc for why).
 *
 * @param context Resolved MCP tool context.
 * @param diagramId Diagram id to mutate.
 * @returns The diagram with every node repositioned.
 * @throws {ProblemDetailsError} `notFound()` when the diagram does not exist or is owned by a
 * different identity.
 */
export async function autoLayoutDiagramTool(
  context: McpToolContext,
  diagramId: string,
): Promise<Diagram> {
  return applyGraphMutation(context, diagramId, (graph) => autoLayout(graph));
}

/**
 * Result of `create_share_link`, extending {@link CreatedShare} with the ready-to-open `url` --
 * the same shape `POST /api/diagrams/:id/share` already returns, so an MCP-driven caller and a
 * browser caller get an identical payload.
 */
export interface CreateShareLinkResult extends CreatedShare {
  /** Absolute, ready-to-open share URL (`<origin>/s/<token>`). */
  url: string;
}

/**
 * Confirm a diagram is owned by the caller before delegating to `ShareRepository`, exactly like
 * every existing `/api/diagrams/:id/share*` route (`../routes/diagrams.ts`) -- `ShareRepository`
 * itself performs no ownership check of its own, so every share tool below must perform it first.
 *
 * @param context Resolved MCP tool context.
 * @param diagramId Diagram id to confirm ownership of.
 * @throws {ProblemDetailsError} `notFound()` when the diagram does not exist or is owned by a
 * different identity.
 */
async function assertOwnedDiagram(
  context: McpToolContext,
  diagramId: string,
): Promise<void> {
  const repository = new DiagramRepository(context.db);
  if ((await repository.findOwned(diagramId, context.ownerEmail)) === null) {
    throw notFound({ detail: "Diagram not found." });
  }
}

/**
 * `create_share_link` tool logic. Mints (or rotates) a diagram's read-only share link exactly
 * like `POST /api/diagrams/:id/share` -- any share link previously active for this diagram is
 * revoked in the same operation (`../shares/repository.ts`'s `rotate()`), and the returned raw
 * token/url is the only place it is ever available again.
 *
 * @param context Resolved MCP tool context.
 * @param diagramId Diagram id to mint a share link for.
 * @returns The newly minted token, its creation timestamp, and the absolute share URL.
 * @throws {ProblemDetailsError} `notFound()` when the diagram does not exist or is owned by a
 * different identity.
 */
export async function createShareLinkTool(
  context: McpToolContext,
  diagramId: string,
): Promise<CreateShareLinkResult> {
  await assertOwnedDiagram(context, diagramId);

  const shareRepository = new ShareRepository(context.db, context.sharesKv);
  const share = await shareRepository.rotate(diagramId);
  context.logger.info("diagram_shared", { diagramId, via: "mcp" });
  const url = new URL(`/s/${share.token}`, context.requestUrl).toString();
  return { ...share, url };
}

/**
 * `get_share_status` tool logic, exactly like `GET /api/diagrams/:id/share`: whether a read-only
 * link is currently active for this diagram, and when it was created. Never returns the link
 * itself -- see {@link ShareStatus}'s JSDoc for why the server cannot recover a token once minted.
 *
 * @param context Resolved MCP tool context.
 * @param diagramId Diagram id to check.
 * @returns The diagram's current share status.
 * @throws {ProblemDetailsError} `notFound()` when the diagram does not exist or is owned by a
 * different identity.
 */
export async function getShareStatusTool(
  context: McpToolContext,
  diagramId: string,
): Promise<ShareStatus> {
  await assertOwnedDiagram(context, diagramId);
  const shareRepository = new ShareRepository(context.db, context.sharesKv);
  return shareRepository.getStatus(diagramId);
}

/**
 * `revoke_share_link` tool logic, exactly like `DELETE /api/diagrams/:id/share`.
 *
 * @param context Resolved MCP tool context.
 * @param diagramId Diagram id whose active share link should be revoked.
 * @throws {ProblemDetailsError} `notFound()` when the diagram does not exist or is owned by a
 * different identity, or when the diagram has no currently active share link.
 */
export async function revokeShareLinkTool(
  context: McpToolContext,
  diagramId: string,
): Promise<void> {
  await assertOwnedDiagram(context, diagramId);
  const shareRepository = new ShareRepository(context.db, context.sharesKv);
  const revoked = await shareRepository.revokeActive(diagramId);
  if (!revoked) {
    throw notFound({ detail: "No active share link for this diagram." });
  }
  context.logger.info("diagram_share_revoked", { diagramId, via: "mcp" });
}

/** Formats `export_diagram` can return -- see docs/09B-ARCHITECT-MCP.md's Non-Goals for why
 * raster (PNG/SVG) export is deliberately absent from this list. */
export type ExportFormat = "json" | "scaffold";

/** Result of `export_diagram`. */
export interface ExportedDiagram {
  /** Which format was produced. */
  format: ExportFormat;
  /** MIME type of {@link data} -- `"application/json"` for `"json"`, `"application/zip"` for
   * `"scaffold"`. */
  mimeType: string;
  /** For `"json"`: the diagram's canonical `graphData` JSON text, verbatim. For `"scaffold"`:
   * the generated project's ZIP bytes, base64-encoded (an MCP resource content block's `blob`
   * field, per `./server.ts`, expects base64 text, not raw binary). */
  data: string;
}

/**
 * Base64-encode a byte array without `String.fromCharCode(...bytes)`'s call-stack risk on a
 * large array -- a scaffold ZIP is always small, but building the intermediate binary string one
 * byte at a time (mirroring `../shares/repository.ts`'s own `randomToken()` idiom) avoids ever
 * spreading an arbitrarily large array onto the call stack.
 *
 * @param bytes Raw bytes to encode.
 * @returns Standard (not URL-safe) base64 text.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** One graph node as {@link exportDiagramTool} reads it -- every field is opaque and optional
 * from the server's own point of view (`../diagrams/types.ts`'s {@link GraphData} JSDoc); a node
 * missing `data.typeId`/`data.label` simply contributes nothing to the generated scaffold,
 * exactly like `generateScaffold()`'s own "unrecognized node" handling. */
interface ScaffoldSourceNode extends Record<string, unknown> {
  data?: { typeId?: unknown; label?: unknown };
}

/** One graph edge as {@link exportDiagramTool} reads it, symmetric to {@link ScaffoldSourceNode}. */
interface ScaffoldSourceEdge extends Record<string, unknown> {
  source?: unknown;
  target?: unknown;
  data?: { edgeType?: unknown };
}

/**
 * `export_diagram` tool logic. `"json"` returns the diagram's canonical graph verbatim;
 * `"scaffold"` reuses the **exact same** `generateScaffold()`
 * (`../../client/lib/scaffold.ts` -- confirmed DOM-free, a pure data transform, per
 * docs/09B-ARCHITECT-MCP.md's Remote MCP Tool Catalog) the browser's own export toolbar button
 * calls, zipped with `fflate` server-side instead of in the browser. Raster (PNG/SVG) export is
 * deliberately not offered here -- see docs/09B-ARCHITECT-MCP.md's Non-Goals.
 *
 * @param context Resolved MCP tool context.
 * @param diagramId Diagram id to export.
 * @param format `"json"` for the raw graph, `"scaffold"` for a downloadable project ZIP.
 * @returns The exported data and its MIME type.
 * @throws {ProblemDetailsError} `notFound()` when the diagram does not exist or is owned by a
 * different identity.
 */
export async function exportDiagramTool(
  context: McpToolContext,
  diagramId: string,
  format: ExportFormat,
): Promise<ExportedDiagram> {
  const repository = new DiagramRepository(context.db);
  const diagram = await repository.findOwned(diagramId, context.ownerEmail);
  if (diagram === null) {
    throw notFound({ detail: "Diagram not found." });
  }

  if (format === "json") {
    return { data: diagram.graphData, format, mimeType: "application/json" };
  }

  const graph = JSON.parse(diagram.graphData) as GraphData;
  const files = generateScaffold({
    edges: (graph.edges as ScaffoldSourceEdge[]).map((edge) => ({
      edgeType:
        typeof edge.data?.edgeType === "string"
          ? edge.data.edgeType
          : undefined,
      source: typeof edge.source === "string" ? edge.source : "",
      target: typeof edge.target === "string" ? edge.target : "",
    })),
    nodes: (graph.nodes as ScaffoldSourceNode[]).map((node) => ({
      label: typeof node.data?.label === "string" ? node.data.label : "",
      typeId: typeof node.data?.typeId === "string" ? node.data.typeId : "",
    })),
    title: diagram.title,
  });

  const zipData: Record<string, Uint8Array> = {};
  for (const [path, content] of files) {
    zipData[path] = strToU8(content);
  }
  const zipped = zipSync(zipData);

  return { data: toBase64(zipped), format, mimeType: "application/zip" };
}
