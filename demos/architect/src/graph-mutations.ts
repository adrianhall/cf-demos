import { notFound } from "@adrianhall/cloudflare-toolkit/errors";
import { CF_EDGE_TYPE, CF_NODE_TYPE } from "./graph-element-types";
import type { GraphData } from "./worker/diagrams/types";

/**
 * Small, pure functions operating on the already-canonical {@link GraphData} shape --
 * docs/09C-COLLABORATIVE-EDITING.md's shared operation vocabulary, reused by every writer of a
 * diagram's graph: `../worker/diagram-session/diagram-session.ts`'s `DiagramSession.applyOperation()`
 * (the human WebSocket and 9B MCP tool write paths, via {@link applyGraphOperation}), and the
 * browser client's own remote-operation application (`./client/stores/diagramStore.ts`) --
 * "unify the MCP write path and the human write path onto one code path" extends all the way to
 * client-side rendering, so this module lives at this top-level, framework-agnostic location
 * (alongside `./catalog.ts`/`./graph-element-types.ts`/`./blueprints.ts`) specifically so both
 * the Worker/Durable Object bundle and the client bundle can import it with no duplication.
 *
 * Every function here is pure: it takes a {@link GraphData} value and returns a new one, never
 * mutating its input in place, so it is trivially unit-testable against fixture graph values with
 * no D1, Worker, or MCP involvement. Callers are responsible for parsing a diagram's stored
 * `graphData` JSON string into a {@link GraphData} value first, and for re-canonicalizing
 * (`./worker/diagrams/validation.ts`'s `canonicalizeGraphData()`) and persisting the result
 * afterward -- this module has no knowledge of persistence at all. {@link GraphData}'s own shape
 * (`{ nodes, edges, viewport }`, each node/edge an opaque `Record<string, unknown>`) is
 * structurally compatible with the client's `{ nodes: Node<CFNodeData>[], edges:
 * Edge<CFEdgeData>[], viewport }` React Flow state, so a caller on either side can pass its own
 * state directly (with a type assertion) without a translation step.
 */

/** One React Flow node as this module reads/writes it -- the concrete fields every function
 * below actually touches. Every other field a real canvas node carries (`selected`, `dragging`,
 * `measured`, ...) is preserved untouched via object spread; this module never needs to know
 * about them. */
interface GraphNode extends Record<string, unknown> {
  /** Unique node id. */
  id: string;
  /** React Flow renderer key -- always {@link CF_NODE_TYPE} for a node this module constructs. */
  type?: string;
  /** Canvas position. */
  position?: { x: number; y: number };
  /** Node data payload (`typeId`, `label`, `description`, ...). */
  data?: Record<string, unknown>;
}

/** One React Flow edge as this module reads/writes it, symmetric to {@link GraphNode}. */
interface GraphEdge extends Record<string, unknown> {
  /** Unique edge id. */
  id: string;
  /** React Flow renderer key -- always {@link CF_EDGE_TYPE} for an edge this module constructs. */
  type?: string;
  /** Source node id. */
  source?: string;
  /** Target node id. */
  target?: string;
  /** Edge data payload (`edgeType`, `label`, `description`, `protocol`). */
  data?: Record<string, unknown>;
}

/** Fields accepted by {@link addNode}. */
export interface AddNodeInput {
  /** Catalog product type identifier (e.g. "worker", "d1"), linking to `../../catalog.ts`. */
  typeId: string;
  /** Display label shown on the node. */
  label: string;
  /** Optional free-text annotation shown below the label. */
  description?: string;
  /** Canvas position for the new node. */
  position: { x: number; y: number };
}

/** Fields accepted by {@link updateNode}. Every field is optional; an omitted field is left
 * unchanged on the existing node. */
export interface NodePatch {
  /** New display label. */
  label?: string;
  /** New free-text annotation. */
  description?: string;
  /** New canvas position. */
  position?: { x: number; y: number };
}

/** Fields accepted by {@link addEdge}. */
export interface AddEdgeInput {
  /** Id of an existing node this edge starts from. */
  source: string;
  /** Id of an existing node this edge ends at. */
  target: string;
  /** Visual/semantic edge type controlling stroke style, animation, and arrowheads
   * (`../../catalog.ts`'s `EDGE_TYPES`). */
  edgeType: string;
  /** Optional label rendered at the edge midpoint. */
  label?: string;
  /** Optional tooltip annotation. */
  description?: string;
  /** Communication protocol hint (e.g. "http", "ws", "binding"). */
  protocol?: string;
}

/** Fields accepted by {@link updateEdge}. Every field is optional; an omitted field is left
 * unchanged on the existing edge. */
export interface EdgePatch {
  /** New edge type. */
  edgeType?: string;
  /** New label. */
  label?: string;
  /** New tooltip annotation. */
  description?: string;
  /** New communication protocol hint. */
  protocol?: string;
}

/** Read a graph's nodes as {@link GraphNode} values -- every stored node already has this shape,
 * guaranteed by `./validation.ts`'s canonicalization on every prior write. */
function nodesOf(graph: GraphData): GraphNode[] {
  return graph.nodes as GraphNode[];
}

/** Read a graph's edges as {@link GraphEdge} values, symmetric to {@link nodesOf}. */
function edgesOf(graph: GraphData): GraphEdge[] {
  return graph.edges as GraphEdge[];
}

/**
 * Append a new node to a graph.
 *
 * @param graph Current graph.
 * @param input Fields for the new node.
 * @returns A new graph with the node appended. `graph` itself is never mutated.
 */
export function addNode(graph: GraphData, input: AddNodeInput): GraphData {
  const node: GraphNode = {
    data: {
      description: input.description ?? "",
      label: input.label,
      typeId: input.typeId,
    },
    id: crypto.randomUUID(),
    position: input.position,
    type: CF_NODE_TYPE,
  };
  return { ...graph, nodes: [...graph.nodes, node] };
}

/**
 * Merge a partial patch into an existing node's `data` and/or `position`.
 *
 * @param graph Current graph.
 * @param nodeId Id of the node to update.
 * @param patch Fields to merge in; an omitted field is left unchanged.
 * @returns A new graph with the matching node replaced.
 * @throws {ProblemDetailsError} `notFound()` when no node with `nodeId` exists.
 */
export function updateNode(
  graph: GraphData,
  nodeId: string,
  patch: NodePatch,
): GraphData {
  const nodes = nodesOf(graph);
  const index = nodes.findIndex((node) => node.id === nodeId);
  if (index === -1) {
    throw notFound({ detail: `Node "${nodeId}" not found.` });
  }

  const existing = nodes[index] as GraphNode;
  const updated: GraphNode = {
    ...existing,
    data: {
      ...existing.data,
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description }
        : {}),
    },
    position: patch.position ?? existing.position,
  };

  const nextNodes = [...graph.nodes];
  nextNodes[index] = updated;
  return { ...graph, nodes: nextNodes };
}

/**
 * Remove a node, cascading removal of every edge whose `source`/`target` references it -- an
 * orphaned edge referencing a node that no longer exists is a worse failure mode than an
 * over-eager cascade.
 *
 * @param graph Current graph.
 * @param nodeId Id of the node to remove.
 * @returns A new graph with the node and every edge touching it removed.
 * @throws {ProblemDetailsError} `notFound()` when no node with `nodeId` exists.
 */
export function removeNode(graph: GraphData, nodeId: string): GraphData {
  const exists = nodesOf(graph).some((node) => node.id === nodeId);
  if (!exists) {
    throw notFound({ detail: `Node "${nodeId}" not found.` });
  }

  return {
    ...graph,
    edges: edgesOf(graph).filter(
      (edge) => edge.source !== nodeId && edge.target !== nodeId,
    ),
    nodes: nodesOf(graph).filter((node) => node.id !== nodeId),
  };
}

/**
 * Append a new edge between two existing nodes.
 *
 * @param graph Current graph.
 * @param input Fields for the new edge.
 * @returns A new graph with the edge appended.
 * @throws {ProblemDetailsError} `notFound()` when `source` or `target` does not reference an
 * existing node in `graph`.
 */
export function addEdge(graph: GraphData, input: AddEdgeInput): GraphData {
  const nodeIds = new Set(nodesOf(graph).map((node) => node.id));
  if (!nodeIds.has(input.source)) {
    throw notFound({ detail: `Node "${input.source}" not found.` });
  }
  if (!nodeIds.has(input.target)) {
    throw notFound({ detail: `Node "${input.target}" not found.` });
  }

  const edge: GraphEdge = {
    data: {
      edgeType: input.edgeType,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
    },
    id: crypto.randomUUID(),
    source: input.source,
    target: input.target,
    type: CF_EDGE_TYPE,
  };
  return { ...graph, edges: [...graph.edges, edge] };
}

/**
 * Merge a partial patch into an existing edge's `data`.
 *
 * @param graph Current graph.
 * @param edgeId Id of the edge to update.
 * @param patch Fields to merge in; an omitted field is left unchanged.
 * @returns A new graph with the matching edge replaced.
 * @throws {ProblemDetailsError} `notFound()` when no edge with `edgeId` exists.
 */
export function updateEdge(
  graph: GraphData,
  edgeId: string,
  patch: EdgePatch,
): GraphData {
  const edges = edgesOf(graph);
  const index = edges.findIndex((edge) => edge.id === edgeId);
  if (index === -1) {
    throw notFound({ detail: `Edge "${edgeId}" not found.` });
  }

  const existing = edges[index] as GraphEdge;
  const updated: GraphEdge = {
    ...existing,
    data: {
      ...existing.data,
      ...(patch.edgeType !== undefined ? { edgeType: patch.edgeType } : {}),
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description }
        : {}),
      ...(patch.protocol !== undefined ? { protocol: patch.protocol } : {}),
    },
  };

  const nextEdges = [...graph.edges];
  nextEdges[index] = updated;
  return { ...graph, edges: nextEdges };
}

/**
 * Remove an edge.
 *
 * @param graph Current graph.
 * @param edgeId Id of the edge to remove.
 * @returns A new graph with the edge removed.
 * @throws {ProblemDetailsError} `notFound()` when no edge with `edgeId` exists.
 */
export function removeEdge(graph: GraphData, edgeId: string): GraphData {
  const exists = edgesOf(graph).some((edge) => edge.id === edgeId);
  if (!exists) {
    throw notFound({ detail: `Edge "${edgeId}" not found.` });
  }
  return { ...graph, edges: edgesOf(graph).filter((e) => e.id !== edgeId) };
}

/** Horizontal spacing, in canvas units, between nodes on the same {@link autoLayout} row. */
const GRID_SPACING_X = 260;
/** Vertical spacing, in canvas units, between {@link autoLayout} rows. */
const GRID_SPACING_Y = 160;

/**
 * Rearrange every node in a graph onto a deterministic grid, ordered by a breadth-first
 * traversal of the graph's edges (root nodes -- those with no incoming edge -- on row 0, each
 * node's row equal to its shortest distance from a root; any node unreachable from a root, e.g.
 * one only ever the source of a cycle, is appended after the deepest row).
 *
 * **Not `elkjs`'s layered algorithm.** `elkjs` (this demo's client-side auto-layout button,
 * `../../client/components/editor/toolbar/Toolbar.tsx`) does not run inside `workerd` --
 * confirmed in Phase 11's spike (`spikes/07-architect-mcp-spike/REPORT.md`) -- so this function
 * is the documented, deterministic grid-placement fallback docs/09B-ARCHITECT-MCP.md's Shared
 * Graph Mutation Service names for the `auto_layout_diagram` MCP tool. It produces a visibly
 * simpler arrangement than the editor's own button; `../mcp/server.ts`'s tool description says so
 * plainly so a calling model never over-promises the result to the user.
 *
 * @param graph Current graph.
 * @returns A new graph with every node's `position` replaced; edges and viewport are unchanged.
 */
export function autoLayout(graph: GraphData): GraphData {
  const nodes = nodesOf(graph);
  const nodeIds = nodes.map((node) => node.id);
  const indexOfId = new Map(nodeIds.map((id, index) => [id, index]));
  const count = nodeIds.length;

  // Adjacency and in-degree, indexed by each node's position in `nodeIds` rather than keyed by
  // id -- every index is pre-populated with a real default (an empty array, zero), so every
  // later lookup below reads a value that is always actually present, never a "shouldn't happen"
  // fallback for a key that was never initialized.
  const outgoing: number[][] = nodeIds.map(() => []);
  const inDegree: number[] = nodeIds.map(() => 0);
  for (const edge of edgesOf(graph)) {
    const source = edge.source;
    const target = edge.target;
    if (source === undefined || target === undefined) continue;
    const sourceIndex = indexOfId.get(source);
    const targetIndex = indexOfId.get(target);
    // A dangling edge -- referencing a node id no longer present in `graph.nodes` -- is possible
    // if a caller hands this function an already-inconsistent graph; skip it rather than crash.
    if (sourceIndex === undefined || targetIndex === undefined) continue;
    outgoing[sourceIndex].push(targetIndex);
    inDegree[targetIndex] += 1;
  }

  // `-1` marks "not yet assigned a row." Every index ends up with a real, non-negative row by
  // the end of the fallback loop below, so nothing downstream ever reads a `-1`.
  const rowOfIndex: number[] = nodeIds.map(() => -1);
  const queue: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (inDegree[index] === 0) {
      rowOfIndex[index] = 0;
      queue.push(index);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    for (const next of outgoing[current]) {
      if (rowOfIndex[next] === -1) {
        rowOfIndex[next] = rowOfIndex[current] + 1;
        queue.push(next);
      }
    }
  }

  // Any index never reached above is only ever the source side of a cycle with no true root --
  // place it after the deepest row found so far, in original node order, rather than leaving it
  // unpositioned.
  let maxRow = 0;
  for (const row of rowOfIndex) maxRow = Math.max(maxRow, row);
  for (let index = 0; index < count; index += 1) {
    if (rowOfIndex[index] === -1) {
      maxRow += 1;
      rowOfIndex[index] = maxRow;
    }
  }

  const columnOfRow = new Map<number, number>();
  const positions = rowOfIndex.map((row) => {
    const column = columnOfRow.get(row) ?? 0;
    columnOfRow.set(row, column + 1);
    return { x: column * GRID_SPACING_X, y: row * GRID_SPACING_Y };
  });

  return {
    ...graph,
    nodes: nodes.map((node, index) => ({
      ...node,
      position: positions[index],
    })),
  };
}

/**
 * The wire vocabulary for one discrete graph mutation
 * (docs/09C-COLLABORATIVE-EDITING.md's Message Protocol) -- a discriminated union over the same
 * six operations this module already exposes as pure functions. Every caller that needs to
 * describe "one graph mutation" as a plain, JSON-serializable value (a client's outgoing
 * `operation` WebSocket frame, a `DiagramSession` broadcast's `operation_applied.op` field, an
 * MCP tool handler building the argument for `DiagramSession.applyOperation()`) uses this type
 * rather than inventing its own shape.
 */
export type GraphOperation =
  | { kind: "add_node"; input: AddNodeInput }
  | { kind: "update_node"; nodeId: string; patch: NodePatch }
  | { kind: "remove_node"; nodeId: string }
  | { kind: "add_edge"; input: AddEdgeInput }
  | { kind: "update_edge"; edgeId: string; patch: EdgePatch }
  | { kind: "remove_edge"; edgeId: string };

/**
 * The one code path every discrete graph mutation goes through
 * (docs/09C-COLLABORATIVE-EDITING.md's RPC Surface), whether it originates from a human's
 * WebSocket message, a 9B MCP tool call, or another connected client's own broadcast operation
 * applied locally by the browser. Dispatches to the matching pure function above based on
 * `op.kind`.
 *
 * @param graph Current graph.
 * @param op The operation to apply.
 * @returns A new graph with the operation applied. `graph` itself is never mutated.
 * @throws {ProblemDetailsError} `notFound()` when `op` targets a node/edge id that does not
 * exist in `graph` -- propagated unchanged from the underlying `updateNode()`/`removeNode()`/
 * `addEdge()`/`updateEdge()`/`removeEdge()` call; see each function's own JSDoc.
 */
export function applyGraphOperation(
  graph: GraphData,
  op: GraphOperation,
): GraphData {
  switch (op.kind) {
    case "add_node":
      return addNode(graph, op.input);
    case "update_node":
      return updateNode(graph, op.nodeId, op.patch);
    case "remove_node":
      return removeNode(graph, op.nodeId);
    case "add_edge":
      return addEdge(graph, op.input);
    case "update_edge":
      return updateEdge(graph, op.edgeId, op.patch);
    case "remove_edge":
      return removeEdge(graph, op.edgeId);
  }
}
