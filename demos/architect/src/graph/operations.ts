import type {
  ActorNodeData,
  ArchitectureEdge,
  ArchitectureNode,
  GraphDocument,
  GraphPoint,
  ProductNodeData,
} from "./types";

/**
 * The complete set of durable, revisioned edits `DiagramRoom` accepts.
 *
 * This is deliberately small but sufficient for a real editor:
 *
 * - `add_node` — place a new product or external-actor node (palette add).
 * - `update_node` — replace a node's editable data (the properties panel's label/description
 *   edit). Never changes position — see `move_node`.
 * - `move_node` — persist a node's final position. The client sends this only on drag end, per
 *   the Collaboration Protocol ("Persist only the final node position on drag end"), never on
 *   every intermediate drag frame.
 * - `delete_node` — remove a node and every edge connected to it.
 * - `add_edge` — connect two existing nodes with a typed, labeled edge.
 * - `delete_edge` — remove one edge.
 * - `replace_document` — atomically replace the entire document. Used today to apply a starter
 *   blueprint at diagram creation; Phase 5 reuses it unchanged for AI-proposal acceptance and
 *   Phase 6 for other whole-document replacements. Do not remove this kind even though nothing
 *   in Phase 2 other than blueprint application exercises it yet.
 */
export type OperationKind =
  | "add_node"
  | "update_node"
  | "move_node"
  | "delete_node"
  | "add_edge"
  | "delete_edge"
  | "replace_document";

/** Every currently supported operation kind, used to validate untrusted request bodies. */
export const OPERATION_KINDS: readonly OperationKind[] = [
  "add_node",
  "update_node",
  "move_node",
  "delete_node",
  "add_edge",
  "delete_edge",
  "replace_document",
];

/** Payload for {@link OperationKind} `"add_node"`. */
export interface AddNodePayload {
  /** Fully formed node to append. Its id must not already exist in the document. */
  node: ArchitectureNode;
}

/** Payload for {@link OperationKind} `"update_node"`. */
export interface UpdateNodePayload {
  /** Identifier of the node whose data is being replaced. */
  nodeId: string;
  /** Complete replacement data for the node (label/description, or actor label). */
  data: ProductNodeData | ActorNodeData;
}

/** Payload for {@link OperationKind} `"move_node"`. */
export interface MoveNodePayload {
  /** Identifier of the node being moved. */
  nodeId: string;
  /** Final graph-space position after a completed drag. */
  position: GraphPoint;
}

/** Payload for {@link OperationKind} `"delete_node"`. */
export interface DeleteNodePayload {
  /** Identifier of the node to remove, along with every edge touching it. */
  nodeId: string;
}

/** Payload for {@link OperationKind} `"add_edge"`. */
export interface AddEdgePayload {
  /** Fully formed edge to append. Its id must not already exist in the document. */
  edge: ArchitectureEdge;
}

/** Payload for {@link OperationKind} `"delete_edge"`. */
export interface DeleteEdgePayload {
  /** Identifier of the edge to remove. */
  edgeId: string;
}

/** Payload for {@link OperationKind} `"replace_document"`. */
export interface ReplaceDocumentPayload {
  /** Complete replacement document, validated by {@link import("./validation").validateGraphDocument} before persisting. */
  document: GraphDocument;
}

/** A discriminated operation: exactly one {@link OperationKind} paired with its typed payload. */
export type DiagramOperation =
  | { kind: "add_node"; payload: AddNodePayload }
  | { kind: "update_node"; payload: UpdateNodePayload }
  | { kind: "move_node"; payload: MoveNodePayload }
  | { kind: "delete_node"; payload: DeleteNodePayload }
  | { kind: "add_edge"; payload: AddEdgePayload }
  | { kind: "delete_edge"; payload: DeleteEdgePayload }
  | { kind: "replace_document"; payload: ReplaceDocumentPayload };

/**
 * The full envelope `DiagramRoom.applyOperation` accepts: a {@link DiagramOperation} plus the
 * idempotency/optimistic-concurrency fields from the Collaboration Protocol.
 */
export type DurableOperation = DiagramOperation & {
  /** Client-generated idempotency key. Retrying the same key is always harmless. */
  operationId: string;
  /** Revision the client believes is current. A mismatch causes a `stale` result. */
  baseRevision: number;
};

/**
 * Thrown when an operation cannot be applied to a specific document — a referenced node or edge
 * does not exist, or an id collides with one already present. Distinct from
 * {@link import("./validation").GraphValidationError}, which instead reports that a *whole
 * document* (the result of applying an operation, or a `replace_document` payload) fails the
 * shared graph contract.
 */
export class GraphOperationError extends Error {}

function fail(message: string): never {
  throw new GraphOperationError(message);
}

/**
 * Apply one {@link DiagramOperation} to a document, returning a new candidate document.
 *
 * This function performs only the operation's own mechanical edit (append, replace, filter) and
 * the minimal existence/collision checks needed to perform it â€” it deliberately does not
 * duplicate the full shape/catalog/reference checks {@link import("./validation").validateGraphDocument}
 * already performs. Every caller must validate the returned candidate with
 * `validateGraphDocument` before persisting it, so a structurally-valid-but-nonsensical result
 * (for example a `replace_document` payload with dangling edges) is still rejected.
 *
 * @param document Current authoritative document.
 * @param operation Operation to apply.
 * @returns A new candidate document. The input `document` is never mutated.
 * @throws {GraphOperationError} When the operation references a node/edge that does not exist,
 * or collides with an id that already exists.
 */
export function applyGraphOperation(
  document: GraphDocument,
  operation: DiagramOperation,
): GraphDocument {
  switch (operation.kind) {
    case "add_node": {
      const { node } = operation.payload;
      if (document.nodes.some((candidate) => candidate.id === node.id)) {
        fail(`Node ${node.id} already exists.`);
      }
      return { ...document, nodes: [...document.nodes, node] };
    }
    case "update_node": {
      const { nodeId, data } = operation.payload;
      const index = document.nodes.findIndex((node) => node.id === nodeId);
      if (index === -1) {
        fail(`Node ${nodeId} does not exist.`);
      }
      const nodes = document.nodes.slice();
      nodes[index] = { ...nodes[index], data };
      return { ...document, nodes };
    }
    case "move_node": {
      const { nodeId, position } = operation.payload;
      const index = document.nodes.findIndex((node) => node.id === nodeId);
      if (index === -1) {
        fail(`Node ${nodeId} does not exist.`);
      }
      const nodes = document.nodes.slice();
      nodes[index] = { ...nodes[index], position };
      return { ...document, nodes };
    }
    case "delete_node": {
      const { nodeId } = operation.payload;
      if (!document.nodes.some((node) => node.id === nodeId)) {
        fail(`Node ${nodeId} does not exist.`);
      }
      return {
        ...document,
        nodes: document.nodes.filter((node) => node.id !== nodeId),
        edges: document.edges.filter(
          (edge) => edge.source !== nodeId && edge.target !== nodeId,
        ),
      };
    }
    case "add_edge": {
      const { edge } = operation.payload;
      if (document.edges.some((candidate) => candidate.id === edge.id)) {
        fail(`Edge ${edge.id} already exists.`);
      }
      return { ...document, edges: [...document.edges, edge] };
    }
    case "delete_edge": {
      const { edgeId } = operation.payload;
      if (!document.edges.some((edge) => edge.id === edgeId)) {
        fail(`Edge ${edgeId} does not exist.`);
      }
      return {
        ...document,
        edges: document.edges.filter((edge) => edge.id !== edgeId),
      };
    }
    case "replace_document": {
      return structuredClone(operation.payload.document);
    }
    default: {
      // Exhaustiveness guard: a new OperationKind added to the union without a case here is a
      // compile-time error at this line, not a silent runtime no-op.
      const exhaustive: never = operation;
      throw new GraphOperationError(
        `Unsupported operation kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}
