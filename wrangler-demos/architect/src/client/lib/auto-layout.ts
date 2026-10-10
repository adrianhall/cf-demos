/**
 * Shared ELK-powered auto-layout computation, extracted from
 * `../components/editor/toolbar/Toolbar.tsx`'s own `applyAutoLayout` (docs/09D-ARCHITECT-AICHAT.md's
 * Node Placement And Auto-Layout) so both the toolbar's "Auto Layout" button and the in-editor AI
 * chat panel (`../components/editor/panels/AiChatPanel.tsx`, which re-runs this after a chat turn
 * adds or removes at least one node) call identical layout code -- one algorithm, one place it can
 * drift out of sync with the other.
 *
 * `computeAutoLayout()` itself has no store/React dependency and no side effects beyond its own
 * returned value: it does not read or write `../stores/diagramStore.ts`, push undo history, enqueue
 * a live-sync operation, or call `fitView()` -- every one of those remains the caller's own
 * responsibility (`Toolbar.tsx`'s `applyAutoLayout` does them immediately after awaiting this
 * function; a future caller might reasonably do something different, e.g. persist via
 * `PUT /api/diagrams/:id/graph` instead of the live socket, per docs/09D-ARCHITECT-AICHAT.md's own
 * "the client... persists the result through the existing `PUT` route" design). "Pure" here means
 * exactly that narrower thing, not "synchronous" -- this function is `async` and genuinely calls
 * out to `elkjs`'s own layout engine.
 *
 * `elkjs` is dynamically imported inside {@link computeAutoLayout} itself, not at this module's top
 * level, preserving `Toolbar.tsx`'s original reason for doing so: this repository's prior Vue
 * attempt measured a ~540 KB gzip cost for the equivalent library bundled eagerly
 * (docs/09-ARCHITECT.md), so it must only ever load once a real auto-layout call actually happens.
 */
import type { Edge, Node as FlowNode } from "@xyflow/react";
import { NODE_TYPE_MAP } from "../../catalog";
import type { CFEdgeData, CFNodeData } from "../components/editor/types";

/** Auto-layout direction: top-to-bottom or left-to-right. */
export type LayoutDirection = "DOWN" | "RIGHT";

/** Preferred source/target handle id for each layout direction, when the node type has one. */
const DIRECTION_HANDLES: Record<
  LayoutDirection,
  { source: string; target: string }
> = {
  DOWN: { source: "source-bottom", target: "target-top" },
  RIGHT: { source: "source-right", target: "target-left" },
};

/** Fixed node dimensions ELK lays out against -- this canvas's `CFNode` renderer
 * (`../components/editor/nodes/CFNode.tsx`) has no fixed size of its own, so these are a
 * reasonable, unchanging stand-in rather than a real per-node measurement. */
const ELK_NODE_WIDTH = 200;
const ELK_NODE_HEIGHT = 80;

/**
 * Remap edge `sourceHandle`/`targetHandle` to match a layout direction, only when the preferred
 * handle actually exists on that node's catalog type; otherwise the edge keeps its current
 * handle. Pure and independent of ELK itself, so it is unit-tested directly with plain fixture
 * values, no `elkjs` mock required.
 *
 * @param edges Edges to remap.
 * @param nodes Nodes referenced by `edges`, used to look up each endpoint's catalog `typeId`.
 * @param direction The layout direction just applied.
 * @returns A new edge array; an edge whose handles are unchanged is returned as the same object
 * instance (no new object allocated) so a caller doing a shallow equality check can tell nothing
 * about that edge changed.
 */
export function remapEdgeHandles(
  edges: Edge<CFEdgeData>[],
  nodes: FlowNode<CFNodeData>[],
  direction: LayoutDirection,
): Edge<CFEdgeData>[] {
  const preferred = DIRECTION_HANDLES[direction];
  const nodeTypeIdMap = new Map(
    nodes.map((node) => [node.id, node.data.typeId]),
  );

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

    if (
      sourceHandle === edge.sourceHandle &&
      targetHandle === edge.targetHandle
    ) {
      return edge;
    }
    return { ...edge, sourceHandle, targetHandle };
  });
}

/** {@link computeAutoLayout}'s successful result. */
export interface AutoLayoutResult {
  /** `nodes`, repositioned to ELK's computed layout. Every other field (`data`, `id`, `type`,
   * ...) is preserved untouched via object spread. */
  nodes: FlowNode<CFNodeData>[];
  /** `edges`, with `sourceHandle`/`targetHandle` remapped to match `direction`
   * ({@link remapEdgeHandles}). */
  edges: Edge<CFEdgeData>[];
}

/**
 * Run ELK's layered layout algorithm against the given nodes/edges and return the repositioned
 * result, without mutating either input array or touching any store/React state -- see this
 * module's own top-of-file JSDoc for exactly what "pure" means here and what remains each
 * caller's own responsibility (undo history, live-sync operations, `fitView()`).
 *
 * @param nodes Current nodes. Read only for `id`/`data.typeId` -- their `position` is what ELK
 * recomputes.
 * @param edges Current edges. Read only for `id`/`source`/`target` when building ELK's graph
 * description; remapped (not filtered or reordered) in the returned result.
 * @param direction Layout direction: top-to-bottom (`"DOWN"`) or left-to-right (`"RIGHT"`).
 * @returns The repositioned nodes and remapped edges, or `null` when ELK's own response carries
 * no `children` at all (an otherwise-successful call that simply computed nothing to apply --
 * `Toolbar.tsx`'s original inline implementation treated this identically, leaving the store
 * untouched in that case).
 * @throws Whatever `elkjs`'s own `elk.layout()` call throws on a malformed graph description or
 * an internal layout failure -- this function does not catch or translate that error; the
 * caller decides how to surface it (`Toolbar.tsx`'s caller wraps this in a `try`/`finally` only
 * to reset its own `layouting` flag, letting the error itself propagate).
 */
export async function computeAutoLayout(
  nodes: FlowNode<CFNodeData>[],
  edges: Edge<CFEdgeData>[],
  direction: LayoutDirection,
): Promise<AutoLayoutResult | null> {
  const ELK = (await import("elkjs/lib/elk.bundled.js")).default;
  const elk = new ELK();

  const graph = {
    children: nodes.map((node) => ({
      height: ELK_NODE_HEIGHT,
      id: node.id,
      ports: (NODE_TYPE_MAP.get(node.data.typeId)?.defaultHandles ?? []).map(
        (handle) => ({
          id: `${node.id}-${handle.id}`,
          properties: { "port.side": handle.position.toUpperCase() },
        }),
      ),
      width: ELK_NODE_WIDTH,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      "elk.spacing.nodeNode": "60",
    },
  };

  const layout = await elk.layout(graph);
  if (!layout.children) {
    return null;
  }

  const positioned = new Map(
    layout.children.map((child) => [
      child.id,
      { x: child.x ?? 0, y: child.y ?? 0 },
    ]),
  );
  const newNodes = nodes.map((node) => {
    const position = positioned.get(node.id);
    return position ? { ...node, position } : node;
  });
  const newEdges = remapEdgeHandles(edges, nodes, direction);

  return { edges: newEdges, nodes: newNodes };
}
