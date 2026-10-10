import {
  CATEGORY_LABELS,
  EDGE_TYPES,
  NODE_TYPES,
  type NodeCategory,
} from "../../catalog";
import type { GraphData } from "../diagrams/types";

/**
 * Builds the compact, model-facing digest of `src/catalog.ts`'s current node/edge type catalog
 * used as part of `chat-engine.ts`'s system prompt (docs/09D-ARCHITECT-AICHAT.md's Chat Loop And
 * Tool Execution, step 1). Generated fresh from `NODE_TYPES`/`EDGE_TYPES` on every call -- no
 * caching -- so the digest can never drift from the real, currently-registered product set (a
 * cached copy would silently go stale the moment a future catalog entry is added, renamed, or
 * removed).
 *
 * Deliberately includes only `typeId`/`label`/`category`/`description` per node type and
 * `edgeType`/`label`/`description` per edge type. Every other `NodeTypeDef`/`EdgeTypeDef` field
 * (`icon`, `defaultHandles`, `wranglerBinding`, `scaffoldTemplate`, `docLinks`, `style`,
 * `animated`, `markerEnd`, `color`, `bindingType`) is presentation/scaffold-only -- meaningless to
 * a tool-calling model deciding which `typeId`/`edgeType` to pass to `add_node`/`add_edge` -- and
 * would otherwise inflate a prompt sent on every single chat turn for no decision-making benefit.
 *
 * @returns A compact Markdown digest, grouped by {@link NodeCategory}, followed by the edge type
 * list. Intentionally plain enough for a model to both read (to explain a diagram to the user)
 * and reliably extract a valid `typeId`/`edgeType` value from (to call a graph-mutating tool).
 */
export function buildCatalogPromptContext(): string {
  const byCategory = new Map<NodeCategory, string[]>();
  for (const node of NODE_TYPES) {
    const line = `- ${node.typeId} (${node.label}): ${node.description}`;
    const lines = byCategory.get(node.category);
    if (lines === undefined) {
      byCategory.set(node.category, [line]);
    } else {
      lines.push(line);
    }
  }

  const nodeSections = [...byCategory.entries()].map(
    ([category, lines]) =>
      `### ${CATEGORY_LABELS[category]}\n${lines.join("\n")}`,
  );

  const edgeLines = EDGE_TYPES.map(
    (edge) => `- ${edge.edgeType} (${edge.label}): ${edge.description}`,
  );

  return [
    "## Available node types (`typeId`)",
    ...nodeSections,
    "## Available edge types (`edgeType`)",
    ...edgeLines,
  ].join("\n\n");
}

/**
 * Read one top-level string field from an opaque graph node/edge record.
 *
 * `GraphData`'s own `nodes`/`edges` are deliberately typed as `Record<string, unknown>[]` -- the
 * Worker treats a node's payload as opaque React Flow state (see `../diagrams/types.ts`) -- so
 * this narrows the few fields the digest actually prints without asserting a shape the type
 * system does not guarantee.
 *
 * @param record The node or edge record.
 * @param key The field to read.
 * @returns The field's string value, or an empty string when it is absent or not a string.
 */
function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

/**
 * Read one string field out of an opaque graph node/edge record's nested `data` payload,
 * symmetric to {@link readString}.
 *
 * @param record The node or edge record.
 * @param key The field to read from `record.data`.
 * @returns The field's string value, or an empty string when it is absent or not a string.
 */
function readDataString(record: Record<string, unknown>, key: string): string {
  const data = record.data;
  if (typeof data !== "object" || data === null) return "";
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/**
 * Build the model-facing digest of what is **currently on the canvas**, for the same system
 * prompt {@link buildCatalogPromptContext} contributes the catalog to.
 *
 * Without this the assistant is blind: it cannot honor the system prompt's own "you can explain
 * the diagram currently on the canvas" promise, and -- more damagingly -- it has no node or edge
 * **id** to pass to `update_node`, `remove_node`, `add_edge`, `update_edge`, or `remove_edge`,
 * since ids are `crypto.randomUUID()`s generated server-side by `../../graph-mutations.ts`. A
 * model with no ids invents them (typically by passing a node's *label* where an id belongs),
 * every such call is rejected, and the turn burns its whole round budget failing
 * (docs/DECISIONS.md #42).
 *
 * Deliberately includes only the fields a tool call actually needs to target an entity plus
 * enough text to describe it: each node's `id`/`typeId`/`label`, and each edge's
 * `id`/`source`/`target`/`edgeType`. Node `description`, canvas positions, and viewport state
 * are all omitted -- none of them changes which id a tool call should name, and this digest is
 * rebuilt into every round of every turn.
 *
 * @param graph The diagram's current graph.
 * @returns A compact Markdown digest of the current nodes and edges, or an explicit "empty
 * canvas" note when there is nothing on it yet.
 */
export function buildGraphPromptContext(graph: GraphData): string {
  if (graph.nodes.length === 0 && graph.edges.length === 0) {
    return "## Current diagram contents\n\nThe canvas is empty.";
  }

  const nodeLines =
    graph.nodes.length > 0
      ? graph.nodes.map(
          (node) =>
            `- id: ${readString(node, "id")} | typeId: ${readDataString(node, "typeId")} | label: ${readDataString(node, "label")}`,
        )
      : ["(no nodes)"];

  const edgeLines =
    graph.edges.length > 0
      ? graph.edges.map(
          (edge) =>
            `- id: ${readString(edge, "id")} | source: ${readString(edge, "source")} | target: ${readString(edge, "target")} | edgeType: ${readDataString(edge, "edgeType")}`,
        )
      : ["(no edges)"];

  return [
    "## Current diagram contents",
    "Use these exact `id` values -- never a label -- when a tool call needs a nodeId, edgeId, source, or target.",
    "### Nodes",
    ...nodeLines,
    "### Edges",
    ...edgeLines,
  ].join("\n");
}

/** Number of columns in {@link nextGridPosition}'s staggered grid before wrapping to a new row. */
const GRID_COLUMNS = 4;

/** Horizontal spacing, in canvas units, between columns in {@link nextGridPosition}'s grid. */
const GRID_SPACING_X = 260;

/** Vertical spacing, in canvas units, between rows in {@link nextGridPosition}'s grid. */
const GRID_SPACING_Y = 160;

/**
 * Deterministic fallback canvas position for a new node, used by `tools.ts`'s `add_node`
 * dispatcher when the model's tool call omits `position` (docs/09D-ARCHITECT-AICHAT.md's Tool
 * catalog: "`position` is optional in the tool schema; when omitted, a small internal
 * `nextGridPosition(graph)` helper ... assigns one"). Positions a new node in a staggered grid
 * keyed purely off the graph's current node count -- column `count % GRID_COLUMNS`, row
 * `floor(count / GRID_COLUMNS)` -- so calling this function repeatedly against a graph that
 * gains one node between each call (the common case: one `add_node` tool call per round) always
 * produces the next distinct grid cell, with no need to inspect any node's existing position.
 *
 * This is deliberately simpler than `graph-mutations.ts`'s own `autoLayout()` (a breadth-first,
 * edge-aware layered layout): unlike 9B's MCP tools, this document's chat is always driven from a
 * page with a real, attached browser, so the client runs its own real `elkjs`-powered auto-layout
 * after a turn that changed the node count (docs/09D-ARCHITECT-AICHAT.md's Node Placement And
 * Auto-Layout) -- this function only needs to produce a legible, non-overlapping placement for
 * nodes to stream into, not a finished layout.
 *
 * @param graph Diagram's current graph -- only `graph.nodes.length` is read.
 * @returns A canvas position for the next new node.
 */
export function nextGridPosition(graph: GraphData): { x: number; y: number } {
  const count = graph.nodes.length;
  const column = count % GRID_COLUMNS;
  const row = Math.floor(count / GRID_COLUMNS);
  return { x: column * GRID_SPACING_X, y: row * GRID_SPACING_Y };
}
