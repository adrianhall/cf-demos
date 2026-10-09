import { MousePointer } from 'react-feather';
import { ViewportPortal } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import type { CFEdgeData, CFNodeData } from './types.ts';

/**
 * One other person's latest cursor location.
 */
export interface RemoteCursor {
  /**
   * Verified identity behind the cursor.
   */
  email: string;
  /**
   * Server-assigned presence colour.
   */
  color: string;
  /**
   * Flow-space cursor position.
   */
  x: number;
  /**
   * Flow-space cursor position.
   */
  y: number;
}

/**
 * One other person's current advisory selection.
 */
export interface RemoteSelection {
  /**
   * Verified identity behind the selection.
   */
  email: string;
  /**
   * Server-assigned presence colour.
   */
  color: string;
  /**
   * Selected node, if any.
   */
  nodeId: string | null;
  /**
   * Selected edge, if any.
   */
  edgeId: string | null;
}

/**
 * Props for {@link RemoteCursorsOverlay}.
 */
export interface RemoteCursorsOverlayProps {
  /**
   * Other people’s latest best-effort cursors.
   */
  cursors: RemoteCursor[];
  /**
   * Current graph nodes, read but never modified by the overlay.
   */
  nodes: Node<CFNodeData>[];
  /**
   * Current graph edges, used to find an advisory edge marker.
   */
  edges: Edge<CFEdgeData>[];
  /**
   * Other people's current advisory selections.
   */
  selections: RemoteSelection[];
}

/**
 * Returns an unobtrusive display name for an identity.
 *
 * @param email Verified email address.
 * @returns Local part of the email.
 */
function shortName(email: string): string {
  return email.split('@')[0] ?? email;
}

/**
 * Renders remote cursor and selection markers inside React Flow's transformed viewport.
 *
 * The overlay deliberately does not annotate React Flow nodes or the Zustand graph. Those objects
 * are the persistence input for the REST fallback; putting a transient cursor or selection there
 * would make a presence-only fact accidentally durable. `ViewportPortal` moves with pan and zoom
 * while keeping this data entirely outside the document model. Node outlines use the stored flow
 * position; edge selections get a marker at their endpoints' midpoint, which is advisory rather
 * than a second, competing edge renderer.
 *
 * @param props Latest best-effort awareness received from the live session.
 * @returns Awareness markers, or `null` when no other participant has sent one.
 */
export function RemoteCursorsOverlay({
  cursors,
  edges,
  nodes,
  selections
}: RemoteCursorsOverlayProps) {
  if (cursors.length === 0 && selections.length === 0) {
    return null;
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const edgesById = new Map(edges.map((edge) => [edge.id, edge]));

  return (
    <ViewportPortal>
      <div aria-hidden="true">
        {selections.map((selection) => {
          if (selection.nodeId !== null) {
            const node = nodesById.get(selection.nodeId);
            if (node === undefined) {
              return null;
            }
            return (
              <div
                className="remote-selection-highlight"
                key={`node-selection-${selection.email}`}
                style={{
                  borderColor: selection.color,
                  boxShadow: `0 0 0 2px ${selection.color}`,
                  height: node.measured?.height ?? 72,
                  left: node.position.x,
                  position: 'absolute',
                  top: node.position.y,
                  width: node.measured?.width ?? 180
                }}
                title={`${shortName(selection.email)} selected this node`}
              />
            );
          }

          if (selection.edgeId !== null) {
            const edge = edgesById.get(selection.edgeId);
            const source = edge === undefined ? undefined : nodesById.get(edge.source);
            const target = edge === undefined ? undefined : nodesById.get(edge.target);
            if (source === undefined || target === undefined) {
              return null;
            }
            return (
              <span
                className="remote-edge-selection"
                key={`edge-selection-${selection.email}`}
                style={{
                  backgroundColor: selection.color,
                  left: (source.position.x + target.position.x) / 2,
                  position: 'absolute',
                  top: (source.position.y + target.position.y) / 2
                }}
              >
                {shortName(selection.email)} selected this connection
              </span>
            );
          }

          return null;
        })}
        {cursors.map((cursor) => (
          <div
            className="remote-cursor"
            key={cursor.email}
            style={{ left: cursor.x, position: 'absolute', top: cursor.y }}
          >
            <MousePointer
              className="remote-cursor__icon"
              color={cursor.color}
              fill={cursor.color}
              size={16}
            />
            <span className="remote-cursor__label" style={{ backgroundColor: cursor.color }}>
              {shortName(cursor.email)}
            </span>
          </div>
        ))}
      </div>
    </ViewportPortal>
  );
}
