import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CFNode } from "../types";

/**
 * Renders a single Cloudflare product node with connectable handles on all four sides —
 * structurally close to CF-Architect's own `CFNode` renderer, adapted for this probe (see
 * docs/09-ARCHITECT.md, "What We're Porting From CF-Architect").
 */
export function ProductNode({ data, selected }: NodeProps<CFNode>) {
  return (
    <div
      className={`cf-node cf-node--product${selected ? " cf-node--selected" : ""}`}
      style={{ borderLeftColor: data.color ?? "#f6821f" }}
    >
      <Handle type="target" position={Position.Top} id="top" />
      <Handle type="target" position={Position.Left} id="left" />
      <div className="cf-node__label">{data.label}</div>
      {data.description ? <div className="cf-node__description">{data.description}</div> : null}
      <Handle type="source" position={Position.Right} id="right" />
      <Handle type="source" position={Position.Bottom} id="bottom" />
    </div>
  );
}
