import type { Edge, Node } from "@xyflow/react";

/** Data carried by every diagram node in this probe, regardless of its rendered node type. */
export interface CFNodeData extends Record<string, unknown> {
  /** Short display name shown on the node itself. */
  label: string;
  /** Longer free-text description, editable through the properties panel. */
  description: string;
  /** Accent color for a `product` node; unused for `actor`. */
  color?: string;
  /** Distinguishes a catalog product node from the external-actor node. */
  kind: "product" | "actor";
}

/** A diagram node typed with this probe's data shape and custom node-type names. */
export type CFNode = Node<CFNodeData, "product" | "actor">;

/** Data carried by every diagram edge in this probe. */
export interface CFEdgeData extends Record<string, unknown> {
  /** Text rendered on the edge's label. */
  label: string;
}

/** A diagram edge typed with this probe's data shape and the two probed edge types. */
export type CFEdge = Edge<CFEdgeData, "http" | "binding">;
