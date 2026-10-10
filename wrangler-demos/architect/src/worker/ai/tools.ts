import { z } from "zod";
import { EDGE_TYPE_MAP, NODE_TYPE_MAP } from "../../catalog";
import type { GraphOperation } from "../../graph-mutations";
import type { GraphData } from "../diagrams/types";
import { nextGridPosition } from "./catalog-context";

/**
 * The AI chat's own tool catalog (docs/09D-ARCHITECT-AICHAT.md's Chat Loop And Tool Execution --
 * Tool catalog table): six graph-mutating tools mirroring `graph-mutations.ts`'s
 * {@link GraphOperation} vocabulary one-for-one, plus `rename_diagram` (diagram metadata, not
 * part of {@link GraphData}) and `search_cloudflare_documentation` (no diagram effect at all).
 * This module is deliberately pure and dependency-free -- no `DiagramSession`, D1, or WebSocket
 * import anywhere in it -- so it is unit-testable exactly like `../../graph-mutations.ts` itself,
 * per the design doc's Phase 22 definition of done.
 */
export type ToolName =
  | "add_node"
  | "update_node"
  | "remove_node"
  | "add_edge"
  | "update_edge"
  | "remove_edge"
  | "rename_diagram"
  | "search_cloudflare_documentation";

/** Shared zod shape for a canvas position, reused by `add_node` and `update_node` -- matches
 * `../../mcp/tools.ts`'s (9B) own `positionSchema` precedent for this exact field shape. */
const positionSchema = z.object({
  x: z.number().describe("Canvas x position."),
  y: z.number().describe("Canvas y position."),
});

/**
 * Zod input schema for `add_node`. `typeId` is deliberately `z.string()`, not a `z.enum()` of a
 * hardcoded catalog snapshot (unlike 9B's own `edgeType` enum in `../mcp/server.ts`) --
 * {@link dispatchToolCall} validates it against the **live** `NODE_TYPE_MAP` instead, so a
 * hallucinated value is reported back to the calling model as a tool error with the current
 * valid list, per this document's own "an unrecognized value is reported back to the model as a
 * tool error ... not thrown" design, rather than a static enum this module would need to keep
 * hand-synchronized with `../../catalog.ts` on every catalog change.
 */
const addNodeSchema = z.object({
  typeId: z
    .string()
    .min(1)
    .describe(
      'Catalog product type id (e.g. "worker", "d1", "kv"). Must be one of the current catalog\'s node type ids.',
    ),
  label: z.string().min(1).describe("Display label shown on the node."),
  description: z
    .string()
    .optional()
    .describe("Optional free-text annotation shown below the label."),
  position: positionSchema
    .optional()
    .describe(
      "Canvas position for the new node. When omitted, a default staggered-grid position is assigned automatically.",
    ),
});

/**
 * Zod input schema for `update_node`. Patchable fields deliberately mirror
 * `../../graph-mutations.ts`'s real `NodePatch` type exactly -- `label`/`description`/
 * `position` only. `NodePatch` has no `typeId` field (an existing node's product type is not
 * currently patchable through `updateNode()`), so this schema does not accept one either, even
 * though an earlier design-doc draft's tool table listed it.
 */
const updateNodeSchema = z.object({
  nodeId: z.string().min(1).describe("Id of the existing node to update."),
  label: z.string().optional().describe("New display label."),
  description: z.string().optional().describe("New free-text annotation."),
  position: positionSchema.optional().describe("New canvas position."),
});

/** Zod input schema for `remove_node`. */
const removeNodeSchema = z.object({
  nodeId: z
    .string()
    .min(1)
    .describe(
      "Id of the node to remove. Cascades removal of every edge connected to it.",
    ),
});

/**
 * Zod input schema for `add_edge`. `edgeType` is `z.string()`, validated against the live
 * `EDGE_TYPE_MAP` in {@link dispatchToolCall}, for the same reason {@link addNodeSchema}'s
 * `typeId` is.
 */
const addEdgeSchema = z.object({
  source: z
    .string()
    .min(1)
    .describe("Id of the existing node this edge starts from."),
  target: z
    .string()
    .min(1)
    .describe("Id of the existing node this edge ends at."),
  edgeType: z
    .string()
    .min(1)
    .describe(
      'Visual/semantic edge type (e.g. "data-flow", "service-binding"). Must be one of the current catalog\'s edge type ids.',
    ),
  label: z
    .string()
    .optional()
    .describe("Optional label rendered at the edge midpoint."),
  description: z.string().optional().describe("Optional tooltip annotation."),
  protocol: z
    .string()
    .optional()
    .describe('Communication protocol hint (e.g. "http", "ws", "binding").'),
});

/** Zod input schema for `update_edge`, mirroring `../../graph-mutations.ts`'s `EdgePatch`. */
const updateEdgeSchema = z.object({
  edgeId: z.string().min(1).describe("Id of the existing edge to update."),
  edgeType: z
    .string()
    .optional()
    .describe(
      "New edge type. Must be one of the current catalog's edge type ids when provided.",
    ),
  label: z.string().optional().describe("New label."),
  description: z.string().optional().describe("New tooltip annotation."),
  protocol: z.string().optional().describe("New communication protocol hint."),
});

/** Zod input schema for `remove_edge`. */
const removeEdgeSchema = z.object({
  edgeId: z.string().min(1).describe("Id of the edge to remove."),
});

/**
 * Zod input schema for `rename_diagram`. Requires at least one of `title`/`description`,
 * matching `../diagrams/validation.ts`'s `validateUpdateDiagramInput()` business rule for the
 * same reason: a call with neither field is not a meaningful rename.
 */
const renameDiagramSchema = z
  .object({
    title: z.string().min(1).optional().describe("New diagram title."),
    description: z
      .string()
      .nullable()
      .optional()
      .describe(
        "New free-text description. null clears it; omitted leaves it unchanged.",
      ),
  })
  .refine(
    (value) => value.title !== undefined || value.description !== undefined,
    {
      message: "rename_diagram requires title and/or description.",
    },
  );

/** Zod input schema for `search_cloudflare_documentation`. */
const searchCloudflareDocumentationSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Search query for Cloudflare's current product documentation."),
});

/** Every tool's zod schema, keyed by {@link ToolName} -- the single source
 * {@link dispatchToolCall} and {@link TOOL_DEFINITIONS} both read from. */
const TOOL_SCHEMAS = {
  add_edge: addEdgeSchema,
  add_node: addNodeSchema,
  remove_edge: removeEdgeSchema,
  remove_node: removeNodeSchema,
  rename_diagram: renameDiagramSchema,
  search_cloudflare_documentation: searchCloudflareDocumentationSchema,
  update_edge: updateEdgeSchema,
  update_node: updateNodeSchema,
} satisfies Record<ToolName, z.ZodType>;

/** Plain-language scope statement for each tool, matching 9B's own `../mcp/server.ts` tool-
 * description convention of stating a tool's scope plainly in its own words. */
const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  add_edge: "Connect two existing nodes on the diagram's canvas with an edge.",
  add_node: "Add a new Cloudflare service node to the diagram's canvas.",
  remove_edge: "Remove an edge from the diagram.",
  remove_node:
    "Remove a node from the diagram, cascading removal of every edge connected to it.",
  rename_diagram: "Rename the diagram and/or change its description.",
  search_cloudflare_documentation:
    "Search Cloudflare's own current product documentation to ground advice and product choices in up-to-date information. Has no effect on the diagram.",
  update_edge:
    "Update an existing edge's type, label, description, and/or protocol.",
  update_node: "Update an existing node's label, description, and/or position.",
};

/** One tool definition in the JSON-Schema-shaped form Workers AI's `env.AI.run()` `tools`
 * parameter expects (`{ name, description, parameters }`, confirmed against
 * https://developers.cloudflare.com/workers-ai/function-calling/'s own worked example). */
export interface ToolDefinition {
  /** Tool name, exactly as the model must name it in a `tool_calls[]` entry. */
  name: ToolName;
  /** Plain-language description of the tool's effect and scope. */
  description: string;
  /** JSON Schema object describing the tool's accepted arguments. */
  parameters: Record<string, unknown>;
}

/**
 * Convert one tool's zod schema to the plain JSON Schema object Workers AI's `tools[].parameters`
 * expects, stripping the two fields `z.toJSONSchema()` (zod v4's own schema-to-JSON-Schema
 * converter -- confirmed present and working on the pinned `zod@4.4.3`) adds that Workers AI's
 * own worked example does not include: the top-level `$schema` declaration, and
 * `additionalProperties: false` (harmless either way, but omitted here to match the shape of
 * Cloudflare's own example as closely as possible rather than adding a field this module cannot
 * confirm every current tool-calling model tolerates).
 *
 * @param schema A tool's zod input schema.
 * @returns A plain JSON Schema object suitable for `ToolDefinition.parameters`.
 */
function toParameters(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  const { $schema, additionalProperties, ...rest } = jsonSchema;
  return rest;
}

/**
 * Every tool this document's AI chat exposes, in the shape `env.AI.run()`'s `tools` option
 * expects. Computed once at module load -- these are static JSON Schema descriptions of the
 * tools' own argument shapes, not a function of the diagram's current state, so there is nothing
 * to recompute per request (unlike `catalog-context.ts`'s `buildCatalogPromptContext()`, which
 * intentionally is recomputed every time because catalog *entries* -- as opposed to this fixed
 * tool vocabulary -- can change).
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = (
  Object.keys(TOOL_SCHEMAS) as ToolName[]
).map((name) => ({
  description: TOOL_DESCRIPTIONS[name],
  name,
  parameters: toParameters(TOOL_SCHEMAS[name]),
}));

/**
 * Result of {@link dispatchToolCall} -- a clean discriminated union so `chat-engine.ts` (Phase 23)
 * can pattern-match on `kind` without needing to know anything about zod or this module's
 * validation internals.
 */
export type ToolDispatchResult =
  | {
      /** A graph-mutating tool call, already validated and translated. */
      kind: "graph_operation";
      /** Ready to hand to `DiagramSession.applyOperation()` unchanged. */
      operation: GraphOperation;
    }
  | {
      /** A `rename_diagram` tool call -- diagram metadata, not a {@link GraphOperation}. */
      kind: "rename_diagram";
      /** New title, when provided. */
      title?: string;
      /** New description (`null` clears it), when provided. */
      description?: string | null;
    }
  | {
      /** A `search_cloudflare_documentation` tool call. */
      kind: "search_cloudflare_documentation";
      /** The search query to pass to `docs-client.ts`. */
      query: string;
    }
  | {
      /**
       * A tool call that failed validation -- malformed/missing arguments, an unrecognized tool
       * name, or (for `add_node`/`add_edge`/`update_edge`) a `typeId`/`edgeType` not present in
       * the live catalog. Never thrown -- always returned as a plain result, so the calling
       * `chat-engine.ts` loop can feed `message` back to the model as a `role: "tool"` result
       * and let it self-correct within the same turn.
       */
      kind: "tool_error";
      /** Human-readable (and model-readable) description of what was wrong. */
      message: string;
    };

/** Build a {@link ToolDispatchResult} `tool_error` from a zod validation failure. */
function fromZodError(name: string, error: z.ZodError): ToolDispatchResult {
  const detail = error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return {
    kind: "tool_error",
    message: `Invalid arguments for "${name}": ${detail}`,
  };
}

/** Build a {@link ToolDispatchResult} `tool_error` for an unrecognized `typeId`/`edgeType`,
 * listing the currently valid values so the model can self-correct. */
function fromUnknownCatalogValue(
  field: "typeId" | "edgeType",
  value: string,
  validValues: Iterable<string>,
): ToolDispatchResult {
  return {
    kind: "tool_error",
    message: `Unknown ${field} "${value}". Valid values: ${[...validValues].join(", ")}.`,
  };
}

/**
 * Validate one raw tool call's arguments and translate it into a {@link ToolDispatchResult} --
 * the one dispatcher every graph-mutating tool, `rename_diagram`, and
 * `search_cloudflare_documentation` all go through. Pure: it never calls
 * `DiagramSession.applyOperation()`, `DiagramRepository.updateMetadata()`, or `docs-client.ts`
 * itself -- it only decides *what* the caller (`chat-engine.ts`, Phase 23) should do next.
 *
 * `graph` is consulted only by `add_node` when its tool call omits `position` (filled in via
 * `catalog-context.ts`'s `nextGridPosition(graph)`). This dispatcher deliberately does **not**
 * check whether a `nodeId`/`edgeId` argument actually exists in `graph` -- that check happens
 * downstream, inside `DiagramSession.applyOperation()` itself (via `graph-mutations.ts`'s
 * `notFound()`-throwing functions), because `graph` here can be stale the instant a concurrent
 * human or MCP-agent edit lands between this dispatch and the moment `applyOperation()` actually
 * runs (docs/09D-ARCHITECT-AICHAT.md's "a chat turn is not one atomic transaction" design) --
 * re-validating existence here would only recheck a snapshot the caller cannot guarantee is still
 * current by the time it matters.
 *
 * @param name Tool name exactly as the model named it in a `tool_calls[]` entry.
 * @param rawArgs The tool call's raw, untrusted `arguments` value.
 * @param graph The diagram's current graph -- read only for `add_node`'s default position.
 * @returns A {@link ToolDispatchResult} describing what to do next; a `tool_error` result for any
 * validation failure, never a thrown error.
 */
export function dispatchToolCall(
  name: string,
  rawArgs: unknown,
  graph: GraphData,
): ToolDispatchResult {
  switch (name as ToolName) {
    case "add_node": {
      const parsed = addNodeSchema.safeParse(rawArgs);
      if (!parsed.success) return fromZodError(name, parsed.error);
      const { typeId, label, description, position } = parsed.data;
      if (!NODE_TYPE_MAP.has(typeId)) {
        return fromUnknownCatalogValue("typeId", typeId, NODE_TYPE_MAP.keys());
      }
      return {
        kind: "graph_operation",
        operation: {
          input: {
            description,
            label,
            position: position ?? nextGridPosition(graph),
            typeId,
          },
          kind: "add_node",
        },
      };
    }

    case "update_node": {
      const parsed = updateNodeSchema.safeParse(rawArgs);
      if (!parsed.success) return fromZodError(name, parsed.error);
      const { nodeId, label, description, position } = parsed.data;
      return {
        kind: "graph_operation",
        operation: {
          kind: "update_node",
          nodeId,
          patch: { description, label, position },
        },
      };
    }

    case "remove_node": {
      const parsed = removeNodeSchema.safeParse(rawArgs);
      if (!parsed.success) return fromZodError(name, parsed.error);
      return {
        kind: "graph_operation",
        operation: { kind: "remove_node", nodeId: parsed.data.nodeId },
      };
    }

    case "add_edge": {
      const parsed = addEdgeSchema.safeParse(rawArgs);
      if (!parsed.success) return fromZodError(name, parsed.error);
      const { source, target, edgeType, label, description, protocol } =
        parsed.data;
      if (!EDGE_TYPE_MAP.has(edgeType)) {
        return fromUnknownCatalogValue(
          "edgeType",
          edgeType,
          EDGE_TYPE_MAP.keys(),
        );
      }
      return {
        kind: "graph_operation",
        operation: {
          input: { description, edgeType, label, protocol, source, target },
          kind: "add_edge",
        },
      };
    }

    case "update_edge": {
      const parsed = updateEdgeSchema.safeParse(rawArgs);
      if (!parsed.success) return fromZodError(name, parsed.error);
      const { edgeId, edgeType, label, description, protocol } = parsed.data;
      if (edgeType !== undefined && !EDGE_TYPE_MAP.has(edgeType)) {
        return fromUnknownCatalogValue(
          "edgeType",
          edgeType,
          EDGE_TYPE_MAP.keys(),
        );
      }
      return {
        kind: "graph_operation",
        operation: {
          edgeId,
          kind: "update_edge",
          patch: { description, edgeType, label, protocol },
        },
      };
    }

    case "remove_edge": {
      const parsed = removeEdgeSchema.safeParse(rawArgs);
      if (!parsed.success) return fromZodError(name, parsed.error);
      return {
        kind: "graph_operation",
        operation: { edgeId: parsed.data.edgeId, kind: "remove_edge" },
      };
    }

    case "rename_diagram": {
      const parsed = renameDiagramSchema.safeParse(rawArgs);
      if (!parsed.success) return fromZodError(name, parsed.error);
      return {
        description: parsed.data.description,
        kind: "rename_diagram",
        title: parsed.data.title,
      };
    }

    case "search_cloudflare_documentation": {
      const parsed = searchCloudflareDocumentationSchema.safeParse(rawArgs);
      if (!parsed.success) return fromZodError(name, parsed.error);
      return {
        kind: "search_cloudflare_documentation",
        query: parsed.data.query,
      };
    }

    default:
      return { kind: "tool_error", message: `Unknown tool "${name}".` };
  }
}
