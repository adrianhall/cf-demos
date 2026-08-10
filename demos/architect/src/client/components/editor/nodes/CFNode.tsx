import { Handle, type NodeProps, Position } from "@xyflow/react";
import { memo } from "react";
import type { ProductIcon as ProductIconDef } from "../../../../catalog";
import { CATEGORY_COLORS, NODE_TYPE_MAP } from "../../../../catalog";
import { ProductIcon } from "../../ProductIcon";
import type { CFNodeData } from "../types";

/** Icon shown for an unrecognized `typeId` -- matches the catalog's own "worker" entry. */
const FALLBACK_ICON: ProductIconDef = { kind: "svg", name: "workers" };

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
  // No trailing `?? "#6B7280"` here: `CATEGORY_COLORS` is a `Record<NodeCategory, string>`, so
  // it is exhaustive over every possible `category` value and this lookup can never itself be
  // `undefined`.
  const accentColor = nodeData.style?.accentColor ?? CATEGORY_COLORS[category];
  const handles = typeDef?.defaultHandles ?? [];

  return (
    <div
      className="cf-node"
      style={{
        // Full opacity in both selected and unselected states -- a 40%-alpha unselected border
        // failed WCAG 1.4.11's 3:1 non-text contrast minimum against a white canvas for every
        // category color (the node's fill matches the canvas background, so this border is the
        // only cue it is a discrete object). Selection is still visually distinct via the
        // box-shadow ring below.
        borderColor: accentColor,
        boxShadow: selected ? `0 0 0 2px ${accentColor}44` : "none",
      }}
    >
      <div
        className="cf-node__header"
        style={{ backgroundColor: `${accentColor}14` }}
      >
        <ProductIcon
          icon={typeDef?.icon ?? FALLBACK_ICON}
          className="cf-node__icon"
          size={24}
          color={accentColor}
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
