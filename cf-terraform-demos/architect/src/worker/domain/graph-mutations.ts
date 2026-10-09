import { badRequest, notFound } from '@adrianhall/cloudflare-toolkit/errors';
import { CF_EDGE_TYPE, CF_NODE_TYPE } from '../../graph-element-types.ts';
import type { GraphData } from './graph.ts';

/**
 * @file Granular, pure mutations over the canonical {@link GraphData} shape — the vocabulary the
 *   MCP graph tools are built from. Every function takes a graph and returns a new one, never
 *   mutating its argument, and none of them knows anything about D1, a binding, a request or MCP.
 *   That is what makes them unit-testable against a fixture graph with no runtime at all, and it is
 *   why they live in `domain/` beside the validation in `./graph.ts` rather than in the application
 *   or infrastructure tiers. These functions deliberately do **not** re-canonicalise. A caller
 *   applies one mutation and then passes the result through `canonicalizeGraphData` (`./graph.ts`),
 *   so there is exactly one definition of what a storable graph looks like and these functions
 *   cannot drift from it. Both steps happen together inside the live session's synchronous mutation
 *   region (`../infrastructure/diagram-session.ts`), reached through the operation vocabulary in
 *   `./graph-operations.ts` — which names each of these functions as a value, because a closure
 *   cannot cross the Durable Object RPC boundary every write now takes. The browser has no granular
 *   write path and does not import this module: the editor still autosaves the complete graph,
 *   exactly as it did before live sync existed. Only an agent needs to say "add one node", which is
 *   the whole reason this vocabulary exists on the server at all.
 */

/**
 * One React Flow node as this module reads and writes it.
 *
 * Only the fields these functions actually touch are named. Every other field a real canvas node
 * carries — `selected`, `dragging`, `measured`, and anything the client adds later — survives
 * untouched through object spread, which is the same tolerance `./graph.ts`'s deliberately shallow
 * validation provides: the node vocabulary belongs to the editor, not to the server.
 */
interface GraphNode extends Record<string, unknown> {
  /**
   * Unique node id, the one property the server itself relies on.
   */
  id: string;
  /**
   * React Flow renderer key. Always {@link CF_NODE_TYPE} on a node this module constructs.
   */
  type?: string;
  /**
   * Canvas position in flow coordinates.
   */
  position?: { x: number; y: number };
  /**
   * Node data payload — `typeId`, `label`, `description`.
   */
  data?: Record<string, unknown>;
}

/**
 * One React Flow edge as this module reads and writes it, symmetric to {@link GraphNode}.
 */
interface GraphEdge extends Record<string, unknown> {
  /**
   * Unique edge id.
   */
  id: string;
  /**
   * React Flow renderer key. Always {@link CF_EDGE_TYPE} on an edge this module constructs.
   */
  type?: string;
  /**
   * Id of the node this edge starts from.
   */
  source?: string;
  /**
   * Id of the node this edge ends at.
   */
  target?: string;
  /**
   * Edge data payload — `edgeType`, `label`, `description`, `protocol`.
   */
  data?: Record<string, unknown>;
}

/**
 * Fields accepted by {@link addNode}.
 */
export interface AddNodeInput {
  /**
   * Id to give the new node, or omitted to have one minted.
   *
   * Accepting a caller-chosen id is what makes a two-step agent interaction workable: a model can
   * add a node under a name it chose and reference that same name in the very next `add_edge` call,
   * instead of having to parse the returned graph to discover a minted UUID. A duplicate is
   * rejected rather than silently merged, because two nodes sharing an id is a graph React Flow
   * cannot render and every later operation addressing that id would be ambiguous.
   */
  id?: string;
  /**
   * Catalogue product type identifier, for example `'worker'` or `'d1'`, resolved by the client
   * against `../../catalog.ts` for the node's icon, colour and handles.
   */
  typeId: string;
  /**
   * Display label shown on the node.
   */
  label: string;
  /**
   * Optional free-text annotation shown below the label.
   */
  description?: string;
  /**
   * Canvas position for the new node, in flow coordinates.
   */
  position: { x: number; y: number };
  /**
   * Optional visual overrides stored in the node's data payload, for example the editor's accent
   * colour. Kept as JSON fields rather than a UI-specific type because the domain stores them
   * verbatim and does not interpret their meaning.
   */
  style?: Record<string, unknown>;
}

/**
 * Fields accepted by {@link updateNode}. Every field is optional; an omitted field leaves the
 * existing value alone, which is what makes a partial rename possible without resending a
 * position.
 */
export interface NodePatch {
  /**
   * New display label.
   */
  label?: string;
  /**
   * New free-text annotation.
   */
  description?: string;
  /**
   * New canvas position.
   */
  position?: { x: number; y: number };
  /**
   * New visual overrides. An omitted field leaves the existing value alone.
   */
  style?: Record<string, unknown>;
}

/**
 * Fields accepted by {@link addEdge}.
 */
export interface AddEdgeInput {
  /**
   * Id to give the new edge, or omitted to have one minted. Caller-chosen for the same reason
   * {@link AddNodeInput.id} documents.
   */
  id?: string;
  /**
   * Id of an existing node this edge starts from.
   */
  source: string;
  /**
   * Id of an existing node this edge ends at.
   */
  target: string;
  /**
   * Visual and semantic edge type controlling stroke style, animation and arrowheads, resolved by
   * the client against `../../catalog.ts`'s `EDGE_TYPE_MAP`.
   */
  edgeType: string;
  /**
   * Optional label rendered at the edge midpoint.
   */
  label?: string;
  /**
   * Optional tooltip annotation.
   */
  description?: string;
  /**
   * Optional communication protocol hint, for example `'http'` or `'binding'`.
   */
  protocol?: string;
  /**
   * Optional React Flow handle on the source node. The editor chooses handles from geometry, and
   * preserving them is what makes an operation render the same connection every recipient saw.
   */
  sourceHandle?: string | null;
  /**
   * Optional React Flow handle on the target node, symmetric to {@link sourceHandle}.
   */
  targetHandle?: string | null;
}

/**
 * Fields accepted by {@link updateEdge}. Every field is optional, with the same partial-patch
 * meaning {@link NodePatch} has.
 */
export interface EdgePatch {
  /**
   * New edge type.
   */
  edgeType?: string;
  /**
   * New label.
   */
  label?: string;
  /**
   * New tooltip annotation.
   */
  description?: string;
  /**
   * New communication protocol hint.
   */
  protocol?: string;
}

/**
 * Reads a graph's nodes in this module's working shape.
 *
 * The cast is sound because every stored graph has already passed `canonicalizeGraphData`
 * (`./graph.ts`), which guarantees each element is an object with a non-empty string `id` — exactly
 * the one field {@link GraphNode} adds beyond `Record<string, unknown>`.
 *
 * @param graph Graph to read.
 * @returns The graph's nodes.
 */
function nodesOf(graph: GraphData): GraphNode[] {
  return graph.nodes as GraphNode[];
}

/**
 * Reads a graph's edges in this module's working shape, symmetric to {@link nodesOf}.
 *
 * @param graph Graph to read.
 * @returns The graph's edges.
 */
function edgesOf(graph: GraphData): GraphEdge[] {
  return graph.edges as GraphEdge[];
}

/**
 * Appends a node to a graph.
 *
 * @param graph Current graph.
 * @param input Fields for the new node; see {@link AddNodeInput}.
 * @returns A new graph with the node appended. `graph` itself is never mutated.
 * @throws {ProblemDetailsError} `badRequest()` (400) when `input.id` is already taken by another
 *   node in this graph.
 */
export function addNode(graph: GraphData, input: AddNodeInput): GraphData {
  if (input.id !== undefined && nodesOf(graph).some((node) => node.id === input.id)) {
    throw badRequest({ detail: `A node with id "${input.id}" already exists.` });
  }

  const node: GraphNode = {
    data: {
      description: input.description ?? '',
      label: input.label,
      ...(input.style === undefined ? {} : { style: input.style }),
      typeId: input.typeId
    },
    id: input.id ?? crypto.randomUUID(),
    position: input.position,
    // Stamped from the shared constant rather than a re-typed literal. A node stored with any
    // other `type` persists perfectly and then renders as React Flow's unstyled default — a
    // failure that looks like a styling bug and is really a vocabulary mismatch.
    type: CF_NODE_TYPE
  };

  return { ...graph, nodes: [...graph.nodes, node] };
}

/**
 * Merges a partial patch into one node's `data` and/or `position`.
 *
 * @param graph Current graph.
 * @param nodeId Id of the node to change.
 * @param patch Fields to merge; an omitted field is left exactly as it was.
 * @returns A new graph with the matching node replaced, in its original position in the array so
 *   render order does not shift under an edit.
 * @throws {ProblemDetailsError} `notFound()` (404) when no node in this graph has `nodeId`.
 */
export function updateNode(graph: GraphData, nodeId: string, patch: NodePatch): GraphData {
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
      ...(patch.label === undefined ? {} : { label: patch.label }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.style === undefined ? {} : { style: patch.style })
    },
    position: patch.position ?? existing.position
  };

  const nextNodes = [...graph.nodes];
  nextNodes[index] = updated;
  return { ...graph, nodes: nextNodes };
}

/**
 * Removes a node, cascading removal of every edge that references it.
 *
 * The cascade is the point rather than a convenience. An edge whose `source` or `target` names a
 * node that no longer exists is a worse failure mode than an over-eager removal: React Flow drops
 * it silently, a later export writes a connection to nothing, and nobody is told. Removing them
 * here means the stored graph is always internally consistent.
 *
 * @param graph Current graph.
 * @param nodeId Id of the node to remove.
 * @returns A new graph without the node or any edge touching it.
 * @throws {ProblemDetailsError} `notFound()` (404) when no node in this graph has `nodeId`.
 */
export function removeNode(graph: GraphData, nodeId: string): GraphData {
  if (!nodesOf(graph).some((node) => node.id === nodeId)) {
    throw notFound({ detail: `Node "${nodeId}" not found.` });
  }

  return {
    ...graph,
    edges: edgesOf(graph).filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
    nodes: nodesOf(graph).filter((node) => node.id !== nodeId)
  };
}

/**
 * Appends an edge between two existing nodes.
 *
 * Both endpoints are checked before anything is built, so a mistyped node id produces a refusal
 * rather than the dangling edge {@link removeNode} works to prevent.
 *
 * @param graph Current graph.
 * @param input Fields for the new edge; see {@link AddEdgeInput}.
 * @returns A new graph with the edge appended.
 * @throws {ProblemDetailsError} `badRequest()` (400) when `input.id` is already taken by another
 *   edge, and `notFound()` (404) when `input.source` or `input.target` names no node in this
 *   graph.
 */
export function addEdge(graph: GraphData, input: AddEdgeInput): GraphData {
  if (input.id !== undefined && edgesOf(graph).some((edge) => edge.id === input.id)) {
    throw badRequest({ detail: `An edge with id "${input.id}" already exists.` });
  }

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
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.protocol === undefined ? {} : { protocol: input.protocol })
    },
    id: input.id ?? crypto.randomUUID(),
    source: input.source,
    ...(input.sourceHandle === undefined ? {} : { sourceHandle: input.sourceHandle }),
    target: input.target,
    ...(input.targetHandle === undefined ? {} : { targetHandle: input.targetHandle }),
    type: CF_EDGE_TYPE
  };

  return { ...graph, edges: [...graph.edges, edge] };
}

/**
 * Merges a partial patch into one edge's `data`.
 *
 * @param graph Current graph.
 * @param edgeId Id of the edge to change.
 * @param patch Fields to merge; an omitted field is left exactly as it was.
 * @returns A new graph with the matching edge replaced, in its original array position.
 * @throws {ProblemDetailsError} `notFound()` (404) when no edge in this graph has `edgeId`.
 */
export function updateEdge(graph: GraphData, edgeId: string, patch: EdgePatch): GraphData {
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
      ...(patch.edgeType === undefined ? {} : { edgeType: patch.edgeType }),
      ...(patch.label === undefined ? {} : { label: patch.label }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.protocol === undefined ? {} : { protocol: patch.protocol })
    }
  };

  const nextEdges = [...graph.edges];
  nextEdges[index] = updated;
  return { ...graph, edges: nextEdges };
}

/**
 * Removes an edge, leaving both of its nodes in place.
 *
 * The asymmetry with {@link removeNode} is deliberate: an edge is a relationship, so deleting it
 * says nothing about whether the things it related should still exist.
 *
 * @param graph Current graph.
 * @param edgeId Id of the edge to remove.
 * @returns A new graph without that edge.
 * @throws {ProblemDetailsError} `notFound()` (404) when no edge in this graph has `edgeId`.
 */
export function removeEdge(graph: GraphData, edgeId: string): GraphData {
  if (!edgesOf(graph).some((edge) => edge.id === edgeId)) {
    throw notFound({ detail: `Edge "${edgeId}" not found.` });
  }

  return { ...graph, edges: edgesOf(graph).filter((edge) => edge.id !== edgeId) };
}

/**
 * Horizontal spacing, in flow units, between two nodes on the same {@link autoLayout} row.
 */
const GRID_SPACING_X = 260;

/**
 * Vertical spacing, in flow units, between {@link autoLayout} rows.
 */
const GRID_SPACING_Y = 160;

/**
 * Rearranges every node onto a deterministic grid, ordered by a breadth-first traversal of the
 * graph's edges.
 *
 * A node with no incoming edge is a root and sits on row 0; every other reachable node sits on the
 * row matching its shortest distance from a root; and a node reachable only within a cycle — so
 * never dequeued by the traversal — is appended below the deepest row rather than left
 * unpositioned. Within a row, nodes keep their original relative order, so running the layout twice
 * on the same graph produces the identical result. Determinism is what makes this testable at all:
 * a layout that depended on iteration order could only be reviewed by eye.
 *
 * **This is not ELK.** The editor's own **Auto layout** button runs `elkjs` in the browser and
 * produces a genuinely layered drawing. `elkjs` does not run in `workerd` — re-confirmed
 * empirically in the Phase 11 spike, where `new ELK()` throws `TypeError: _Worker is not a
 * constructor` and the explicit worker entry point resolves to an empty module — so a server-side
 * caller gets this grid instead. The `auto_layout_diagram` tool description says so plainly, so a
 * model does not promise a user a quality of layout this function cannot deliver.
 *
 * @param graph Current graph.
 * @returns A new graph with every node's `position` replaced. Edges and viewport are untouched: a
 *   re-layout changes where things are drawn, not what is connected or where the user is looking.
 */
export function autoLayout(graph: GraphData): GraphData {
  const nodes = nodesOf(graph);
  const nodeIds = nodes.map((node) => node.id);
  const indexOfId = new Map(nodeIds.map((id, index) => [id, index]));
  const count = nodeIds.length;

  // Adjacency and in-degree are indexed by each node's position in `nodeIds` rather than keyed by
  // id. Every index is pre-populated with a real default, so each lookup below reads a value that
  // genuinely exists instead of a "cannot happen" fallback for a key nothing initialised.
  const outgoing: number[][] = nodeIds.map(() => []);
  const inDegree: number[] = nodeIds.map(() => 0);
  for (const edge of edgesOf(graph)) {
    const sourceIndex = edge.source === undefined ? undefined : indexOfId.get(edge.source);
    const targetIndex = edge.target === undefined ? undefined : indexOfId.get(edge.target);
    // A dangling edge cannot be produced by this module — `removeNode` cascades and `addEdge`
    // validates — but a graph can also arrive from an older write, so it is skipped rather than
    // allowed to throw during what is only a cosmetic rearrangement.
    if (sourceIndex === undefined || targetIndex === undefined) {
      continue;
    }
    outgoing[sourceIndex].push(targetIndex);
    inDegree[targetIndex] += 1;
  }

  // `-1` marks "no row assigned yet". The fallback loop below gives every remaining index a real
  // row, so nothing downstream can read one.
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

  // Anything the traversal never reached is inside a cycle with no root. Placing each one on a new
  // row below everything else keeps them visible and keeps the result a function of the input.
  let maxRow = 0;
  for (const row of rowOfIndex) {
    maxRow = Math.max(maxRow, row);
  }
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

  return { ...graph, nodes: nodes.map((node, index) => ({ ...node, position: positions[index] })) };
}
