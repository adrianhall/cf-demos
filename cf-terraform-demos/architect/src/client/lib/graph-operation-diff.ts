import type { Edge, Node } from '@xyflow/react';
import type { GraphOperation } from '../../worker/domain/graph-operations.ts';
import type { CFEdgeData, CFNodeData } from '../components/editor/types.ts';

/**
 * A client graph at one moment, narrowed to the fields collaboration writes.
 */
export interface ClientGraph {
  /**
   * Canvas nodes.
   */
  nodes: Node<CFNodeData>[];
  /**
   * Connections between nodes.
   */
  edges: Edge<CFEdgeData>[];
}

/**
 * Reports whether two JSON values are structurally equal.
 *
 * The fields compared here are already JSON-shaped and small. Serialising them is both simpler and
 * more truthful than a hand-written nested comparator: adding a style field automatically becomes
 * part of equality rather than something a comparator can forget.
 *
 * @param left First value.
 * @param right Second value.
 * @returns Whether their JSON representations are identical.
 */
function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Derives the ordered operations that transform one client graph into another.
 *
 * This is how the editor sends **every** graph mutation through the live protocol without teaching
 * every control about transport. The Zustand store remains the one place UI actions mutate state;
 * when the existing 500 ms debounce fires, this pure diff describes what changed since the last
 * graph the tab dispatched. That covers drag, palette add, keyboard connect, property editing,
 * delete, undo, redo and auto-layout through one seam.
 *
 * Ordering is load-bearing:
 *
 * 1. Remove edges, before either endpoint can be removed;
 * 2. Remove nodes, whose domain operation also cascades any edge a stale client omitted;
 * 3. Add nodes, before edges can refer to them;
 * 4. Update nodes;
 * 5. Add edges;
 * 6. Update edges.
 *
 * A viewport change produces no operation. Looking at a different part of the canvas is not a
 * document edit — the store already does not mark it dirty — and no other editor should have their
 * view moved underneath them.
 *
 * @param before Last graph this tab dispatched or adopted from the session.
 * @param after Current optimistic graph on the canvas.
 * @returns Operations that transform `before` into `after`, in safe application order.
 */
export function diffGraphOperations(before: ClientGraph, after: ClientGraph): GraphOperation[] {
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]));
  const operations: GraphOperation[] = [];

  for (const edge of before.edges) {
    if (!afterEdges.has(edge.id)) {
      operations.push({ edgeId: edge.id, kind: 'remove_edge' });
    }
  }

  for (const node of before.nodes) {
    if (!afterNodes.has(node.id)) {
      operations.push({ kind: 'remove_node', nodeId: node.id });
    }
  }

  for (const node of after.nodes) {
    if (!beforeNodes.has(node.id)) {
      operations.push({
        input: {
          description: node.data.description,
          id: node.id,
          label: node.data.label,
          position: node.position,
          style: node.data.style,
          typeId: node.data.typeId
        },
        kind: 'add_node'
      });
    }
  }

  for (const node of after.nodes) {
    const previous = beforeNodes.get(node.id);
    if (previous === undefined) {
      continue;
    }

    const patch = {
      ...(previous.data.label === node.data.label ? {} : { label: node.data.label }),
      ...(previous.data.description === node.data.description
        ? {}
        : { description: node.data.description ?? '' }),
      ...(jsonEqual(previous.position, node.position) ? {} : { position: node.position }),
      ...(jsonEqual(previous.data.style, node.data.style) ? {} : { style: node.data.style ?? {} })
    };
    if (Object.keys(patch).length > 0) {
      operations.push({ kind: 'update_node', nodeId: node.id, patch });
    }
  }

  for (const edge of after.edges) {
    if (!beforeEdges.has(edge.id)) {
      operations.push({
        input: {
          description: edge.data?.description,
          edgeType: edge.data?.edgeType ?? 'data-flow',
          id: edge.id,
          label: edge.data?.label,
          protocol: edge.data?.protocol,
          source: edge.source,
          sourceHandle: edge.sourceHandle,
          target: edge.target,
          targetHandle: edge.targetHandle
        },
        kind: 'add_edge'
      });
    }
  }

  for (const edge of after.edges) {
    const previous = beforeEdges.get(edge.id);
    if (previous === undefined) {
      continue;
    }

    const patch = {
      ...(previous.data?.edgeType === edge.data?.edgeType
        ? {}
        : { edgeType: edge.data?.edgeType ?? 'data-flow' }),
      ...(previous.data?.label === edge.data?.label ? {} : { label: edge.data?.label ?? '' }),
      ...(previous.data?.description === edge.data?.description
        ? {}
        : { description: edge.data?.description ?? '' }),
      ...(previous.data?.protocol === edge.data?.protocol
        ? {}
        : { protocol: edge.data?.protocol ?? '' })
    };
    if (Object.keys(patch).length > 0) {
      operations.push({ edgeId: edge.id, kind: 'update_edge', patch });
    }
  }

  return operations;
}
