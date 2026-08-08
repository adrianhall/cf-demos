import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import type { CFEdge } from "../types";

/** A dashed edge representing a Wrangler binding (D1/KV/R2/...) between two nodes. */
export function BindingEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps<CFEdge>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{ stroke: "#8b5cf6", strokeDasharray: "6 4" }}
      />
      <EdgeLabelRenderer>
        <div
          className="cf-edge-label cf-edge-label--binding"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {data?.label ?? "binding"}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
