import { memo } from 'react';
import { Handle, type NodeProps, Position } from '@xyflow/react';
import type { ProductIcon as ProductIconDef } from '../../../../catalog.ts';
import { CATEGORY_COLORS, NODE_TYPE_MAP } from '../../../../catalog.ts';
import { ProductIcon } from '../../ProductIcon.tsx';
import type { CFNodeData } from '../types.ts';

/**
 * Icon shown for a `typeId` the catalogue no longer defines.
 *
 * A real glyph rather than nothing: a node's `typeId` comes from persisted diagram data, so a
 * product renamed out of the catalogue would otherwise leave an existing diagram with an empty box
 * where a service used to be. The label still reads correctly, so the node stays recognisable.
 */
const FALLBACK_ICON: ProductIconDef = { kind: 'svg', name: 'workers' };

/**
 * Maps a catalogue handle position onto React Flow's `Position` enum.
 *
 * @param position Catalogue handle position.
 * @returns The matching React Flow position.
 */
function toPosition(position: 'top' | 'bottom' | 'left' | 'right'): Position {
  switch (position) {
    case 'top':
      return Position.Top;
    case 'bottom':
      return Position.Bottom;
    case 'left':
      return Position.Left;
    default:
      return Position.Right;
  }
}

/**
 * The single custom React Flow node renderer used by every Cloudflare product type.
 *
 * One generic component rather than 42: the difference between a Workers node and a D1 node is
 * entirely data — icon, category colour, handles — all of which comes from the catalogue by
 * `data.typeId`. A component per product would be 42 copies of this markup kept in step by hand.
 *
 * @param props React Flow node props; `data` is a {@link CFNodeData} payload.
 * @returns The rendered canvas node.
 */
function CFNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as CFNodeData;
  const typeDef = NODE_TYPE_MAP.get(nodeData.typeId);
  const category = typeDef?.category ?? 'external';
  // No trailing fallback colour: `CATEGORY_COLORS` is a `Record<NodeCategory, string>`, so it is
  // exhaustive over every possible category and this lookup cannot be `undefined`.
  const accentColor = nodeData.style?.accentColor ?? CATEGORY_COLORS[category];
  const handles = typeDef?.defaultHandles ?? [];

  return (
    <div
      className="cf-node"
      style={{
        // Full opacity in both states. A 40%-alpha unselected border failed WCAG 1.4.11's 3:1
        // non-text contrast minimum for every category colour against a white canvas, and since
        // the node's fill matches the canvas, that border is the only cue it is a discrete object.
        // Selection stays visually distinct through the ring below instead.
        borderColor: accentColor,
        boxShadow: selected ? `0 0 0 2px ${accentColor}44` : 'none'
      }}
    >
      <div className="cf-node__header" style={{ backgroundColor: `${accentColor}14` }}>
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

      {nodeData.description && <div className="cf-node__description">{nodeData.description}</div>}

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

/**
 * Memoised {@link CFNodeComponent} for React Flow's `nodeTypes` registry.
 *
 * Memoised because React Flow re-renders every node on any store change — including a pan — and a
 * canvas of several dozen nodes each re-resolving a catalogue entry and re-inlining an SVG is
 * visible as pan jitter.
 */
export const CFNode = memo(CFNodeComponent);
