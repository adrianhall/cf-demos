import { z } from 'zod';
import { EDGE_TYPE_MAP, NODE_TYPE_MAP } from '../../../catalog.ts';
import type { GraphOperation } from '../graph-operations.ts';
import type { GraphData } from '../graph.ts';
import { nextGridPosition } from './catalog-context.ts';

/**
 * @file The chat assistant's tool catalogue and its one dispatcher. Six graph-mutating tools
 *   mirroring `../graph-operations.ts`'s vocabulary one-for-one, plus `rename_diagram` (diagram
 *   metadata, which is not part of a {@link GraphData}) and `search_cloudflare_documentation`
 *   (which touches the diagram not at all). Pure, and the purity is load-bearing rather than
 *   stylistic. Nothing here imports `DiagramSession`, D1, a binding or a socket:
 *   {@link dispatchToolCall} decides _what_ should happen and returns it as a value, and the
 *   application tier is left to decide whether and how to perform it. That is the same reason
 *   `../graph-operations.ts` names each mutation as data rather than a closure, and it has the same
 *   payoff — the whole tool surface is unit-testable against a fixture graph with no runtime at
 *   all. The second rule this module exists to enforce is that **a model's mistake is data, not an
 *   exception**. Every validation failure, including a `typeId` or `edgeType` that does not exist,
 *   comes back as a `tool_error` naming the valid values. Thrown from here it would end the turn;
 *   returned from here it becomes a `role: "tool"` message the model reads and corrects itself
 *   from, inside the same turn the user is waiting on.
 */

/**
 * Every tool the chat assistant may call, by name.
 *
 * A union rather than a loose string, so {@link TOOL_SCHEMAS} and {@link TOOL_DESCRIPTIONS} are
 * checked for completeness at compile time: adding a member here fails the build until the tool has
 * both a schema and a description, rather than shipping a tool the model is told about and the
 * dispatcher has never heard of.
 */
export type ToolName =
  | 'add_node'
  | 'update_node'
  | 'remove_node'
  | 'add_edge'
  | 'update_edge'
  | 'remove_edge'
  | 'rename_diagram'
  | 'search_cloudflare_documentation';

/**
 * Shared shape for a canvas position, reused by `add_node` and `update_node`, matching the `{ x, y
 * }` flow coordinates `../graph-mutations.ts` stores.
 */
const positionSchema = z.object({
  x: z.number().describe('Canvas x position, in flow coordinates.'),
  y: z.number().describe('Canvas y position, in flow coordinates.')
});

/**
 * Input schema for `add_node`.
 *
 * `typeId` is a plain `z.string()` rather than a `z.enum()` of the catalogue, and that is a
 * deliberate split of responsibilities: the schema checks shape, and {@link dispatchToolCall}
 * checks membership against the **live** `NODE_TYPE_MAP`. An enum here would be a second copy of
 * the catalogue that has to be kept hand-synchronised with `src/catalog.ts`, and a zod enum failure
 * reports only "invalid value" — where the dispatcher's check can name every id the model could
 * have used instead, which is the information it needs to recover.
 *
 * No `id` field, even though `AddNodeInput` accepts one. The session mints and replicates the id
 * (`../../infrastructure/diagram-session.ts`), and a model-chosen id would collide with an existing
 * node the first time it guesses a word already in use — a `badRequest()` refusal for no gain,
 * since the id is handed back to the model in the tool result either way.
 */
const addNodeSchema = z.object({
  typeId: z
    .string()
    .min(1)
    .describe(
      'Catalog product type id, for example "worker" or "d1". Must be one of the current '
        + "catalog's node type ids."
    ),
  label: z.string().min(1).describe('Display label shown on the node.'),
  description: z
    .string()
    .optional()
    .describe('Optional free-text annotation shown below the label.'),
  position: positionSchema
    .optional()
    .describe(
      'Canvas position for the new node. Omit it unless the user asked for a specific placement; '
        + 'a staggered-grid position is assigned automatically and the editor re-runs its own '
        + 'layout afterwards.'
    )
});

/**
 * Input schema for `update_node`.
 *
 * The patchable fields mirror the real `NodePatch` in `../graph-mutations.ts`. In particular there
 * is **no `typeId`**: `updateNode()` cannot change an existing node's product type, so a tool
 * offering one would advertise a capability the domain does not have, and the model would discover
 * that only by having its call silently ignored. Changing a node's type means removing it and
 * adding the right one, which the model can already express.
 *
 * `style` is the one `NodePatch` field deliberately not offered. It is an unbounded `Record<string,
 * unknown>` of editor visual overrides with no schema a model could be given, and the chat's job is
 * the architecture of the diagram rather than its colour scheme.
 */
const updateNodeSchema = z.object({
  nodeId: z
    .string()
    .min(1)
    .describe('Id of the existing node to update, taken from the current diagram contents.'),
  label: z.string().optional().describe('New display label.'),
  description: z.string().optional().describe('New free-text annotation.'),
  position: positionSchema.optional().describe('New canvas position.')
});

/**
 * Input schema for `remove_node`.
 */
const removeNodeSchema = z.object({
  nodeId: z
    .string()
    .min(1)
    .describe('Id of the node to remove. Every edge connected to it is removed with it.')
});

/**
 * Input schema for `add_edge`.
 *
 * `edgeType` is validated against the live `EDGE_TYPE_MAP` at dispatch for exactly the reason
 * {@link addNodeSchema}'s `typeId` is. `sourceHandle`/`targetHandle` are not offered: they are
 * geometry the editor chooses when a person drags a connection, and a model guessing a handle id
 * would pin an edge to an arbitrary side of a node for no reason it could explain.
 */
const addEdgeSchema = z.object({
  source: z.string().min(1).describe('Id of the existing node this edge starts from.'),
  target: z.string().min(1).describe('Id of the existing node this edge ends at.'),
  edgeType: z
    .string()
    .min(1)
    .describe(
      'Visual and semantic edge type, for example "data-flow". Must be one of the current '
        + "catalog's edge type ids."
    ),
  label: z.string().optional().describe('Optional label rendered at the edge midpoint.'),
  description: z.string().optional().describe('Optional tooltip annotation.'),
  protocol: z
    .string()
    .optional()
    .describe('Optional communication protocol hint, for example "http" or "binding".')
});

/**
 * Input schema for `update_edge`, mirroring `../graph-mutations.ts`'s `EdgePatch` field for field.
 */
const updateEdgeSchema = z.object({
  edgeId: z
    .string()
    .min(1)
    .describe('Id of the existing edge to update, taken from the current diagram contents.'),
  edgeType: z
    .string()
    .optional()
    .describe("New edge type. Must be one of the current catalog's edge type ids when provided."),
  label: z.string().optional().describe('New label.'),
  description: z.string().optional().describe('New tooltip annotation.'),
  protocol: z.string().optional().describe('New communication protocol hint.')
});

/**
 * Input schema for `remove_edge`.
 */
const removeEdgeSchema = z.object({
  edgeId: z.string().min(1).describe('Id of the edge to remove. Both of its nodes are kept.')
});

/**
 * Input schema for `rename_diagram`.
 *
 * At least one of `title`/`description` is required, matching the same rule
 * `../diagram-validation.ts` applies to the REST and MCP update paths: a call naming neither field
 * is not a rename, and accepting it would have the assistant report a change that never happened.
 */
const renameDiagramSchema = z
  .object({
    title: z.string().min(1).optional().describe('New diagram title.'),
    description: z
      .string()
      .nullable()
      .optional()
      .describe('New free-text description. null clears it; omitting it leaves it unchanged.')
  })
  .refine((value) => value.title !== undefined || value.description !== undefined, {
    message: 'rename_diagram requires a title and/or a description.'
  });

/**
 * Input schema for `search_cloudflare_documentation`.
 */
const searchCloudflareDocumentationSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Search query against Cloudflare's current published product documentation.")
});

/**
 * Every tool's schema, keyed by name — the single source {@link TOOL_DEFINITIONS} and
 * {@link dispatchToolCall} both read, so the schema a model is shown is the schema its call is
 * checked against.
 */
const TOOL_SCHEMAS = {
  add_edge: addEdgeSchema,
  add_node: addNodeSchema,
  remove_edge: removeEdgeSchema,
  remove_node: removeNodeSchema,
  rename_diagram: renameDiagramSchema,
  search_cloudflare_documentation: searchCloudflareDocumentationSchema,
  update_edge: updateEdgeSchema,
  update_node: updateNodeSchema
} satisfies Record<ToolName, z.ZodType>;

/**
 * Plain-language statement of each tool's scope, following the same convention `../../mcp/
 * server.ts` uses for its own tool descriptions: say what the tool does and what it does not,
 * because a model's only defence against calling the wrong tool is this sentence.
 */
const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  add_edge: "Connect two existing nodes on the diagram's canvas with an edge.",
  add_node: 'Add a new Cloudflare service node to the diagram.',
  remove_edge: 'Remove an edge from the diagram, leaving both of its nodes in place.',
  remove_node: 'Remove a node from the diagram, along with every edge connected to it.',
  rename_diagram: "Change the diagram's title and/or its description.",
  search_cloudflare_documentation:
    "Search Cloudflare's current published product documentation to ground an answer or a "
    + 'product choice in up-to-date information. Has no effect on the diagram.',
  update_edge: "Update an existing edge's type, label, description and/or protocol.",
  update_node: "Update an existing node's label, description and/or position."
};

/**
 * One tool as the inference call advertises it.
 *
 * `{ name, description, parameters }` is the shape Workers AI's `tools` option takes, and it is the
 * OpenAI-compatible function-calling shape the model answers in.
 */
export interface ToolDefinition {
  /**
   * Tool name, exactly as the model must spell it in a `tool_calls[]` entry.
   */
  name: ToolName;
  /**
   * Plain-language description of the tool's effect and its limits.
   */
  description: string;
  /**
   * JSON Schema object describing the arguments the tool accepts.
   */
  parameters: Record<string, unknown>;
}

/**
 * Top-level keywords {@link toParameters} removes from a converted schema; see that function for why
 * each one goes.
 */
const STRIPPED_SCHEMA_KEYWORDS = new Set(['$schema', 'additionalProperties']);

/**
 * Converts one tool's schema into the plain JSON Schema object `parameters` expects.
 *
 * Two fields zod's own converter emits are stripped. `$schema` is a document-level declaration that
 * means nothing inside a tool parameter block, and `additionalProperties: false` is omitted to
 * match the shape of Cloudflare's own function-calling example rather than adding a keyword this
 * module cannot confirm every tool-calling model tolerates. Dropping it costs nothing here: an
 * unexpected argument is discarded by the zod parse at dispatch either way.
 *
 * @param schema The tool's zod input schema.
 * @returns A JSON Schema object suitable for {@link ToolDefinition.parameters}.
 */
function toParameters(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema: Record<string, unknown> = z.toJSONSchema(schema);
  return Object.fromEntries(
    Object.entries(jsonSchema).filter(([key]) => !STRIPPED_SCHEMA_KEYWORDS.has(key))
  );
}

/**
 * Every tool the chat assistant exposes, ready to pass as the inference call's `tools` option.
 *
 * Computed once at module load, unlike `./catalog-context.ts`'s digests. The difference is real
 * rather than an inconsistency: these schemas describe this module's own fixed argument shapes,
 * which cannot change while the Worker is running, whereas the catalogue digest describes data that
 * can.
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = (Object.keys(TOOL_SCHEMAS) as ToolName[]).map(
  (name) => ({
    description: TOOL_DESCRIPTIONS[name],
    name,
    parameters: toParameters(TOOL_SCHEMAS[name])
  })
);

/**
 * What {@link dispatchToolCall} decided one tool call means.
 *
 * A discriminated union so the caller switches on `kind` and never has to know that zod, or this
 * module's validation at all, was involved.
 */
export type ToolDispatchResult =
  | {
      /**
       * A graph-mutating call, validated and translated.
       */
      kind: 'graph_operation';
      /**
       * The operation to apply, in exactly the form `DiagramSessionPort.applyOperation()` already
       * accepts.
       */
      operation: GraphOperation;
    }
  | {
      /**
       * A `rename_diagram` call. Diagram metadata is not part of the graph, so this is not a
       * {@link GraphOperation} and does not travel the session's write path.
       */
      kind: 'rename_diagram';
      /**
       * New title, when the call named one.
       */
      title?: string;
      /**
       * New description, when the call named one. `null` clears it.
       */
      description?: string | null;
    }
  | {
      /**
       * A `search_cloudflare_documentation` call.
       */
      kind: 'search_cloudflare_documentation';
      /**
       * The query to pass to the documentation port.
       */
      query: string;
    }
  | {
      /**
       * A call this module refused: malformed or missing arguments, an unknown tool name, or a
       * `typeId`/`edgeType` the live catalogue does not contain.
       *
       * Returned rather than thrown, always. A throw would abort the turn on what is usually a
       * recoverable mistake; a value becomes the `role: "tool"` result the model reads and corrects
       * itself from, without the user ever seeing a failure.
       */
      kind: 'tool_error';
      /**
       * What was wrong, written to be read by the model as much as by a log reader.
       */
      message: string;
    };

/**
 * Renders a zod failure as a `tool_error` the model can act on.
 *
 * Every issue is reported rather than only the first, with its field path, because a model told
 * about one missing field at a time needs one round per mistake and the round budget is finite.
 *
 * @param name Tool name as the model spelled it, echoed so the message stands alone in a
 *   transcript.
 * @param error The failure zod produced.
 * @returns A `tool_error` result naming each offending field and what was wrong with it.
 */
function fromZodError(name: string, error: z.ZodError): ToolDispatchResult {
  const detail = error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return { kind: 'tool_error', message: `Invalid arguments for "${name}": ${detail}` };
}

/**
 * Renders an unrecognised catalogue value as a `tool_error` listing the valid ones.
 *
 * The list is the whole point. A bare "unknown typeId" leaves a model to guess again from the same
 * flawed assumption, whereas the current values let it pick a real one on the next round. They are
 * read from the live map rather than a snapshot, so the message cannot name a type that no longer
 * exists.
 *
 * @param field Which field was wrong, named as the model knows it.
 * @param value The value the model supplied, echoed so it can see what it got wrong.
 * @param validValues Every currently valid value for that field.
 * @returns A `tool_error` result naming the rejected value and the full set of valid ones.
 */
function fromUnknownCatalogValue(
  field: 'typeId' | 'edgeType',
  value: string,
  validValues: Iterable<string>
): ToolDispatchResult {
  return {
    kind: 'tool_error',
    message: `Unknown ${field} "${value}". Valid values: ${[...validValues].join(', ')}.`
  };
}

/**
 * Validates one raw tool call and translates it into the action its caller should take.
 *
 * Pure. It never applies an operation, never renames a diagram and never searches anything — it
 * only decides. The caller owns every effect, which is what keeps the entire tool surface testable
 * without a Durable Object, and what stops a second write path appearing beside the serialized
 * one.
 *
 * `graph` is consulted for one thing only: `add_node`'s default position. In particular this
 * function deliberately does **not** check that a `nodeId`/`edgeId` exists. That check belongs
 * downstream in the session's synchronous mutation region, where the graph it tests against is the
 * one being written to. Re-checking here would validate a snapshot that a concurrent human or agent
 * edit can invalidate between this call and the write — a check that cannot be trusted is worse
 * than no check, because it implies a guarantee the caller does not get.
 *
 * @param name Tool name exactly as the model spelled it, including a name no tool has.
 * @param rawArgs The call's untrusted arguments, as parsed from the model's JSON string.
 * @param graph The diagram's current graph, read only for `add_node`'s default position.
 * @returns What the caller should do next. Every failure — malformed arguments, an unknown tool, an
 *   unrecognised catalogue value — is a `tool_error` result.
 * @throws Nothing. A thrown error here would end a chat turn on a mistake the model could have
 *   corrected, so every refusal is returned as a value instead.
 */
export function dispatchToolCall(
  name: string,
  rawArgs: unknown,
  graph: GraphData
): ToolDispatchResult {
  switch (name as ToolName) {
    case 'add_node': {
      const parsed = addNodeSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return fromZodError(name, parsed.error);
      }
      const { typeId, label, description, position } = parsed.data;
      if (!NODE_TYPE_MAP.has(typeId)) {
        return fromUnknownCatalogValue('typeId', typeId, NODE_TYPE_MAP.keys());
      }
      return {
        kind: 'graph_operation',
        operation: {
          input: { description, label, position: position ?? nextGridPosition(graph), typeId },
          kind: 'add_node'
        }
      };
    }

    case 'update_node': {
      const parsed = updateNodeSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return fromZodError(name, parsed.error);
      }
      const { nodeId, label, description, position } = parsed.data;
      return {
        kind: 'graph_operation',
        operation: { kind: 'update_node', nodeId, patch: { description, label, position } }
      };
    }

    case 'remove_node': {
      const parsed = removeNodeSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return fromZodError(name, parsed.error);
      }
      return {
        kind: 'graph_operation',
        operation: { kind: 'remove_node', nodeId: parsed.data.nodeId }
      };
    }

    case 'add_edge': {
      const parsed = addEdgeSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return fromZodError(name, parsed.error);
      }
      const { source, target, edgeType, label, description, protocol } = parsed.data;
      if (!EDGE_TYPE_MAP.has(edgeType)) {
        return fromUnknownCatalogValue('edgeType', edgeType, EDGE_TYPE_MAP.keys());
      }
      return {
        kind: 'graph_operation',
        operation: {
          input: { description, edgeType, label, protocol, source, target },
          kind: 'add_edge'
        }
      };
    }

    case 'update_edge': {
      const parsed = updateEdgeSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return fromZodError(name, parsed.error);
      }
      const { edgeId, edgeType, label, description, protocol } = parsed.data;
      // Checked only when supplied: `edgeType` is optional on a patch, and an omitted field means
      // "leave it alone" rather than "set it to nothing".
      if (edgeType !== undefined && !EDGE_TYPE_MAP.has(edgeType)) {
        return fromUnknownCatalogValue('edgeType', edgeType, EDGE_TYPE_MAP.keys());
      }
      return {
        kind: 'graph_operation',
        operation: {
          edgeId,
          kind: 'update_edge',
          patch: { description, edgeType, label, protocol }
        }
      };
    }

    case 'remove_edge': {
      const parsed = removeEdgeSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return fromZodError(name, parsed.error);
      }
      return {
        kind: 'graph_operation',
        operation: { edgeId: parsed.data.edgeId, kind: 'remove_edge' }
      };
    }

    case 'rename_diagram': {
      const parsed = renameDiagramSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return fromZodError(name, parsed.error);
      }
      return {
        description: parsed.data.description,
        kind: 'rename_diagram',
        title: parsed.data.title
      };
    }

    case 'search_cloudflare_documentation': {
      const parsed = searchCloudflareDocumentationSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return fromZodError(name, parsed.error);
      }
      return { kind: 'search_cloudflare_documentation', query: parsed.data.query };
    }

    default:
      // Reached whenever the model invents a tool, which it does. The cast above is to the union
      // for the compiler's benefit; this arm is what makes the runtime honest about it.
      return { kind: 'tool_error', message: `Unknown tool "${name}".` };
  }
}
