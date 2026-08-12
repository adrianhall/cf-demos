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
