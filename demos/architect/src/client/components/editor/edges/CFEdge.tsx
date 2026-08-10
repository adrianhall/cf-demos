import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
} from "@xyflow/react";
import { memo } from "react";
import { EDGE_TYPE_MAP } from "../../../../catalog";
import type { CFEdgeData } from "../types";

/** Accent color applied to a selected edge, overriding its type's default color. */
const SELECTED_COLOR = "#F6821F";

/**
 * Renders edges between nodes with four visual styles keyed by `data.edgeType`: solid animated
 * (data-flow), dashed (service-binding), dotted (trigger), solid gray (external). Uses a
 * smooth-step path with an SVG arrowhead marker and an optional midpoint label. Ported from
 * CF-Architect's `src/islands/edges/CFEdge.tsx`.
 */
function CFEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps) {
  const edgeData = data as unknown as CFEdgeData | undefined;
  const edgeType = edgeData?.edgeType ?? "data-flow";
  const typeDef = EDGE_TYPE_MAP.get(edgeType);

  const color = selected ? SELECTED_COLOR : (typeDef?.color ?? "#9CA3AF");
  const animated = typeDef?.animated ?? false;

  let strokeDasharray: string | undefined;
  if (typeDef?.style === "dashed") strokeDasharray = "8 4";
  else if (typeDef?.style === "dotted") strokeDasharray = "3 3";

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 8,
  });

  const markerId = `cf-edge-arrow-${edgeType}`;
  const markerEnd = typeDef?.markerEnd ? `url(#${markerId})` : undefined;

  return (
    <>
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="8"
          markerHeight="8"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
        </marker>
      </defs>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: color,
          strokeWidth: selected ? 2.5 : 1.5,
          strokeDasharray,
        }}
        markerEnd={markerEnd}
        className={animated ? "react-flow__edge-animated" : ""}
      />
      {edgeData?.label && (
        <EdgeLabelRenderer>
          <div
            className="cf-edge__label"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
          >
            {edgeData.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** Memoised export of {@link CFEdgeComponent} for React Flow's `edgeTypes` registry. */
export const CFEdge = memo(CFEdgeComponent);
