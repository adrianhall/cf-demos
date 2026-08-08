import { Handle, type NodeProps, Position } from "@xyflow/react";
import { memo } from "react";
import { CATEGORY_COLORS, NODE_TYPE_MAP } from "../../../../catalog";
import type { CFNodeData } from "../types";

/** Map a catalog handle position to React Flow's `Position` enum. */
function toPosition(position: "top" | "bottom" | "left" | "right"): Position {
  switch (position) {
    case "top":
      return Position.Top;
    case "bottom":
      return Position.Bottom;
    case "left":
      return Position.Left;
    default:
      return Position.Right;
  }
}

/**
 * Generic custom React Flow node renderer for every Cloudflare product type. Looks up the
 * product definition from `../../../../catalog.ts` via `data.typeId`, renders a
 * category-colored border, product icon, label, optional description, and typed connection
 * handles. Ported from CF-Architect's `src/islands/nodes/CFNode.tsx`.
 */
function CFNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as CFNodeData;
  const typeDef = NODE_TYPE_MAP.get(nodeData.typeId);
  const category = typeDef?.category ?? "external";
  const accentColor =
    nodeData.style?.accentColor ?? CATEGORY_COLORS[category] ?? "#6B7280";
  const handles = typeDef?.defaultHandles ?? [];

  return (
    <div
      className="cf-node"
      style={{
        borderColor: selected ? accentColor : `${accentColor}66`,
        boxShadow: selected ? `0 0 0 2px ${accentColor}44` : "none",
      }}
    >
      <div
        className="cf-node__header"
        style={{ backgroundColor: `${accentColor}14` }}
      >
        <img
          src={typeDef?.iconPath ?? "/icons/worker.svg"}
          alt=""
          className="cf-node__icon"
          width={24}
          height={24}
        />
        <span className="cf-node__label" title={nodeData.label}>
          {nodeData.label}
        </span>
      </div>

      {nodeData.description && (
        <div className="cf-node__description">{nodeData.description}</div>
      )}

      {handles.map((handle) => (
        <Handle
          key={handle.id}
          id={handle.id}
          type={handle.type}
          position={toPosition(handle.position)}
          style={{ background: accentColor }}
        />
      ))}
    </div>
  );
}

/** Memoised export of {@link CFNodeComponent} for React Flow's `nodeTypes` registry. */
export const CFNode = memo(CFNodeComponent);
