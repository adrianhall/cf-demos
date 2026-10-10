import type { Edge, Node } from '@xyflow/react';
import { EDGE_TYPE_MAP } from '../../catalog.ts';
import type { GraphOperation } from '../../worker/domain/graph-operations.ts';
import type { CFEdgeData, CFNodeData } from '../components/editor/types.ts';

/**
 * @file Turns one confirmed graph operation into the short sentence the assistant transcript shows
 *   for it — "Added node: Workers", "Connected Workers → D1 (Binding)". It is a pure function in
 *   `lib/` rather than a branch inside the canvas's frame handler for the same reason
 *   `./graph-operation-diff.ts` is: the interesting cases are all about what the graph contained
 *   _before_ the change, and that is far easier to state against fixture arrays than to contrive
 *   through a socket. Every lookup here reads the graph as it stood before the operation was
 *   applied, so the caller must call this _before_ applying it — a `remove_node` operation's target
 *   is gone the instant the store updates, and nothing else can recover its label.
 */

/**
 * Looks up a node's display label.
 *
 * @param nodeId Id to resolve.
 * @param nodes Nodes as they stood before the operation.
 * @returns The node's label, or a generic placeholder when the id names nothing — a narration must
 *   never throw, and an unknown id is an ordinary consequence of a racing removal.
 */
function nodeLabel(nodeId: string, nodes: Node<CFNodeData>[]): string {
  return nodes.find((node) => node.id === nodeId)?.data.label ?? 'a node';
}

/**
 * Looks up an edge type's human-readable label.
 *
 * @param edgeType Catalogue edge type identifier.
 * @returns The catalogue label, or the raw identifier for a type this build does not know — a
 *   diagram outlives a renamed edge type, exactly as `PropertiesPanel.tsx` assumes for products.
 */
function edgeTypeLabel(edgeType: string): string {
  return EDGE_TYPE_MAP.get(edgeType)?.label ?? edgeType;
}

/**
 * Describes one graph operation in a single line.
 *
 * @param operation The operation to narrate, taken from a confirmed `operation_applied` frame.
 * @param nodes Nodes as they stood **before** the operation was applied.
 * @param edges Edges as they stood before it, read only for the two edge operations whose frame
 *   carries an `edgeId` but neither endpoint.
 * @returns The narration, always a non-empty string.
 * @throws Nothing. Every unresolvable reference degrades to a generic phrase instead, because this
 *   runs inside the transcript and a thrown error there would take the panel down with it.
 */
export function describeOperation(
  operation: GraphOperation,
  nodes: Node<CFNodeData>[],
  edges: Edge<CFEdgeData>[]
): string {
  // Assigned in the switch and returned once, exactly as `applyGraphOperation` does and for the
  // same reason: TypeScript's definite-assignment analysis turns a missing case into a build
  // failure, where returning from each branch would let a new operation narrate nothing at all.
  let narration: string;

  switch (operation.kind) {
    case 'add_node':
      narration = `Added node: ${operation.input.label}`;
      break;
    case 'update_node':
      narration = `Updated node: ${operation.patch.label ?? nodeLabel(operation.nodeId, nodes)}`;
      break;
    case 'remove_node':
      narration = `Removed node: ${nodeLabel(operation.nodeId, nodes)}`;
      break;
    case 'add_edge':
      narration =
        `Connected ${nodeLabel(operation.input.source, nodes)} → `
        + `${nodeLabel(operation.input.target, nodes)} (${edgeTypeLabel(operation.input.edgeType)})`;
      break;
    case 'update_edge': {
      const edge = edges.find((candidate) => candidate.id === operation.edgeId);
      const edgeType = operation.patch.edgeType ?? edge?.data?.edgeType ?? 'data-flow';
      narration =
        edge === undefined
          ? `Updated connection (${edgeTypeLabel(edgeType)})`
          : `Updated connection: ${nodeLabel(edge.source, nodes)} → `
            + `${nodeLabel(edge.target, nodes)} (${edgeTypeLabel(edgeType)})`;
      break;
    }
    case 'remove_edge': {
      const edge = edges.find((candidate) => candidate.id === operation.edgeId);
      narration =
        edge === undefined
          ? 'Removed connection'
          : `Removed connection: ${nodeLabel(edge.source, nodes)} → ${nodeLabel(edge.target, nodes)}`;
      break;
    }
    case 'auto_layout':
      // Reachable only through the MCP tool, which the assistant does not call — but the union is
      // exhaustiveness-checked, so an unhandled case here would be a transcript line that simply
      // never appeared rather than a build failure.
      narration = 'Laid out the diagram';
      break;
  }

  return narration;
}
