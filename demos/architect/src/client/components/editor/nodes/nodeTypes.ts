import { CF_NODE_TYPE } from "../../../../graph-element-types";
import { CFNode } from "./CFNode";

/**
 * React Flow `nodeTypes` registry mapping the `"cf-node"` type key to {@link CFNode}. Every
 * catalog product type (`../../../../catalog.ts`) uses this single generic component.
 */
export const nodeTypes = {
  [CF_NODE_TYPE]: CFNode,
};
