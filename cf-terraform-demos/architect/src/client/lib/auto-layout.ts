import type { Edge, Node as FlowNode } from '@xyflow/react';
import { NODE_TYPE_MAP } from '../../catalog.ts';
import type { CFEdgeData, CFNodeData } from '../components/editor/types.ts';

/**
 * @file ELK-powered auto-layout for the editor canvas. `elkjs` is imported inside
 *   {@link computeAutoLayout} rather than at the top of this module, and that is the point of the
 *   file existing at all: the library is several hundred kilobytes, and a top-level import would
 *   put it in the bundle every visitor downloads to open a diagram they may never auto-lay-out. A
 *   dynamic `import()` leaves it in its own chunk, fetched the first time the button is pressed.
 *   ELK is also a browser-only concern here. It does not run inside `workerd` — `new ELK()` throws
 *   synchronously there — so no Worker-side code may import this module. {@link computeAutoLayout}
 *   has no store or React dependency and no side effect beyond its return value: it does not push
 *   undo history, mark the diagram dirty, or fit the viewport. Those stay with the caller, so the
 *   function can be reasoned about and tested as a transformation.
 */

/**
 * The direction a layout flows in.
 */
export type LayoutDirection = 'DOWN' | 'RIGHT';

/**
 * How long the viewport takes to settle after a layout, in milliseconds.
 *
 * Shared by every caller that lays the diagram out, so the toolbar button and the assistant's
 * post-turn pass look like the same action rather than two differently-timed ones.
 */
export const LAYOUT_FIT_DURATION_MS = 300;

/**
 * How long to wait after replacing the graph before fitting the view, in milliseconds.
 *
 * React Flow measures nodes after it has rendered them, so fitting in the same tick would frame the
 * positions the nodes have just left.
 */
export const LAYOUT_FIT_DELAY_MS = 50;

/**
 * The handles each direction prefers, when the node's type declares them.
 */
const DIRECTION_HANDLES: Record<LayoutDirection, { source: string; target: string }> = {
  DOWN: { source: 'source-bottom', target: 'target-top' },
  RIGHT: { source: 'source-right', target: 'target-left' }
};

/**
 * Node width ELK lays out against, in pixels.
 *
 * A fixed figure because `CFNode` has no intrinsic size — it is as wide as its label — and ELK
 * needs a number before anything has been rendered. The result is spacing computed against a
 * typical node rather than each real one, which is a layout a person then adjusts, not a final
 * position.
 */
const ELK_NODE_WIDTH = 200;

/**
 * Node height ELK lays out against, in pixels. Fixed for the same reason as {@link ELK_NODE_WIDTH}.
 */
const ELK_NODE_HEIGHT = 80;

/**
 * Points every edge's handles at the side of the node the new layout puts them on.
 *
 * Without this, a diagram laid out top-to-bottom keeps edges leaving from the right of each node
 * and looping back around to the top of the next — correct, but unreadable. An edge whose node type
 * does not declare the preferred handle keeps the handle it has.
 *
 * @param edges Edges to remap.
 * @param nodes Nodes the edges connect, used to look up each end's catalogue type.
 * @param direction Direction the layout was computed in.
 * @returns A new array. An edge whose handles are unchanged is returned as the same object, so a
 *   caller comparing by identity can tell nothing about it moved.
 */
export function remapEdgeHandles(
  edges: Edge<CFEdgeData>[],
  nodes: FlowNode<CFNodeData>[],
  direction: LayoutDirection
): Edge<CFEdgeData>[] {
  const preferred = DIRECTION_HANDLES[direction];
  const nodeTypeIdMap = new Map(nodes.map((node) => [node.id, node.data.typeId]));

  return edges.map((edge) => {
    let sourceHandle = edge.sourceHandle;
    let targetHandle = edge.targetHandle;

    const sourceTypeId = nodeTypeIdMap.get(edge.source);
    if (sourceTypeId !== undefined) {
      const handles = NODE_TYPE_MAP.get(sourceTypeId)?.defaultHandles ?? [];
      if (handles.some((handle) => handle.id === preferred.source)) {
        sourceHandle = preferred.source;
      }
    }

    const targetTypeId = nodeTypeIdMap.get(edge.target);
    if (targetTypeId !== undefined) {
      const handles = NODE_TYPE_MAP.get(targetTypeId)?.defaultHandles ?? [];
      if (handles.some((handle) => handle.id === preferred.target)) {
        targetHandle = preferred.target;
      }
    }

    if (sourceHandle === edge.sourceHandle && targetHandle === edge.targetHandle) {
      return edge;
    }
    return { ...edge, sourceHandle, targetHandle };
  });
}

/**
 * A completed layout.
 */
export interface AutoLayoutResult {
  /**
   * The nodes, repositioned. Every other field is preserved.
   */
  nodes: FlowNode<CFNodeData>[];
  /**
   * The edges, with handles remapped to match the direction; see {@link remapEdgeHandles}.
   */
  edges: Edge<CFEdgeData>[];
}

/**
 * Lays a graph out with ELK's layered algorithm and returns the repositioned result.
 *
 * Neither input array is mutated and no store is touched; see this file's own comment for what
 * remains the caller's responsibility.
 *
 * @param nodes Current nodes. Only `id` and `data.typeId` are read — the positions are what this
 *   recomputes.
 * @param edges Current edges. Read for `id`, `source` and `target`, and returned remapped rather
 *   than filtered or reordered.
 * @param direction Whether the layout flows downward or to the right.
 * @returns The repositioned nodes and remapped edges, or `null` when ELK returned no children at
 *   all — a successful call that computed nothing, which the caller should treat as "leave the
 *   canvas as it is" rather than as an empty graph.
 * @throws {Error} Whatever `elk.layout()` throws for a malformed graph or an internal failure. It
 *   is deliberately not caught here: the caller decides whether a failed layout is worth telling
 *   the visitor about.
 */
export async function computeAutoLayout(
  nodes: FlowNode<CFNodeData>[],
  edges: Edge<CFEdgeData>[],
  direction: LayoutDirection
): Promise<AutoLayoutResult | null> {
  const ELK = (await import('elkjs/lib/elk.bundled.js')).default;
  const elk = new ELK();

  const graph = {
    children: nodes.map((node) => ({
      height: ELK_NODE_HEIGHT,
      id: node.id,
      ports: (NODE_TYPE_MAP.get(node.data.typeId)?.defaultHandles ?? []).map((handle) => ({
        id: `${node.id}-${handle.id}`,
        properties: { 'port.side': handle.position.toUpperCase() }
      })),
      width: ELK_NODE_WIDTH
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target]
    })),
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
      'elk.spacing.nodeNode': '60'
    }
  };

  const layout = await elk.layout(graph);
  if (!layout.children) {
    return null;
  }

  const positioned = new Map(
    layout.children.map((child) => [child.id, { x: child.x ?? 0, y: child.y ?? 0 }])
  );

  return {
    edges: remapEdgeHandles(edges, nodes, direction),
    nodes: nodes.map((node) => {
      const position = positioned.get(node.id);
      return position ? { ...node, position } : node;
    })
  };
}
