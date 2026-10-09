import type { Edge, Node } from '@xyflow/react';
import type { HandleDef } from '../../../catalog.ts';
import { NODE_TYPE_MAP } from '../../../catalog.ts';
import { preferredHandles } from '../../../edge-anchoring.ts';
import type { CFEdgeData, CFNodeData } from './types.ts';

/**
 * @file The rules behind the **Connect nodes** dialog, kept free of React and Zustand so every
 *   branch is directly testable without mounting a canvas. React Flow's own connection flow is a
 *   pointer drag between two handles, and a handle is an unfocusable `<div>` with no role or
 *   accessible name — so the drag is the only way to create an edge, which fails WCAG 2.2 SC 2.5.7
 *   and 2.1.1. The dialog is the keyboard path, and these functions are what it decides with.
 */

/**
 * A resolved pair of handles for a new edge.
 */
export interface ConnectionHandles {
  /**
   * Handle id on the source node, or `null` to let React Flow attach to the node itself.
   */
  sourceHandle: string | null;
  /**
   * Handle id on the target node, or `null` for the same reason.
   */
  targetHandle: string | null;
}

/**
 * Resolves one side of a connection to a concrete handle id.
 *
 * Shared by both sides rather than written twice: the two differ only in which `HandleDef.type`
 * they look for.
 *
 * @param handles Handles the node's catalogue type declares.
 * @param preferredId Handle the direction of the connection suggests.
 * @param kind Whether this side needs a `source` or a `target` handle.
 * @returns The preferred handle when the node declares it, otherwise the first handle of the right
 *   kind, otherwise `null`.
 */
function resolveHandle(
  handles: HandleDef[],
  preferredId: string,
  kind: HandleDef['type']
): string | null {
  if (handles.some((handle) => handle.id === preferredId)) {
    return preferredId;
  }
  return handles.find((handle) => handle.type === kind)?.id ?? null;
}

/**
 * Chooses which handles an edge created through the dialog should attach to.
 *
 * The catalogue only ever declares a source handle on a node's bottom or right and a target handle
 * on its top or left, so there is no direct handle for an edge running up or to the left. That case
 * — and a type declaring nothing in the preferred direction — falls back to the first handle of the
 * right kind, then to `null`, which lets React Flow pick for itself rather than dropping the edge.
 *
 * @param source Source node, which must already be positioned on the canvas.
 * @param target Target node.
 * @returns The resolved handle pair.
 */
export function chooseConnectionHandles(
  source: Node<CFNodeData>,
  target: Node<CFNodeData>
): ConnectionHandles {
  // The side rule itself is shared with the server-side SVG export rather than restated here;
  // see `src/edge-anchoring.ts` for why the two have to agree.
  const preferred = preferredHandles(source.position, target.position);
  const sourceHandles = NODE_TYPE_MAP.get(source.data.typeId)?.defaultHandles ?? [];
  const targetHandles = NODE_TYPE_MAP.get(target.data.typeId)?.defaultHandles ?? [];

  return {
    sourceHandle: resolveHandle(sourceHandles, preferred.source, 'source'),
    targetHandle: resolveHandle(targetHandles, preferred.target, 'target')
  };
}

/**
 * Finds an existing edge between the same two nodes carrying the same edge type.
 *
 * The type is part of the comparison on purpose. A worker that both reads from a database and is
 * triggered by it is two genuinely different relationships, so only an exact match on all three is
 * a duplicate.
 *
 * @param edges Current edges on the canvas.
 * @param sourceId Proposed source node id.
 * @param targetId Proposed target node id.
 * @param edgeType Proposed edge type.
 * @returns The matching edge, or `undefined` when there is none.
 */
export function findDuplicateEdge(
  edges: Edge<CFEdgeData>[],
  sourceId: string,
  targetId: string,
  edgeType: CFEdgeData['edgeType']
): Edge<CFEdgeData> | undefined {
  return edges.find(
    (edge) =>
      edge.source === sourceId && edge.target === targetId && edge.data?.edgeType === edgeType
  );
}

/**
 * A proposed connection to validate.
 */
export interface ValidateConnectionInput {
  /**
   * Id of the node the edge would leave.
   */
  sourceId: string;
  /**
   * Id of the node the edge would reach.
   */
  targetId: string;
  /**
   * Edge type the new connection would carry.
   */
  edgeType: CFEdgeData['edgeType'];
  /**
   * Current edges, searched for an exact duplicate.
   */
  edges: Edge<CFEdgeData>[];
}

/**
 * Validates a proposed connection before anything is added to the canvas.
 *
 * The message is returned rather than thrown because it is shown next to the form while the visitor
 * is still choosing: the dialog renders it and disables its Connect button, so an invalid selection
 * explains itself instead of failing on submission.
 *
 * @param input Proposed connection; see {@link ValidateConnectionInput}.
 * @returns A message explaining why the connection is refused, or `null` when it is allowed.
 */
export function validateConnection({
  sourceId,
  targetId,
  edgeType,
  edges
}: ValidateConnectionInput): string | null {
  if (sourceId === targetId) {
    return 'A node cannot be connected to itself.';
  }
  if (findDuplicateEdge(edges, sourceId, targetId, edgeType)) {
    return 'These nodes are already connected with that edge type.';
  }
  return null;
}
