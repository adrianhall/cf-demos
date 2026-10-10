import { CATEGORY_LABELS, EDGE_TYPES, NODE_TYPES, type NodeCategory } from '../../../catalog.ts';
import type { GraphData } from '../graph.ts';

/**
 * @file The model-facing prompt context — what the chat assistant is told about the product
 *   catalogue and about the diagram currently on the canvas. Pure, exactly like its neighbours in
 *   `../graph-mutations.ts` and `../graph-operations.ts`: it reads `src/catalog.ts` and a fixture
 *   `GraphData` and returns strings, with no binding, no D1, no socket and no model call anywhere
 *   in it. That is what makes the prompt a unit-testable artefact rather than something only
 *   observable by watching a live conversation go wrong. It lives in `domain/` rather than beside
 *   the chat engine because the thing it encodes is domain vocabulary: which product types exist,
 *   which edge types exist, and which ids a change may name. The engine that will compose these
 *   strings into a system message is an application concern and depends on this module, never the
 *   other way round.
 */

/**
 * Builds the compact digest of the current node and edge type catalogue for the system prompt.
 *
 * Generated fresh on every call rather than computed once at module load. The cost is a few string
 * joins, and the benefit is that the digest can never describe a catalogue the application no
 * longer has: a cached copy would go stale the moment a type is added, renamed or removed, and the
 * failure mode of a stale catalogue is a model confidently calling `add_node` with a `typeId` that
 * was deleted.
 *
 * Only `typeId`/`label`/`category`/`description` and `edgeType`/`label`/`description` are included.
 * Every other field on `NodeTypeDef`/`EdgeTypeDef` — `icon`, `defaultHandles`, `wranglerBinding`,
 * `scaffoldTemplate`, `docLinks`, `style`, `animated`, `markerEnd`, `color`, `bindingType` — is
 * presentation or scaffold detail that cannot change which `typeId` or `edgeType` a tool call
 * should name. Including them would inflate a prompt that is rebuilt on every round of every turn,
 * and a longer prompt is a slower and more expensive one.
 *
 * @returns A Markdown digest grouped by {@link NodeCategory}, followed by the edge type list. Plain
 *   enough for a model both to read back to a user and to extract an exact identifier from.
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
    ([category, lines]) => `### ${CATEGORY_LABELS[category]}\n${lines.join('\n')}`
  );

  const edgeLines = EDGE_TYPES.map(
    (edge) => `- ${edge.edgeType} (${edge.label}): ${edge.description}`
  );

  return [
    '## Available node types (`typeId`)',
    ...nodeSections,
    '## Available edge types (`edgeType`)',
    ...edgeLines
  ].join('\n\n');
}

/**
 * Reads one top-level string field from an opaque graph node or edge record.
 *
 * `GraphData`'s elements are deliberately `Record<string, unknown>` — the Worker treats a node's
 * payload as the editor's vocabulary rather than its own, as `../graph.ts` explains — so the digest
 * narrows the handful of fields it actually prints instead of asserting a shape the type system
 * does not guarantee. A missing or non-string value degrades to an empty string rather than
 * printing `undefined`, because `undefined` in a prompt reads to a model as a literal value it
 * might helpfully pass back.
 *
 * @param record The node or edge record to read.
 * @param key Name of the field to read.
 * @returns The field's value when it is a string, and an empty string otherwise.
 */
function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Reads one string field from an opaque record's nested `data` payload, symmetric to
 * {@link readString}.
 *
 * @param record The node or edge record whose `data` payload should be read.
 * @param key Name of the field to read from `record.data`.
 * @returns The field's value when it is a string, and an empty string otherwise — including when
 *   `data` is absent or is not an object at all.
 */
function readDataString(record: Record<string, unknown>, key: string): string {
  const data = record.data;
  if (typeof data !== 'object' || data === null) {
    return '';
  }
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Builds the digest of what is **currently on the canvas**, for the same system prompt
 * {@link buildCatalogPromptContext} contributes the catalogue to.
 *
 * Without this the assistant is blind in a specific and expensive way. Node and edge ids are
 * server-side `crypto.randomUUID()` values minted in `../graph-mutations.ts`, so a model that has
 * never been shown one has nothing to put in `update_node`'s `nodeId` or `add_edge`'s
 * `source`/`target`. The observed behaviour is not a refusal but an invention: the model passes
 * each node's **label** where an id belongs, every call is rejected with `notFound()`, and the turn
 * burns its whole round budget failing. The explicit "use these exact ids, never a label" sentence
 * below is part of the contract rather than politeness, and the Phase 21 spike
 * (`specs/architect/06-ai-chat-spike.md` §4.3) records it as empirically necessary.
 *
 * Positions, descriptions and viewport state are deliberately excluded. None of them can change
 * which id a tool call should name, and this text is rebuilt into the system message before every
 * round of every turn, so anything that does not inform a tool call is paid for repeatedly and
 * earns nothing. A model that needs a node's description can read it back from the diagram through
 * its label, which is included.
 *
 * @param graph The diagram's current graph, as the caller holds it.
 * @returns A Markdown digest of the current nodes and edges, or an explicit "the canvas is empty"
 *   note when there is nothing on it — which a model needs stated, because an absent section is
 *   ambiguous between "empty" and "withheld".
 */
export function buildGraphPromptContext(graph: GraphData): string {
  if (graph.nodes.length === 0 && graph.edges.length === 0) {
    return '## Current diagram contents\n\nThe canvas is empty.';
  }

  const nodeLines =
    graph.nodes.length > 0
      ? graph.nodes.map(
          (node) =>
            `- id: ${readString(node, 'id')} | typeId: ${readDataString(node, 'typeId')}`
            + ` | label: ${readDataString(node, 'label')}`
        )
      : ['(no nodes)'];

  const edgeLines =
    graph.edges.length > 0
      ? graph.edges.map(
          (edge) =>
            `- id: ${readString(edge, 'id')} | source: ${readString(edge, 'source')}`
            + ` | target: ${readString(edge, 'target')} | edgeType: ${readDataString(edge, 'edgeType')}`
        )
      : ['(no edges)'];

  return [
    '## Current diagram contents',
    'Use these exact `id` values — never a label — when a tool call needs a nodeId, edgeId, '
      + 'source, or target.',
    '### Nodes',
    ...nodeLines,
    '### Edges',
    ...edgeLines
  ].join('\n');
}

/**
 * Number of columns {@link nextGridPosition} fills before wrapping onto a new row.
 */
const GRID_COLUMNS = 4;

/**
 * Horizontal spacing, in flow units, between two columns of {@link nextGridPosition}'s grid.
 */
const GRID_SPACING_X = 260;

/**
 * Vertical spacing, in flow units, between two rows of {@link nextGridPosition}'s grid.
 */
const GRID_SPACING_Y = 160;

/**
 * Deterministic fallback position for a new node, used when a tool call omits `position`.
 *
 * Keyed purely off the graph's current node count — column `count % GRID_COLUMNS`, row `floor(count
 * / GRID_COLUMNS)` — so a sequence of `add_node` calls against a graph that gains one node between
 * each call walks the grid cell by cell without ever inspecting an existing node's position. That
 * independence is what makes it cheap and what makes it testable.
 *
 * Deliberately simpler than `../graph-mutations.ts`'s `autoLayout()`, which is edge-aware and
 * layered. The chat is always driven from a page with a real attached browser, and the browser runs
 * its own `elkjs` layout after a turn that changed the node count, so this function only has to
 * produce a legible non-overlapping placement for nodes to stream into — not a finished drawing.
 * Reaching for `autoLayout()` here would rearrange the user's existing nodes as a side effect of
 * adding one, which is a change nobody asked for.
 *
 * @param graph The diagram's current graph. Only `graph.nodes.length` is read. @returns Flow
 * coordinates for the next new node.
 */
export function nextGridPosition(graph: GraphData): { x: number; y: number } {
  const count = graph.nodes.length;
  const column = count % GRID_COLUMNS;
  const row = Math.floor(count / GRID_COLUMNS);
  return { x: column * GRID_SPACING_X, y: row * GRID_SPACING_Y };
}
