import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CFNode } from "../types";

/**
 * Renders the single external-actor node (a browser, in this probe) with a distinct oval shape
 * from {@link ProductNode} so the palette's "one external actor" case is visually and
 * structurally distinguishable, matching CF-Architect's actor/product node split.
 */
export function ActorNode({ data, selected }: NodeProps<CFNode>) {
  return (
    <div className={`cf-node cf-node--actor${selected ? " cf-node--selected" : ""}`}>
      <Handle type="target" position={Position.Top} id="top" />
      <div className="cf-node__label">{data.label}</div>
      <Handle type="source" position={Position.Bottom} id="bottom" />
    </div>
  );
}
