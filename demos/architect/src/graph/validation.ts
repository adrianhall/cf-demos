import { catalogProductIds } from "./catalog";
import type {
  ActorNodeData,
  ArchitectureEdge,
  ArchitectureNode,
  GraphDocument,
  ProductId,
  ProductNodeData,
} from "./types";

const NODE_TYPES = new Set(["product", "actor"]);
const EDGE_TYPES = new Set(["request", "event"]);
const RELATIONSHIPS = new Set(["request", "event"]);

/**
 * Thrown when a candidate value does not satisfy the `GraphDocument` contract: shape, unique
 * node/edge identifiers, a known curated product, or an edge that references real, distinct
 * nodes. Every route and Durable Object method that persists a graph document must validate it
 * with {@link validateGraphDocument} first and translate this into a client-visible `422`/typed
 * rejection rather than persisting invalid state.
 */
export class GraphValidationError extends Error {}

function fail(message: string): never {
  throw new GraphValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPosition(value: unknown): value is { x: number; y: number } {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function isViewport(
  value: unknown,
): value is { x: number; y: number; zoom: number } {
  return (
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.zoom)
  );
}

/**
 * Validate one candidate product node's data, including catalog membership.
 *
 * @param nodeId Owning node identifier, used only to build a clear error message.
 * @param value Candidate `data` value.
 * @returns Validated product-node data.
 * @throws {GraphValidationError} When the shape is wrong or the product is not curated.
 */
function validateProductNodeData(
  nodeId: string,
  value: unknown,
): ProductNodeData {
  if (!isRecord(value)) {
    fail(`Node ${nodeId} must have an object data payload.`);
  }
  const { productId, label, description } = value;
  if (typeof productId !== "string" || !catalogProductIds.has(productId)) {
    fail(`Node ${nodeId} references an unknown catalog product.`);
  }
  if (!isNonEmptyString(label)) {
    fail(`Node ${nodeId} must have a non-empty label.`);
  }
  if (typeof description !== "string") {
    fail(`Node ${nodeId} must have a string description.`);
  }
  return { productId: productId as ProductId, label, description };
}

/**
 * Validate one candidate external-actor node's data.
 *
 * @param nodeId Owning node identifier, used only to build a clear error message.
 * @param value Candidate `data` value.
 * @returns Validated actor-node data.
 * @throws {GraphValidationError} When the shape is wrong.
 */
function validateActorNodeData(nodeId: string, value: unknown): ActorNodeData {
  if (!isRecord(value)) {
    fail(`Node ${nodeId} must have an object data payload.`);
  }
  const { label, kind } = value;
  if (kind !== "external-actor") {
    fail(`Node ${nodeId} must have kind "external-actor".`);
  }
  if (!isNonEmptyString(label)) {
    fail(`Node ${nodeId} must have a non-empty label.`);
  }
  return { label, kind };
}

/**
 * Validate one candidate node, dispatching to the product or actor data validator.
 *
 * @param value Candidate node value.
 * @returns Validated architecture node.
 * @throws {GraphValidationError} When the node's shape, type, position, or data is invalid.
 */
function validateNode(value: unknown): ArchitectureNode {
  if (!isRecord(value)) {
    fail("Every node must be an object.");
  }
  const { id, type, position, data } = value;
  if (!isNonEmptyString(id)) {
    fail("Every node must have a non-empty string id.");
  }
  if (typeof type !== "string" || !NODE_TYPES.has(type)) {
    fail(`Node ${id} has an unsupported type.`);
  }
  if (!isPosition(position)) {
    fail(`Node ${id} has an invalid position.`);
  }
  if (type === "product") {
    return {
      id,
      type: "product",
      position,
      data: validateProductNodeData(id, data),
    };
  }
  return {
    id,
    type: "actor",
    position,
    data: validateActorNodeData(id, data),
  };
}

/**
 * Validate one candidate edge's typed relationship metadata.
 *
 * @param edgeId Owning edge identifier, used only to build a clear error message.
 * @param value Candidate `data` value.
 * @returns Validated edge data.
 * @throws {GraphValidationError} When the shape is wrong.
 */
function validateEdgeData(
  edgeId: string,
  value: unknown,
): { relationship: "request" | "event"; label: string } {
  if (!isRecord(value)) {
    fail(`Edge ${edgeId} must have an object data payload.`);
  }
  const { relationship, label } = value;
  if (typeof relationship !== "string" || !RELATIONSHIPS.has(relationship)) {
    fail(`Edge ${edgeId} has an unsupported relationship.`);
  }
  if (!isNonEmptyString(label)) {
    fail(`Edge ${edgeId} must have a non-empty label.`);
  }
  return { relationship: relationship as "request" | "event", label };
}

/**
 * Validate one candidate edge's shape, independent of whether its endpoints exist — endpoint
 * existence is checked once, document-wide, by {@link validateGraphDocument}.
 *
 * @param value Candidate edge value.
 * @returns Validated architecture edge.
 * @throws {GraphValidationError} When the edge's shape or type is invalid.
 */
function validateEdgeShape(value: unknown): ArchitectureEdge {
  if (!isRecord(value)) {
    fail("Every edge must be an object.");
  }
  const { id, source, target, type, data } = value;
  if (!isNonEmptyString(id)) {
    fail("Every edge must have a non-empty string id.");
  }
  if (!isNonEmptyString(source) || !isNonEmptyString(target)) {
    fail(`Edge ${id} must have string source and target node ids.`);
  }
  if (typeof type !== "string" || !EDGE_TYPES.has(type)) {
    fail(`Edge ${id} has an unsupported type.`);
  }
  return {
    id,
    source,
    target,
    type: type as "request" | "event",
    data: validateEdgeData(id, data),
  };
}

/**
 * Validate an untrusted candidate value against the full `GraphDocument` contract: version,
 * node/edge shape, curated product membership, unique node/edge identifiers, and edges that
 * reference two distinct, existing nodes.
 *
 * Every operation that would persist a document — including `replace_document` and the result of
 * applying any other operation kind (see `operations.ts`) — must pass its candidate result through
 * this function before it reaches `DiagramRoom`'s SQLite storage.
 *
 * @param value Untrusted candidate graph document.
 * @returns The same document, narrowed to {@link GraphDocument}.
 * @throws {GraphValidationError} When any part of the contract is violated.
 */
export function validateGraphDocument(value: unknown): GraphDocument {
  if (!isRecord(value)) {
    fail("A graph document must be an object.");
  }
  if (value.version !== 1) {
    fail("Only graph document version 1 is supported.");
  }
  if (!Array.isArray(value.nodes)) {
    fail("nodes must be an array.");
  }
  if (!Array.isArray(value.edges)) {
    fail("edges must be an array.");
  }
  if (!isViewport(value.viewport)) {
    fail("viewport must be a numeric x/y/zoom object.");
  }

  const nodes = value.nodes.map(validateNode);
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) {
      fail(`Duplicate node id: ${node.id}`);
    }
    nodeIds.add(node.id);
  }

  const edges = value.edges.map(validateEdgeShape);
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) {
      fail(`Duplicate edge id: ${edge.id}`);
    }
    edgeIds.add(edge.id);
    if (edge.source === edge.target) {
      fail(`Edge ${edge.id} cannot connect a node to itself.`);
    }
    if (!nodeIds.has(edge.source)) {
      fail(`Edge ${edge.id} references unknown source node ${edge.source}.`);
    }
    if (!nodeIds.has(edge.target)) {
      fail(`Edge ${edge.id} references unknown target node ${edge.target}.`);
    }
  }

  return { version: 1, nodes, edges, viewport: value.viewport };
}
