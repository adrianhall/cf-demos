import { CFNode } from "./CFNode";

/**
 * React Flow `nodeTypes` registry mapping the `"cf-node"` type key to {@link CFNode}. Every
 * catalog product type (`../../../../catalog.ts`) uses this single generic component.
 */
export const nodeTypes = {
  "cf-node": CFNode,
};
