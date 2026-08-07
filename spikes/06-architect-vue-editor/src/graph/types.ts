import type { Edge, Node, ViewportTransform } from "@vue-flow/core";

/** The five curated products available in this spike's palette. */
export type ProductId = "workers" | "d1" | "r2" | "kv" | "workflows";

/** Product-node metadata persisted as part of the renderer-independent graph. */
export interface ProductNodeData {
  /** A catalog identifier, never a display label. */
  productId: ProductId;
  /** User-editable node label. */
  label: string;
  /** Short user-editable explanation. */
  description: string;
}

/** External-system metadata persisted for an actor node. */
export interface ActorNodeData {
  /** User-editable actor label. */
  label: string;
  /** Marks this node as an external actor rather than a Cloudflare product. */
  kind: "external-actor";
}

/** Persisted edge metadata for the two semantic relationship types. */
export interface ArchitectureEdgeData {
  /** Semantic type rendered as both edge color and edge label. */
  relationship: "request" | "event";
  /** User-visible description of the connection. */
  label: string;
}

/** A product or external actor represented on the canvas. */
export type ArchitectureNode = Node<ProductNodeData | ActorNodeData, any, "product" | "actor">;

/** A typed connection between graph nodes. */
export type ArchitectureEdge = Edge<ArchitectureEdgeData, any, "request" | "event">;

/** Versioned, renderer-independent saved graph document. */
export interface GraphDocument {
  /** Enables validation and future migrations. */
  version: 1;
  /** Canvas elements without Vue Flow's ephemeral selection state. */
  nodes: ArchitectureNode[];
  /** Typed graph relationships. */
  edges: ArchitectureEdge[];
  /** Last editor viewport, used only for a local restore demonstration. */
  viewport: ViewportTransform;
}

/** A graph coordinate independent of a browser viewport. */
export interface GraphPoint {
  /** Horizontal graph-space coordinate. */
  x: number;
  /** Vertical graph-space coordinate. */
  y: number;
}
