import { strToU8, zipSync } from 'fflate';
import type { Logger } from '@adrianhall/cloudflare-toolkit/logging';
import { generateScaffold } from '../../client/lib/scaffold.ts';
import type { DiagramService, GraphMutation } from '../application/diagram-service.ts';
import type { ShareService } from '../application/share-service.ts';
import type { Diagram } from '../domain/diagram.ts';
import {
  addEdge,
  type AddEdgeInput,
  addNode,
  type AddNodeInput,
  autoLayout,
  type EdgePatch,
  type NodePatch,
  removeEdge,
  removeNode,
  updateEdge,
  updateNode
} from '../domain/graph-mutations.ts';
import type { GraphData } from '../domain/graph.ts';
import type { CreatedShare, ShareStatus } from '../domain/share.ts';
import type { LogVia } from '../logging.ts';

/**
 * @file The MCP tool logic, as plain functions over the existing application services. Every
 *   function here is a thin wrapper: it takes the resolved caller context, calls one
 *   {@link DiagramService} method **in process**, and shapes the result for a model to read. There
 *   is no second validation path, no second ownership rule, and no internal HTTP round trip to the
 *   Worker's own API — the service already owns all three, which is precisely why the application
 *   tier was written to take raw untrusted values rather than pre-validated ones. They are
 *   separated from `./server.ts` so the behaviour can be unit-tested against in-memory repository
 *   doubles with no MCP protocol, no Worker runtime and no HTTP involved. `./server.ts` then only
 *   has to be right about schemas and descriptions. The export tools are the one place this file
 *   reaches outside the Worker tier, importing `generateScaffold` from
 *   `src/client/lib/scaffold.ts`. That is deliberate and safe: the generator is a pure data
 *   transform over a list of nodes and edges, with no `document`, no canvas and no React Flow
 *   runtime anywhere in it or in the `src/catalog.ts` module it reads — which is precisely why the
 *   browser's export button and an agent's `export_diagram` call can share one generator and
 *   produce byte-identical projects. PNG and SVG cannot be shared that way, and are therefore
 *   absent; see {@link exportDiagramTool}.
 */

/**
 * Transport recorded on every structured log event these tools emit.
 *
 * Named once rather than spelled at each call site: the whole point of the field is that a log
 * query can separate agent-driven changes from browser-driven ones, and a query filtering on `via`
 * fails silently the first time one tool emits a different spelling.
 */
const VIA: LogVia = 'mcp';

/**
 * Everything one `/mcp` request's tool handlers need, resolved once per request.
 *
 * Narrow by design. A tool is handed a service and an already-verified identity, never a
 * repository, a binding or a request — so a tool cannot reach storage without passing through the
 * ownership rule, and cannot derive an actor from anything a caller sent.
 */
export interface McpToolContext {
  /**
   * The verified Cloudflare Access identity's email address, read from the validated JWT by the
   * Hono middleware before the handler ran.
   *
   * Every read and write below is scoped to it. It is never taken from a tool argument: an argument
   * is attacker-controlled input, and a model can be talked into supplying one.
   */
  actorEmail: string;
  /**
   * Owner-scoped diagram use cases — the same instance the HTTP routes were given by the
   * composition root, carrying the same validation and the same uniform `404`.
   */
  diagrams: DiagramService;
  /**
   * Sharing use cases — again the very instance `/api/diagrams/:id/share` was given, so an agent
   * minting a link goes through the same rotation, the same digest-only storage and the same
   * ownership refusal a browser does.
   */
  shares: ShareService;
  /**
   * Absolute URL of the `/mcp` request being served, used only to resolve the share URL
   * {@link createShareLinkTool} returns against this deployment's own origin.
   *
   * Taken from the request rather than from a binding or a literal for the same reason `POST
   * /api/diagrams/:id/share` resolves it against `context.req.url`: an origin is a property of the
   * request, not of the use case, which is why {@link ShareService.rotate} returns a bare token and
   * leaves the URL to whichever transport is answering.
   */
  requestUrl: string;
  /**
   * Request-scoped structured logger.
   *
   * Narrowed to `info`, the only method any tool calls, so a test double needs one stub method
   * rather than a whole logger.
   */
  logger: Pick<Logger, 'info'>;
}

/**
 * A diagram as `list_diagrams` reports it.
 *
 * Deliberately omits `graphData` and `ownerEmail`. The graph is the single largest field a diagram
 * has, and listing twenty of them would spend a calling model's context window on content it has
 * not asked to read; `get_diagram` fetches one when it is actually wanted. The owner is omitted
 * because it is always the caller — repeating it would invite a model to treat it as a parameter it
 * could vary.
 */
export interface DiagramSummary {
  /**
   * Server-generated UUID, immutable for the diagram's lifetime.
   */
  id: string;
  /**
   * User-editable title.
   */
  title: string;
  /**
   * Free-text description, or `null` when never set.
   */
  description: string | null;
  /**
   * ISO-8601 timestamp of the most recent metadata or graph update.
   */
  updatedAt: string;
  /**
   * ISO-8601 creation timestamp.
   */
  createdAt: string;
}

/**
 * Projects a full diagram down to the summary shape.
 *
 * @param diagram Diagram as the application tier returns it.
 * @returns The summary, without the graph or the owner.
 */
function toSummary(diagram: Diagram): DiagramSummary {
  return {
    createdAt: diagram.createdAt,
    description: diagram.description,
    id: diagram.id,
    title: diagram.title,
    updatedAt: diagram.updatedAt
  };
}

/**
 * Lists every diagram the caller owns, most recently updated first.
 *
 * @param context Resolved tool context carrying the verified identity and the diagram service.
 * @returns That identity's diagrams as lightweight summaries. An identity with none gets an empty
 *   array, which is a successful answer rather than an error.
 * @throws {Error} When the repository cannot read the rows.
 */
export async function listDiagramsTool(
  context: McpToolContext
): Promise<{ diagrams: DiagramSummary[] }> {
  const diagrams = await context.diagrams.list(context.actorEmail);

  return { diagrams: diagrams.map(toSummary) };
}

/**
 * Reads one diagram the caller owns, including its full graph.
 *
 * Shared with the `architect://diagrams/{id}` resource reader in `./server.ts`, because a resource
 * read and a tool call must resolve to the identical owner-scoped lookup. Two spellings of it would
 * be two chances for one to drift open.
 *
 * @param context Resolved tool context carrying the verified identity and the diagram service.
 * @param diagramId Untrusted diagram id supplied by the caller.
 * @returns The diagram, graph included.
 * @throws {ProblemDetailsError} `notFound()` (404) when the id is malformed, when no diagram has
 *   it, or when the diagram belongs to another identity — all three reported identically, so a
 *   caller cannot use the tool to confirm that a guessed id is real.
 * @throws {Error} When the repository cannot read the row.
 */
export async function getDiagramTool(
  context: McpToolContext,
  diagramId: string
): Promise<{ diagram: Diagram }> {
  const diagram = await context.diagrams.get(context.actorEmail, diagramId);

  context.logger.info('diagram_opened', { diagramId: diagram.id, via: VIA });
  return { diagram };
}

/**
 * Creates a diagram owned by the caller, blank or seeded from a blueprint.
 *
 * The raw tool arguments are handed to the service rather than pre-shaped here, so an MCP-created
 * diagram is held to exactly the title-length, description-length and blueprint rules `POST
 * /api/diagrams` enforces. The MCP SDK has already checked the arguments against the Zod schema in
 * `./server.ts`, but that schema describes the protocol surface; the business rules are the
 * domain's, and only one place states them.
 *
 * @param context Resolved tool context carrying the verified identity and the diagram service.
 * @param input Tool arguments: an optional `title`, `description` and `blueprintId`.
 * @returns The newly created diagram.
 * @throws {ProblemDetailsError} `badRequest()` (400) or `unprocessableContent()` (422) when a field
 *   is invalid, and `notFound()` (404) when `blueprintId` names a template that does not exist.
 * @throws {Error} When the repository cannot write the row.
 */
export async function createDiagramTool(context: McpToolContext, input: unknown): Promise<Diagram> {
  const diagram = await context.diagrams.create(context.actorEmail, input);

  // The id and the transport, never the title or the graph: a log line correlates a request, it
  // is not a copy of the user's content.
  context.logger.info('diagram_created', { diagramId: diagram.id, via: VIA });
  return diagram;
}

/**
 * Renames one of the caller's own diagrams and/or changes its description.
 *
 * @param context Resolved tool context carrying the verified identity and the diagram service.
 * @param diagramId Untrusted diagram id supplied by the caller.
 * @param input Tool arguments: `title` and/or `description`. An explicit `null` description clears
 *   it; an omitted one leaves the stored value alone.
 * @returns The updated diagram.
 * @throws {ProblemDetailsError} `unprocessableContent()` (422) when a field is invalid or the
 *   arguments carry neither field, and `notFound()` (404) when the diagram is malformed, unknown or
 *   owned by another identity.
 * @throws {Error} When the repository cannot read or write the row.
 */
export async function renameDiagramTool(
  context: McpToolContext,
  diagramId: string,
  input: unknown
): Promise<Diagram> {
  const diagram = await context.diagrams.updateMetadata(context.actorEmail, diagramId, input);

  context.logger.info('diagram_updated', { diagramId: diagram.id, kind: 'metadata', via: VIA });
  return diagram;
}

/**
 * Deletes one of the caller's own diagrams, and with it every share link pointing at it.
 *
 * The share cascade is not repeated here. It belongs to the delete use case in
 * `../application/diagram-service.ts`, which is why an agent's delete leaves exactly the state an
 * owner's own delete leaves — there is only one delete.
 *
 * @param context Resolved tool context carrying the verified identity and the diagram service.
 * @param diagramId Untrusted diagram id supplied by the caller.
 * @returns A promise fulfilled once the diagram no longer exists and no link to it resolves.
 * @throws {ProblemDetailsError} `notFound()` (404) when the diagram is malformed, unknown or owned
 *   by another identity.
 * @throws {Error} When the repository cannot read, delete or revoke a row.
 */
export async function deleteDiagramTool(context: McpToolContext, diagramId: string): Promise<void> {
  await context.diagrams.remove(context.actorEmail, diagramId);

  context.logger.info('diagram_deleted', { diagramId, via: VIA });
}

/**
 * Applies one graph mutation to an owned diagram and pushes the result to every open editor.
 *
 * Every graph-mutating tool below is one line over this function, which is the point: load, mutate,
 * re-canonicalise, save and notify happen in exactly one place (`DiagramService.mutateGraph`), so a
 * tool added later cannot accidentally skip the validation, or the ownership check, or the push. A
 * tool that needed its own version of this sequence would be a second chance to get the ordering
 * wrong.
 *
 * @param context Resolved tool context carrying the verified identity and the diagram service.
 * @param diagramId Untrusted diagram id supplied by the caller.
 * @param mutate The single pure mutation to apply.
 * @param kind Short label recorded on the structured log event, so an operator reading Workers Logs
 *   can see which granular operation an agent performed without a second event name per tool.
 * @returns The diagram as it now stands, graph included.
 * @throws {ProblemDetailsError} `notFound()` (404) when the diagram is malformed, unknown or owned
 *   by another identity, or when the mutation's target node or edge does not exist; and
 *   `badRequest()` (400) when it supplies an id already taken.
 * @throws {Error} When the repository cannot read or write the row, or the live session cannot be
 *   notified.
 */
async function applyGraphMutation(
  context: McpToolContext,
  diagramId: string,
  mutate: GraphMutation,
  kind: string
): Promise<Diagram> {
  const diagram = await context.diagrams.mutateGraph(context.actorEmail, diagramId, mutate);

  // The same `diagram_updated` event the browser's own autosave emits, distinguished only by
  // `via`. One event name for one thing that happened, whoever did it — see `../logging.ts`.
  context.logger.info('diagram_updated', { diagramId: diagram.id, kind, via: VIA });
  return diagram;
}

/**
 * Adds a service node to one of the caller's own diagrams.
 *
 * @param context Resolved tool context carrying the verified identity and the diagram service.
 * @param diagramId Untrusted diagram id supplied by the caller.
 * @param input Fields for the new node, including an optional caller-chosen id so a following
 *   `add_edge` can reference it without reading the graph back.
 * @returns The diagram with the node appended.
 * @throws {ProblemDetailsError} `notFound()` (404) when the diagram is absent or foreign, and
 *   `badRequest()` (400) when the chosen node id is already in use.
 * @throws {Error} When the repository cannot write or the session cannot be notified.
 */
export async function addNodeTool(
  context: McpToolContext,
  diagramId: string,
  input: AddNodeInput
): Promise<Diagram> {
  return applyGraphMutation(context, diagramId, (graph) => addNode(graph, input), 'add_node');
}

/**
 * Changes one node's label, description and/or position on an owned diagram.
 *
 * @param context Resolved tool context carrying the verified identity and the diagram service.
 * @param diagramId Untrusted diagram id supplied by the caller.
 * @param nodeId Id of the node to change.
 * @param patch Fields to merge; an omitted field is left unchanged.
 * @returns The diagram with the node updated.
 * @throws {ProblemDetailsError} `notFound()` (404) when the diagram is absent or foreign, or when
 *   the diagram has no node with that id.
 * @throws {Error} When the repository cannot write or the session cannot be notified.
 */
export async function updateNodeTool(
  context: McpToolContext,
  diagramId: string,
  nodeId: string,
  patch: NodePatch
): Promise<Diagram> {
  return applyGraphMutation(
    context,
    diagramId,
    (graph) => updateNode(graph, nodeId, patch),
    'update_node'
  );
}

/**
 * Removes a node from an owned diagram, along with every edge connected to it.
 *
 * The cascade belongs to the domain (`../domain/graph-mutations.ts`) rather than being restated
 * here, so an agent's removal leaves exactly the graph any other caller's removal would.
 *
 * @param context Resolved tool context carrying the verified identity and the diagram service.
 * @param diagramId Untrusted diagram id supplied by the caller.
 * @param nodeId Id of the node to remove.
 * @returns The diagram without that node or any edge touching it.
 * @throws {ProblemDetailsError} `notFound()` (404) when the diagram is absent or foreign, or when
 *   the diagram has no node with that id.
 * @throws {Error} When the repository cannot write or the session cannot be notified.
 */
export async function removeNodeTool(
  context: McpToolContext,
  diagramId: string,
  nodeId: string
): Promise<Diagram> {
  return applyGraphMutation(
    context,
    diagramId,
    (graph) => removeNode(graph, nodeId),
    'remove_node'
  );
}

/**
 * Connects two existing nodes on an owned diagram.
 *
 * @param context Resolved tool context carrying the verified identity and the diagram service.
 * @param diagramId Untrusted diagram id supplied by the caller.
 * @param input Fields for the new edge, including both endpoint node ids.
 * @returns The diagram with the edge appended.
 * @throws {ProblemDetailsError} `notFound()` (404) when the diagram is absent or foreign, or when
 *   either endpoint names no node in the graph; and `badRequest()` (400) when the chosen edge id is
 *   already in use.
 * @throws {Error} When the repository cannot write or the session cannot be notified.
 */
export async function addEdgeTool(
  context: McpToolContext,
  diagramId: string,
  input: AddEdgeInput
): Promise<Diagram> {
  return applyGraphMutation(context, diagramId, (graph) => addEdge(graph, input), 'add_edge');
}

/**
 * Changes one edge's type, label, description and/or protocol on an owned diagram.
 *
 * @param context Resolved tool context carrying the verified identity and the diagram service.
 * @param diagramId Untrusted diagram id supplied by the caller.
 * @param edgeId Id of the edge to change.
 * @param patch Fields to merge; an omitted field is left unchanged.
 * @returns The diagram with the edge updated.
 * @throws {ProblemDetailsError} `notFound()` (404) when the diagram is absent or foreign, or when
 *   the diagram has no edge with that id.
 * @throws {Error} When the repository cannot write or the session cannot be notified.
 */
export async function updateEdgeTool(
  context: McpToolContext,
  diagramId: string,
  edgeId: string,
  patch: EdgePatch
): Promise<Diagram> {
  return applyGraphMutation(
    context,
    diagramId,
    (graph) => updateEdge(graph, edgeId, patch),
    'update_edge'
  );
}

/**
 * Removes one edge from an owned diagram, leaving both of its nodes in place.
 *
 * @param context Resolved tool context carrying the verified identity and the diagram service.
 * @param diagramId Untrusted diagram id supplied by the caller.
 * @param edgeId Id of the edge to remove.
 * @returns The diagram without that edge.
 * @throws {ProblemDetailsError} `notFound()` (404) when the diagram is absent or foreign, or when
 *   the diagram has no edge with that id.
 * @throws {Error} When the repository cannot write or the session cannot be notified.
 */
export async function removeEdgeTool(
  context: McpToolContext,
  diagramId: string,
  edgeId: string
): Promise<Diagram> {
  return applyGraphMutation(
    context,
    diagramId,
    (graph) => removeEdge(graph, edgeId),
    'remove_edge'
  );
}

/**
 * Rearranges every node on an owned diagram onto a deterministic grid.
 *
 * It goes through the same single mutation path as every tool above, rather than being treated as a
 * whole-graph replacement, because it is exactly that: one function of the current graph. The
 * layout it produces is deliberately simpler than the editor's own ELK-based button — see
 * `autoLayout` in `../domain/graph-mutations.ts`, and the tool description in `./server.ts`, which
 * says so to the calling model.
 *
 * @param context Resolved tool context carrying the verified identity and the diagram service.
 * @param diagramId Untrusted diagram id supplied by the caller.
 * @returns The diagram with every node repositioned; edges and viewport unchanged.
 * @throws {ProblemDetailsError} `notFound()` (404) when the diagram is absent or foreign.
 * @throws {Error} When the repository cannot write or the session cannot be notified.
 */
export async function autoLayoutDiagramTool(
  context: McpToolContext,
  diagramId: string
): Promise<Diagram> {
  return applyGraphMutation(context, diagramId, autoLayout, 'auto_layout');
}

/**
 * What `create_share_link` returns: the minted token plus the URL assembled from it.
 *
 * The same shape `POST /api/diagrams/:id/share` already answers with, so an agent and a browser
 * receive an identical payload for an identical operation. It extends {@link CreatedShare} rather
 * than redeclaring its fields, because the domain type is where the "this is the only type carrying
 * a raw token" rule is written and a parallel declaration would quietly escape it.
 */
export interface CreateShareLinkResult extends CreatedShare {
  /**
   * Absolute, ready-to-open share URL — `<origin>/s/<token>`.
   *
   * Contains the raw token by construction, which is why this object is disclosed exactly once and
   * never logged: see {@link createShareLinkTool}.
   */
  url: string;
}

/**
 * Mints a read-only share link for one of the caller's own diagrams, replacing any active link.
 *
 * **This result is the only moment the raw token exists outside the caller's own memory.** Only its
 * SHA-256 digest is persisted (`../domain/share-token.ts`), so the server genuinely cannot
 * reproduce the link afterwards — {@link getShareStatusTool} reports that a link is active and
 * when, and nothing more. An owner who loses the link mints a new one, which revokes this one. The
 * log line below carries the diagram id and the transport and deliberately nothing else: a log is
 * shipped to an observability backend, retained, and read by people who have no business holding a
 * live bearer credential.
 *
 * @param context Resolved tool context carrying the verified identity, the share service and the
 *   request URL the returned link is resolved against.
 * @param diagramId Untrusted diagram id supplied by the caller.
 * @returns The new token, its creation timestamp and the absolute share URL.
 * @throws {ProblemDetailsError} `notFound()` (404) when the diagram is malformed, unknown or owned
 *   by another identity — refused before anything is minted, so guessing ids cannot create shares.
 * @throws {Error} When the repository cannot read or write the rows.
 */
export async function createShareLinkTool(
  context: McpToolContext,
  diagramId: string
): Promise<CreateShareLinkResult> {
  const share = await context.shares.rotate(context.actorEmail, diagramId);

  context.logger.info('diagram_shared', { diagramId, via: VIA });

  return { ...share, url: new URL(`/s/${share.token}`, context.requestUrl).toString() };
}

/**
 * Reports whether one of the caller's own diagrams currently has an active share link.
 *
 * Never returns the link, and cannot: see {@link createShareLinkTool}. Nothing is logged here
 * either, because the only value that would distinguish one status read from another is the one
 * value that must never be written down.
 *
 * @param context Resolved tool context carrying the verified identity and the share service.
 * @param diagramId Untrusted diagram id supplied by the caller.
 * @returns Whether a link is active, and when it was created.
 * @throws {ProblemDetailsError} `notFound()` (404) when the diagram is malformed, unknown or owned
 *   by another identity.
 * @throws {Error} When the repository cannot read the rows.
 */
export async function getShareStatusTool(
  context: McpToolContext,
  diagramId: string
): Promise<ShareStatus> {
  return context.shares.getStatus(context.actorEmail, diagramId);
}

/**
 * Revokes the active share link on one of the caller's own diagrams.
 *
 * A diagram with no active link is refused rather than succeeding quietly, exactly as `DELETE
 * /api/diagrams/:id/share` refuses it: the caller asked about a link that is not there.
 *
 * @param context Resolved tool context carrying the verified identity and the share service.
 * @param diagramId Untrusted diagram id supplied by the caller.
 * @returns A promise fulfilled once the link no longer resolves.
 * @throws {ProblemDetailsError} `notFound()` (404) when the diagram is malformed, unknown or owned
 *   by another identity, or when it has no active link.
 * @throws {Error} When the repository cannot read or write the rows.
 */
export async function revokeShareLinkTool(
  context: McpToolContext,
  diagramId: string
): Promise<void> {
  await context.shares.revoke(context.actorEmail, diagramId);

  context.logger.info('diagram_share_revoked', { diagramId, via: VIA });
}

/**
 * The formats `export_diagram` can produce.
 *
 * Both are pure data transforms, which is the whole reason this list has two entries rather than
 * four. PNG and SVG are deliberately absent: the editor produces them by rasterising the live React
 * Flow canvas with `html-to-image` (`../../client/components/editor/toolbar/ExportButton.tsx`), and
 * a Worker has no DOM, no fonts and no computed styles to reproduce. There is no server-side
 * browser rendering in this demo, so offering them here would mean promising a capability that does
 * not exist. {@link exportDiagramTool}'s own tool description says so to the calling model.
 */
export type ExportFormat = 'json' | 'scaffold';

/**
 * What {@link exportDiagramTool} returns.
 */
export interface ExportedDiagram {
  /**
   * Which format was produced, echoed back so a caller branching on it cannot misread the payload.
   */
  format: ExportFormat;
  /**
   * MIME type of {@link ExportedDiagram.data}: `application/json` or `application/zip`.
   */
  mimeType: string;
  /**
   * For `json`, the diagram's canonical `graphData` text verbatim. For `scaffold`, the generated
   * project's ZIP bytes as base64 — an MCP resource content block's `blob` field is defined as
   * base64 text, not raw binary, so the encoding belongs here rather than at the protocol edge.
   */
  data: string;
}

/**
 * Base64-encodes bytes without spreading the array onto the call stack.
 *
 * `btoa(String.fromCharCode(...bytes))` is the shorter spelling and the wrong one: spreading an
 * array into a call's arguments is bounded by the engine's argument limit, so it works for every
 * scaffold anyone will generate and then throws `RangeError` for the one that is unusually large.
 * Accumulating byte by byte has no such ceiling.
 *
 * @param bytes Raw bytes to encode.
 * @returns Standard, non-URL-safe base64 text.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * One graph node as {@link exportDiagramTool} reads it.
 *
 * Every field is optional and typed as `unknown`, because the Worker genuinely does not know a
 * node's shape — `../domain/graph.ts` validates only that each element is an object with a
 * non-empty string `id`, so that the client can add a field without a server deploy. A node missing
 * `data.typeId` or `data.label` therefore contributes nothing to the generated project, which is
 * exactly what `generateScaffold` already does with a type it does not recognise.
 */
interface ScaffoldSourceNode extends Record<string, unknown> {
  /**
   * React Flow's per-node payload, carrying the catalogue type and the label when present.
   */
  data?: { typeId?: unknown; label?: unknown };
}

/**
 * One graph edge as {@link exportDiagramTool} reads it, symmetric to {@link ScaffoldSourceNode}.
 */
interface ScaffoldSourceEdge extends Record<string, unknown> {
  /**
   * Id of the node the edge leaves.
   */
  source?: unknown;
  /**
   * Id of the node the edge reaches.
   */
  target?: unknown;
  /**
   * React Flow's per-edge payload, carrying the catalogue edge type when present.
   */
  data?: { edgeType?: unknown };
}

/**
 * Exports one of the caller's own diagrams as graph JSON or as a starter-project archive.
 *
 * `scaffold` calls the **same** `generateScaffold` the editor's own export button calls
 * (`../../client/lib/scaffold.ts`), zipped with `fflate` here instead of in the browser, so the two
 * surfaces hand a reader byte-identical projects rather than two implementations that agree today.
 * The generator is a pure data transform with no DOM dependency, which is what makes sharing it
 * possible at all.
 *
 * **PNG and SVG are deliberately not offered.** They are rasterisations of the live canvas, and
 * this demo has no server-side browser rendering; the tool description in `./server.ts` states that
 * plainly so a calling model does not promise a user an image it cannot produce.
 *
 * Nothing is logged. An export reads a diagram without changing it, and the only field that would
 * distinguish one export from another is the content itself.
 *
 * @param context Resolved tool context carrying the verified identity and the diagram service.
 * @param diagramId Untrusted diagram id supplied by the caller.
 * @param format `json` for the canonical graph, `scaffold` for a base64 project archive.
 * @returns The exported bytes and the MIME type describing them. A diagram with neither a Worker
 *   nor a bindable service produces an empty archive, because `generateScaffold` declines to invent
 *   a project out of external actors; the caller is told so by the tool description rather than by
 *   an error, since an empty canvas is not a failure.
 * @throws {ProblemDetailsError} `notFound()` (404) when the diagram is malformed, unknown or owned
 *   by another identity.
 * @throws {Error} When the repository cannot read the row.
 */
export async function exportDiagramTool(
  context: McpToolContext,
  diagramId: string,
  format: ExportFormat
): Promise<ExportedDiagram> {
  const diagram = await context.diagrams.get(context.actorEmail, diagramId);

  if (format === 'json') {
    // Verbatim, not re-serialised. The stored text is already canonical, so re-encoding it would
    // mean the bytes an agent receives were never the bytes the application stored.
    return { data: diagram.graphData, format, mimeType: 'application/json' };
  }

  // Parsed rather than defensively re-validated: every write path canonicalises before storing,
  // so treating the stored graph as suspect here would assert the application's own invariant
  // does not hold.
  const graph = JSON.parse(diagram.graphData) as GraphData;
  const files = generateScaffold({
    edges: (graph.edges as ScaffoldSourceEdge[]).map((edge) => ({
      edgeType: typeof edge.data?.edgeType === 'string' ? edge.data.edgeType : undefined,
      source: typeof edge.source === 'string' ? edge.source : '',
      target: typeof edge.target === 'string' ? edge.target : ''
    })),
    nodes: (graph.nodes as ScaffoldSourceNode[]).map((node) => ({
      label: typeof node.data?.label === 'string' ? node.data.label : '',
      typeId: typeof node.data?.typeId === 'string' ? node.data.typeId : ''
    })),
    title: diagram.title
  });

  const archive: Record<string, Uint8Array> = {};
  for (const [path, contents] of files) {
    archive[path] = strToU8(contents);
  }

  return { data: toBase64(zipSync(archive)), format, mimeType: 'application/zip' };
}
