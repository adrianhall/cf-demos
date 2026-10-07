import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getSmoothStepPath } from '@xyflow/react';
import { EDGE_TYPE_MAP } from '../../../../catalog.ts';
import type { CFEdgeData } from '../types.ts';

/**
 * Accent colour applied to a selected edge, overriding its type's own colour.
 */
const SELECTED_COLOR = '#F6821F';

/**
 * Stroke colour for an edge whose `edgeType` the catalogue does not define, matching the
 * catalogue's own "external" grey so a legacy edge still reads as a connection rather than
 * disappearing.
 */
const FALLBACK_COLOR = '#9CA3AF';

/**
 * The single custom React Flow edge renderer, with four visual treatments keyed by `data.edgeType`.
 *
 * @param props React Flow edge props; `data` is a {@link CFEdgeData} payload.
 * @returns The rendered edge, its arrowhead marker and its optional midpoint label.
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
  selected
}: EdgeProps) {
  const edgeData = data as unknown as CFEdgeData | undefined;
  const edgeType = edgeData?.edgeType ?? 'data-flow';
  const typeDef = EDGE_TYPE_MAP.get(edgeType);

  const color = selected ? SELECTED_COLOR : (typeDef?.color ?? FALLBACK_COLOR);
  const animated = typeDef?.animated ?? false;

  let strokeDasharray: string | undefined;
  if (typeDef?.style === 'dashed') {
    strokeDasharray = '8 4';
  } else if (typeDef?.style === 'dotted') {
    strokeDasharray = '3 3';
  }

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    borderRadius: 8,
    sourcePosition,
    sourceX,
    sourceY,
    targetPosition,
    targetX,
    targetY
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
        style={{ stroke: color, strokeDasharray, strokeWidth: selected ? 2.5 : 1.5 }}
        markerEnd={markerEnd}
        // `cf-edge-animated` is this application's own class, defined in `../../../app.css`
        // alongside its `prefers-reduced-motion` guard — deliberately not React Flow's built-in
        // `.react-flow__edge.animated path` selector. That selector keys off the top-level
        // `Edge.animated` property on a wrapping `<g>` this component never renders, so a class of
        // that name here would match no rule at all.
        className={animated ? 'cf-edge-animated' : undefined}
      />
      {edgeData?.label && (
        <EdgeLabelRenderer>
          <div
            className="cf-edge__label"
            style={{
              pointerEvents: 'all',
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`
            }}
          >
            {edgeData.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/**
 * Memoised {@link CFEdgeComponent} for React Flow's `edgeTypes` registry.
 */
export const CFEdge = memo(CFEdgeComponent);
