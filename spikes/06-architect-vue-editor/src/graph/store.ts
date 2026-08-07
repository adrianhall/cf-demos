import type { ViewportTransform } from "@vue-flow/core";
import { getProduct } from "./catalog";
import type { ArchitectureEdge, ArchitectureNode, GraphDocument, GraphPoint, ProductId } from "./types";

/** Local-storage key used only by this disposable spike. */
export const graphStorageKey = "architect-editor-spike-06";

/** The seeded architecture establishes the actor, two edge types, and a product node. */
export const initialGraph: GraphDocument = {
  version: 1,
  nodes: [
    { id: "browser", type: "actor", position: { x: 40, y: 180 }, data: { kind: "external-actor", label: "Customer browser" } },
    { id: "workers", type: "product", position: { x: 300, y: 180 }, data: { productId: "workers", label: "Workers API", description: "Serves the application" } },
    { id: "d1", type: "product", position: { x: 560, y: 80 }, data: { productId: "d1", label: "D1", description: "Stores diagram metadata" } },
  ],
  edges: [
    { id: "request", source: "browser", target: "workers", type: "request", label: "HTTPS request", data: { relationship: "request", label: "HTTPS request" } },
    { id: "event", source: "workers", target: "d1", type: "event", label: "persist diagram", data: { relationship: "event", label: "persist diagram" } },
  ],
  viewport: { x: 0, y: 0, zoom: 1 },
};

/** Clone a graph document so callers cannot mutate a persisted source by reference. */
export function cloneGraph(graph: GraphDocument): GraphDocument {
  return structuredClone(graph);
}

/** Create a product node at a graph-space position. */
export function createProductNode(productId: ProductId, position: GraphPoint): ArchitectureNode {
  const product = getProduct(productId);
  return {
    id: `${productId}-${crypto.randomUUID()}`,
    type: "product",
    position,
    data: { productId, label: product.label, description: product.description },
  };
}

/** Accept Vue Flow node updates only while an editor is writable. */
export function acceptNodeUpdate(readOnly: boolean, nodes: ArchitectureNode[]): ArchitectureNode[] | undefined {
  return readOnly ? undefined : nodes;
}

/** Accept Vue Flow edge updates only while an editor is writable. */
export function acceptEdgeUpdate(readOnly: boolean, edges: ArchitectureEdge[]): ArchitectureEdge[] | undefined {
  return readOnly ? undefined : edges;
}

/** Serialize a graph to its explicit JSON contract. */
export function serializeGraph(graph: GraphDocument): string {
  return JSON.stringify(graph);
}

/** Parse and minimally validate a saved spike graph document. */
export function parseGraph(serialized: string): GraphDocument {
  const candidate: unknown = JSON.parse(serialized);
  if (!isGraphDocument(candidate)) throw new Error("Saved JSON is not a version 1 graph document.");
  return candidate;
}

/** Persist a graph document in the browser's local storage. */
export function saveGraph(graph: GraphDocument, storage: Storage = localStorage): void {
  storage.setItem(graphStorageKey, serializeGraph(graph));
}

/** Restore the graph previously saved by this spike, if available. */
export function restoreGraph(storage: Storage = localStorage): GraphDocument | undefined {
  const serialized = storage.getItem(graphStorageKey);
  return serialized ? parseGraph(serialized) : undefined;
}

/** Check the shallow contract required before restored data reaches Vue Flow. */
function isGraphDocument(value: unknown): value is GraphDocument {
  if (!value || typeof value !== "object") return false;
  const graph = value as Partial<GraphDocument>;
  return graph.version === 1 && Array.isArray(graph.nodes) && Array.isArray(graph.edges) && isViewport(graph.viewport);
}

/** Check the numeric viewport shape independently of Vue Flow internals. */
function isViewport(value: unknown): value is ViewportTransform {
  if (!value || typeof value !== "object") return false;
  const viewport = value as Partial<ViewportTransform>;
  return typeof viewport.x === "number" && typeof viewport.y === "number" && typeof viewport.zoom === "number";
}
