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
} from './graph-mutations.ts';
import type { GraphData } from './graph.ts';

/**
 * @file The granular graph operations as **values** rather than functions — the vocabulary every
 *   write path now speaks. `./graph-mutations.ts` already holds the pure functions; this module
 *   names each of them as a plain data object and provides the one interpreter that turns such an
 *   object back into a call. The indirection is not decoration, and it is not taste. Until this
 *   phase, the application tier took a `GraphMutation` **closure** and applied it next to the
 *   repository. A closure cannot cross a Durable Object RPC boundary: arguments are
 *   structured-cloned, and a function is not cloneable, so passing one fails at runtime with
 *   `DataCloneError`. Now that every write is serialized through the session object, the thing
 *   describing a write has to be something that can travel to it — which means a value. The second
 *   benefit falls out of the first. An operation that is data can be logged, compared, echoed back
 *   to the originator and, in the next sub-phase, sent over the wire by a browser, without any of
 *   those surfaces growing their own idea of what "add a node" means. There is one vocabulary,
 *   declared here, and one interpreter, {@link applyGraphOperation}. Nothing in this module knows
 *   about D1, a binding, a request, MCP or a socket. It is pure, so the whole vocabulary is
 *   unit-testable against a fixture graph with no runtime at all.
 */

/**
 * Appends a node to the graph.
 */
export interface AddNodeOperation {
  /**
   * Discriminator identifying this operation.
   */
  kind: 'add_node';
  /**
   * Fields for the new node; see `AddNodeInput` in `./graph-mutations.ts`.
   */
  input: AddNodeInput;
}

/**
 * Merges a partial patch into one node.
 */
export interface UpdateNodeOperation {
  /**
   * Discriminator identifying this operation.
   */
  kind: 'update_node';
  /**
   * Id of the node to change.
   */
  nodeId: string;
  /**
   * Fields to merge; an omitted field is left exactly as it was.
   */
  patch: NodePatch;
}

/**
 * Removes a node, cascading removal of every edge that references it.
 */
export interface RemoveNodeOperation {
  /**
   * Discriminator identifying this operation.
   */
  kind: 'remove_node';
  /**
   * Id of the node to remove.
   */
  nodeId: string;
}

/**
 * Appends an edge between two existing nodes.
 */
export interface AddEdgeOperation {
  /**
   * Discriminator identifying this operation.
   */
  kind: 'add_edge';
  /**
   * Fields for the new edge; see `AddEdgeInput` in `./graph-mutations.ts`.
   */
  input: AddEdgeInput;
}

/**
 * Merges a partial patch into one edge.
 */
export interface UpdateEdgeOperation {
  /**
   * Discriminator identifying this operation.
   */
  kind: 'update_edge';
  /**
   * Id of the edge to change.
   */
  edgeId: string;
  /**
   * Fields to merge; an omitted field is left exactly as it was.
   */
  patch: EdgePatch;
}

/**
 * Removes an edge, leaving both of its nodes in place.
 */
export interface RemoveEdgeOperation {
  /**
   * Discriminator identifying this operation.
   */
  kind: 'remove_edge';
  /**
   * Id of the edge to remove.
   */
  edgeId: string;
}

/**
 * Rearranges every node onto a deterministic grid.
 *
 * It carries no payload, because it is a function of the current graph and nothing else. Declaring
 * it as an operation anyway — rather than treating a re-layout as a whole-graph replacement — is
 * what keeps it on the same serialized write path as every other change.
 */
export interface AutoLayoutOperation {
  /**
   * Discriminator identifying this operation.
   */
  kind: 'auto_layout';
}

/**
 * Every granular change that can be made to a diagram's graph.
 *
 * A discriminated union, so {@link applyGraphOperation}'s `switch` is exhaustiveness-checked: an
 * operation added here fails the build until the interpreter handles it, rather than falling
 * through at runtime to a graph that silently did not change.
 */
export type GraphOperation =
  | AddNodeOperation
  | UpdateNodeOperation
  | RemoveNodeOperation
  | AddEdgeOperation
  | UpdateEdgeOperation
  | RemoveEdgeOperation
  | AutoLayoutOperation;

/**
 * Short label naming an operation, as the structured logs record it.
 *
 * Derived from the union rather than restated, so a new operation cannot be logged under a name
 * nothing else in the system uses.
 */
export type GraphOperationKind = GraphOperation['kind'];

/**
 * Applies one operation to a graph, returning a new graph.
 *
 * The one interpreter for the whole vocabulary. Every branch delegates to the matching pure
 * function in `./graph-mutations.ts` rather than reimplementing it, so an operation and the
 * function it names cannot drift apart.
 *
 * Deliberately does **not** re-canonicalise, for the same reason the functions it calls do not: a
 * caller applies one operation and then passes the result through `canonicalizeGraphData`
 * (`./graph.ts`), so there is exactly one definition of what a storable graph looks like. The
 * session does both steps together, inside its synchronous mutation region.
 *
 * @param graph Current graph.
 * @param operation The single operation to apply.
 * @returns A new graph with the operation applied. `graph` itself is never mutated.
 * @throws {ProblemDetailsError} `notFound()` (404) when the operation names a node or edge the
 *   graph does not contain — the stale-target case, which is ordinary under concurrent editing
 *   rather than exceptional — and `badRequest()` (400) when it supplies an element id already in
 *   use. Each refusal comes from the underlying function in `./graph-mutations.ts`, so the status a
 *   caller sees does not depend on which transport asked.
 */
export function applyGraphOperation(graph: GraphData, operation: GraphOperation): GraphData {
  // Assigned in the switch and returned once, rather than returning from each branch. That is not
  // a style preference: it is what makes a missing case a *compile* error. TypeScript's
  // definite-assignment analysis understands an exhaustive switch over a discriminated union, so
  // adding a member to `GraphOperation` without handling it here fails the build with "used
  // before being assigned" — which is exactly the guarantee this interpreter needs, since the
  // alternative is an operation that silently returns an unchanged graph and reports success.
  let result: GraphData;

  switch (operation.kind) {
    case 'add_node':
      result = addNode(graph, operation.input);
      break;
    case 'update_node':
      result = updateNode(graph, operation.nodeId, operation.patch);
      break;
    case 'remove_node':
      result = removeNode(graph, operation.nodeId);
      break;
    case 'add_edge':
      result = addEdge(graph, operation.input);
      break;
    case 'update_edge':
      result = updateEdge(graph, operation.edgeId, operation.patch);
      break;
    case 'remove_edge':
      result = removeEdge(graph, operation.edgeId);
      break;
    case 'auto_layout':
      result = autoLayout(graph);
      break;
  }

  return result;
}
