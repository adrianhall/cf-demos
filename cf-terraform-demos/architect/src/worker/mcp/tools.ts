import type { Logger } from '@adrianhall/cloudflare-toolkit/logging';
import type { DiagramService } from '../application/diagram-service.ts';
import type { Diagram } from '../domain/diagram.ts';
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
 *   has to be right about schemas and descriptions.
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
