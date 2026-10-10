import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  addEdgeTool,
  addNodeTool,
  autoLayoutDiagramTool,
  createDiagramTool,
  createShareLinkTool,
  deleteDiagramTool,
  exportDiagramTool,
  getDiagramTool,
  getShareStatusTool,
  listDiagramsTool,
  type McpToolContext,
  removeEdgeTool,
  removeNodeTool,
  renameDiagramTool,
  revokeShareLinkTool,
  updateEdgeTool,
  updateNodeTool,
} from "./tools";

/** Catalog edge types accepted by `add_edge`/`update_edge` (`../../catalog.ts`'s `EDGE_TYPES`). */
const EDGE_TYPES = [
  "data-flow",
  "service-binding",
  "trigger",
  "external",
] as const;

/** Shared zod shape for a canvas position, reused by `add_node` and `update_node`. */
const positionSchema = z.object({
  x: z.number().describe("Canvas x position."),
  y: z.number().describe("Canvas y position."),
});

/**
 * Build a fresh MCP server for one `/mcp` request, its tools closing over the caller's already-
 * verified Cloudflare Access identity (`context.ownerEmail`) rather than the MCP SDK's own
 * `getMcpAuthContext()`/`AuthInfo` plumbing (docs/09B-ARCHITECT-MCP.md's Access Model: "Every MCP
 * tool handler derives the caller's identity from ... the Hono context exactly like every
 * existing ... handler"). `../index.ts`'s `/mcp` route constructs a new `createMcpHandler(...)`
 * per request specifically so this closure is scoped to that one request's identity -- the
 * alternative, a module-scope singleton handler with a static `authContext` option, would freeze
 * the *first* caller's identity into every subsequent request that reuses the same handler
 * instance, a genuine cross-tenant data leak this demo cannot risk for a live teaching moment.
 *
 * Every tool is a thin wrapper: parse already-zod-validated arguments, call the matching
 * `./tools.ts` function (itself a thin wrapper over `DiagramRepository`/`ShareRepository`), and
 * report a `notFound()` (or other `ProblemDetailsError`) thrown from that function as the tool's
 * own `isError` result -- the MCP SDK's `tools/call` handler already converts any thrown error's
 * `.message` into `{ content: [{ type: "text", text }], isError: true }` automatically, so no
 * handler here needs its own try/catch.
 *
 * @param context Resolved MCP tool context for this one request.
 * @returns A `McpServer` instance ready to `connect()` to a transport (handled by
 * `createMcpHandler` -- this factory is passed to it, never called directly).
 */
export function createServer(context: McpToolContext): McpServer {
  const server = new McpServer({
    name: "architect-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "list_diagrams",
    {
      description:
        "List every diagram owned by the authenticated caller, most recently updated first. Only ever lists diagrams owned by the authenticated caller.",
    },
    async () => {
      const { diagrams } = await listDiagramsTool(context);
      return { content: [{ type: "text", text: JSON.stringify(diagrams) }] };
    },
  );

  server.registerTool(
    "get_diagram",
    {
      description:
        "Load one diagram's full metadata and graph (nodes, edges, viewport). Only ever reads a diagram owned by the authenticated caller; a diagram id owned by someone else is reported identically to one that does not exist.",
      inputSchema: z.object({
        diagramId: z.string().describe("The diagram's id."),
      }),
    },
    async ({ diagramId }) => {
      const { diagram } = await getDiagramTool(context, diagramId);
      return { content: [{ type: "text", text: JSON.stringify(diagram) }] };
    },
  );

  // Exposed as a resource too (per MCP's tools-vs-resources guidance) so a client can attach a
  // diagram as read-only context without an explicit tool call. `list: undefined` is required by
  // `ResourceTemplate`'s constructor even when unused -- this template is only ever read by exact
  // URI, never enumerated via `resources/list`.
  server.registerResource(
    "diagram",
    new ResourceTemplate("architect://diagrams/{id}", { list: undefined }),
    {
      title: "Diagram",
      description:
        "A diagram's full metadata and graph, owned by the authenticated caller.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      // `{id}` (no explode modifier) never yields an array match -- `Variables`'s
      // `string | string[]` type is a template-shape-agnostic union the SDK uses for every
      // possible URI template, not a real possibility for this specific single-value one.
      const { diagram } = await getDiagramTool(context, variables.id as string);
      return {
        contents: [
          {
            mimeType: "application/json",
            text: JSON.stringify(diagram),
            uri: uri.href,
          },
        ],
      };
    },
  );

  server.registerTool(
    "create_diagram",
    {
      description:
        "Create a new diagram owned by the authenticated caller, optionally seeded from a blueprint template.",
      inputSchema: z.object({
        title: z
          .string()
          .optional()
          .describe(
            'Diagram title. Defaults to "Untitled Diagram" when omitted.',
          ),
        description: z
          .string()
          .nullable()
          .optional()
          .describe("Optional free-text description."),
        blueprintId: z
          .string()
          .optional()
          .describe(
            "Slug of a blueprint template whose graph seeds the new diagram.",
          ),
      }),
    },
    async (input) => {
      const diagram = await createDiagramTool(context, input);
      return { content: [{ type: "text", text: JSON.stringify(diagram) }] };
    },
  );

  server.registerTool(
    "rename_diagram",
    {
      description:
        "Rename a diagram and/or change its description. Only ever updates a diagram owned by the authenticated caller.",
      inputSchema: z.object({
        diagramId: z.string().describe("The diagram's id."),
        title: z.string().optional().describe("New title."),
        description: z
          .string()
          .nullable()
          .optional()
          .describe(
            "New description. null clears it; omitted leaves it unchanged.",
          ),
      }),
    },
    async ({ diagramId, ...input }) => {
      const diagram = await renameDiagramTool(context, diagramId, input);
      return { content: [{ type: "text", text: JSON.stringify(diagram) }] };
    },
  );

  server.registerTool(
    "delete_diagram",
    {
      description:
        "Delete a diagram owned by the authenticated caller, revoking any active share link for it. Only ever deletes a diagram owned by the authenticated caller.",
      inputSchema: z.object({
        diagramId: z.string().describe("The diagram's id."),
      }),
    },
    async ({ diagramId }) => {
      await deleteDiagramTool(context, diagramId);
      return {
        content: [{ type: "text", text: `Diagram ${diagramId} deleted.` }],
      };
    },
  );

  // Every graph-mutating tool below applies through `../diagram-session/diagram-session.ts`'s
  // `DiagramSession` and pushes the fresh graph to any open editor tab live
  // (docs/09C-COLLABORATIVE-EDITING.md's Live-Editing Architecture) -- the demo's central
  // teaching moment. Each is a thin wrapper over `./tools.ts`'s matching function, which itself
  // wraps one operation from `../../graph-mutations.ts`.

  server.registerTool(
    "add_node",
    {
      description:
        "Add a new Cloudflare service node to a diagram's canvas. Only ever mutates a diagram owned by the authenticated caller.",
      inputSchema: z.object({
        diagramId: z.string().describe("The diagram's id."),
        typeId: z
          .string()
          .describe('Catalog product type id (e.g. "worker", "d1", "kv").'),
        label: z.string().describe("Display label shown on the node."),
        description: z
          .string()
          .optional()
          .describe("Optional free-text annotation shown below the label."),
        position: positionSchema.describe("Canvas position for the new node."),
      }),
    },
    async ({ diagramId, ...input }) => {
      const diagram = await addNodeTool(context, diagramId, input);
      return { content: [{ type: "text", text: JSON.stringify(diagram) }] };
    },
  );

  server.registerTool(
    "update_node",
    {
      description:
        "Update an existing node's label, description, and/or position. Only ever mutates a diagram owned by the authenticated caller.",
      inputSchema: z.object({
        diagramId: z.string().describe("The diagram's id."),
        nodeId: z.string().describe("The node's id."),
        label: z.string().optional().describe("New display label."),
        description: z
          .string()
          .optional()
          .describe("New free-text annotation."),
        position: positionSchema.optional().describe("New canvas position."),
      }),
    },
    async ({ diagramId, nodeId, ...patch }) => {
      const diagram = await updateNodeTool(context, diagramId, nodeId, patch);
      return { content: [{ type: "text", text: JSON.stringify(diagram) }] };
    },
  );

  server.registerTool(
    "remove_node",
    {
      description:
        "Remove a node from a diagram, cascading removal of every edge connected to it. Only ever mutates a diagram owned by the authenticated caller.",
      inputSchema: z.object({
        diagramId: z.string().describe("The diagram's id."),
        nodeId: z.string().describe("The node's id."),
      }),
    },
    async ({ diagramId, nodeId }) => {
      const diagram = await removeNodeTool(context, diagramId, nodeId);
      return { content: [{ type: "text", text: JSON.stringify(diagram) }] };
    },
  );

  server.registerTool(
    "add_edge",
    {
      description:
        "Connect two existing nodes on a diagram's canvas with an edge. Only ever mutates a diagram owned by the authenticated caller.",
      inputSchema: z.object({
        diagramId: z.string().describe("The diagram's id."),
        source: z.string().describe("Id of the existing node to connect from."),
        target: z.string().describe("Id of the existing node to connect to."),
        edgeType: z
          .enum(EDGE_TYPES)
          .describe(
            "Visual/semantic edge type controlling stroke style, animation, and arrowheads.",
          ),
        label: z
          .string()
          .optional()
          .describe("Optional label rendered at the edge midpoint."),
        description: z
          .string()
          .optional()
          .describe("Optional tooltip annotation."),
        protocol: z
          .string()
          .optional()
          .describe(
            'Communication protocol hint (e.g. "http", "ws", "binding").',
          ),
      }),
    },
    async ({ diagramId, ...input }) => {
      const diagram = await addEdgeTool(context, diagramId, input);
      return { content: [{ type: "text", text: JSON.stringify(diagram) }] };
    },
  );

  server.registerTool(
    "update_edge",
    {
      description:
        "Update an existing edge's type, label, description, and/or protocol. Only ever mutates a diagram owned by the authenticated caller.",
      inputSchema: z.object({
        diagramId: z.string().describe("The diagram's id."),
        edgeId: z.string().describe("The edge's id."),
        edgeType: z.enum(EDGE_TYPES).optional().describe("New edge type."),
        label: z.string().optional().describe("New label."),
        description: z.string().optional().describe("New tooltip annotation."),
        protocol: z
          .string()
          .optional()
          .describe("New communication protocol hint."),
      }),
    },
    async ({ diagramId, edgeId, ...patch }) => {
      const diagram = await updateEdgeTool(context, diagramId, edgeId, patch);
      return { content: [{ type: "text", text: JSON.stringify(diagram) }] };
    },
  );

  server.registerTool(
    "remove_edge",
    {
      description:
        "Remove an edge from a diagram. Only ever mutates a diagram owned by the authenticated caller.",
      inputSchema: z.object({
        diagramId: z.string().describe("The diagram's id."),
        edgeId: z.string().describe("The edge's id."),
      }),
    },
    async ({ diagramId, edgeId }) => {
      const diagram = await removeEdgeTool(context, diagramId, edgeId);
      return { content: [{ type: "text", text: JSON.stringify(diagram) }] };
    },
  );

  server.registerTool(
    "auto_layout_diagram",
    {
      description:
        "Rearrange every node in a diagram onto a deterministic grid, ordered by a breadth-first traversal from the graph's edges. Produces a simpler grid arrangement than the editor's own auto-layout button (which uses a real layered layout algorithm) -- not the same visual result. Only ever mutates a diagram owned by the authenticated caller.",
      inputSchema: z.object({
        diagramId: z.string().describe("The diagram's id."),
      }),
    },
    async ({ diagramId }) => {
      const diagram = await autoLayoutDiagramTool(context, diagramId);
      return { content: [{ type: "text", text: JSON.stringify(diagram) }] };
    },
  );

  // Sharing and download tools (docs/09B-ARCHITECT-MCP.md's Phase 14) -- every one a thin
  // wrapper over `./tools.ts`'s matching function, which itself wraps `ShareRepository`/
  // `generateScaffold()` exactly like the equivalent `/api/diagrams/:id/share*` REST routes.

  server.registerTool(
    "create_share_link",
    {
      description:
        "Create (or rotate) a diagram's read-only share link. Any share link previously active for this diagram is revoked in the same operation. The returned url and token are the only place the raw link is ever available -- it cannot be recovered later, only revoked. Only ever creates a share link for a diagram owned by the authenticated caller.",
      inputSchema: z.object({
        diagramId: z.string().describe("The diagram's id."),
      }),
    },
    async ({ diagramId }) => {
      const share = await createShareLinkTool(context, diagramId);
      return { content: [{ type: "text", text: JSON.stringify(share) }] };
    },
  );

  server.registerTool(
    "get_share_status",
    {
      description:
        "Check whether a diagram currently has an active read-only share link, and when it was created. Never returns the link itself. Only ever reads the share status of a diagram owned by the authenticated caller.",
      inputSchema: z.object({
        diagramId: z.string().describe("The diagram's id."),
      }),
    },
    async ({ diagramId }) => {
      const status = await getShareStatusTool(context, diagramId);
      return { content: [{ type: "text", text: JSON.stringify(status) }] };
    },
  );

  server.registerTool(
    "revoke_share_link",
    {
      description:
        "Revoke a diagram's currently active read-only share link, if any. Only ever revokes a share link for a diagram owned by the authenticated caller.",
      inputSchema: z.object({
        diagramId: z.string().describe("The diagram's id."),
      }),
    },
    async ({ diagramId }) => {
      await revokeShareLinkTool(context, diagramId);
      return {
        content: [
          {
            type: "text",
            text: `Share link for diagram ${diagramId} revoked.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "export_diagram",
    {
      description:
        'Export a diagram as either its raw graph JSON ("json") or a downloadable Cloudflare project scaffold ZIP ("scaffold", the same generator the editor\'s own export button uses). Raster (PNG/SVG) image export is not available through this tool -- only the browser editor\'s own export button can produce those. A calling harness should save the returned data to a local file itself; there is no server-hosted download URL. Only ever exports a diagram owned by the authenticated caller.',
      inputSchema: z.object({
        diagramId: z.string().describe("The diagram's id."),
        format: z
          .enum(["json", "scaffold"])
          .describe(
            '"json" returns the diagram\'s graph as JSON text. "scaffold" returns a base64-encoded ZIP of a starter Cloudflare project.',
          ),
      }),
    },
    async ({ diagramId, format }) => {
      const exported = await exportDiagramTool(context, diagramId, format);
      if (exported.format === "json") {
        return { content: [{ type: "text", text: exported.data }] };
      }
      return {
        content: [
          {
            resource: {
              blob: exported.data,
              mimeType: exported.mimeType,
              uri: `architect://diagrams/${diagramId}/scaffold.zip`,
            },
            type: "resource",
          },
        ],
      };
    },
  );

  return server;
}
