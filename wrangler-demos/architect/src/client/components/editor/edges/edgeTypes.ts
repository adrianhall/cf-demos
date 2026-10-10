import { CF_EDGE_TYPE } from "../../../../graph-element-types";
import { CFEdge } from "./CFEdge";

/** React Flow `edgeTypes` registry mapping `"cf-edge"` to {@link CFEdge}. */
export const edgeTypes = {
  [CF_EDGE_TYPE]: CFEdge,
};
