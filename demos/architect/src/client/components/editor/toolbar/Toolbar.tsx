import { type Edge, type Node as FlowNode, useReactFlow } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { NODE_TYPE_MAP } from "../../../../catalog";
import { useDiagramStore } from "../../../stores/diagramStore";
import type { CFEdgeData, CFNodeData } from "../types";
import { ShareModal } from "./ShareModal";

/** Auto-layout direction: top-to-bottom or left-to-right. */
type LayoutDirection = "DOWN" | "RIGHT";

/** Preferred source/target handle id for each layout direction, when the node type has one. */
const DIRECTION_HANDLES: Record<
  LayoutDirection,
  { source: string; target: string }
> = {
  DOWN: { source: "source-bottom", target: "target-top" },
  RIGHT: { source: "source-right", target: "target-left" },
};

/**
 * Remap edge `sourceHandle`/`targetHandle` to match a layout direction, only when the preferred
 * handle actually exists on that node's catalog type; otherwise the edge keeps its current
 * handle. Exported for `../DiagramCanvas.tsx`'s auto-layout flow and unit-tested directly, since
 * it is pure and independent of ELK itself.
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

/**
 * Top toolbar: back-to-dashboard link, editable diagram title, undo/redo, zoom controls, and an
 * auto-layout button. Ported from CF-Architect's `src/islands/toolbar/Toolbar.tsx`, scoped down
 * to this phase: the share button (Phase 3) and export/print/dark-mode controls (Phase 5) are
 * added in their own phases, not here.
 *
 * ELK (`elkjs`) is dynamically imported only when auto-layout is actually used
 * (docs/09-ARCHITECT.md's catalog table note: this repository's prior Vue attempt measured a
 * ~540 KB gzip cost for the equivalent library bundled eagerly).
 */
export function Toolbar({ readOnly = false }: { readOnly?: boolean }) {
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const { undo, redo, undoStack, redoStack, title, setTitle, diagramId } =
    useDiagramStore();
  const [layouting, setLayouting] = useState(false);
  const [layoutDirection, setLayoutDirection] =
    useState<LayoutDirection>("DOWN");
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const layoutGroupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!layoutMenuOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (
        layoutGroupRef.current &&
        !layoutGroupRef.current.contains(event.target as Node)
      ) {
        setLayoutMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [layoutMenuOpen]);

  /**
   * Dynamically import ELK, build a layered graph description from the current nodes/edges, run
   * layout, apply the computed positions, remap edge handles to match, and fit the viewport.
   * Pushes undo history once before applying so the whole re-layout is a single undo step.
   */
  const applyAutoLayout = useCallback(
    async (direction: LayoutDirection) => {
      setLayouting(true);
      try {
        const ELK = (await import("elkjs/lib/elk.bundled.js")).default;
        const elk = new ELK();

        const state = useDiagramStore.getState();
        const nodeWidth = 200;
        const nodeHeight = 80;

        const graph = {
          children: state.nodes.map((node) => ({
            height: nodeHeight,
            id: node.id,
            ports: (
              NODE_TYPE_MAP.get(node.data.typeId)?.defaultHandles ?? []
            ).map((handle) => ({
              id: `${node.id}-${handle.id}`,
              properties: { "port.side": handle.position.toUpperCase() },
            })),
            width: nodeWidth,
          })),
          edges: state.edges.map((edge) => ({
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
        if (layout.children) {
          const positioned = new Map(
            layout.children.map((child) => [
              child.id,
              { x: child.x ?? 0, y: child.y ?? 0 },
            ]),
          );
          const newNodes = state.nodes.map((node) => {
            const position = positioned.get(node.id);
            return position ? { ...node, position } : node;
          });
          const newEdges = remapEdgeHandles(
            state.edges,
            state.nodes,
            direction,
          );

          useDiagramStore.getState().pushHistory();
          useDiagramStore.getState().setNodes(newNodes);
          useDiagramStore.getState().setEdges(newEdges);
        }

        setTimeout(() => void fitView({ duration: 300 }), 50);
      } finally {
        setLayouting(false);
      }
    },
    [fitView],
  );

  return (
    <div className="toolbar">
      <div className="toolbar__group">
        <a href="/app" className="toolbar__logo" title="Back to dashboard">
          Architect
        </a>
        {readOnly ? (
          <span className="toolbar__title-readonly">{title}</span>
        ) : (
          <>
            <label className="toolbar__title-label" htmlFor="diagram-title">
              Diagram title
            </label>
            <input
              id="diagram-title"
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="toolbar__title"
              placeholder="Untitled Diagram"
            />
          </>
        )}
      </div>

      {!readOnly && (
        <div className="toolbar__group">
          <button
            type="button"
            onClick={undo}
            disabled={undoStack.length === 0}
            className="toolbar__button"
            title="Undo (Ctrl+Z)"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={redoStack.length === 0}
            className="toolbar__button"
            title="Redo (Ctrl+Shift+Z)"
          >
            Redo
          </button>
          <span className="toolbar__separator" aria-hidden="true" />
          <button
            type="button"
            onClick={() => void zoomIn()}
            className="toolbar__button"
            title="Zoom in"
          >
            Zoom in
          </button>
          <button
            type="button"
            onClick={() => void zoomOut()}
            className="toolbar__button"
            title="Zoom out"
          >
            Zoom out
          </button>
          <button
            type="button"
            onClick={() => void fitView({ duration: 300 })}
            className="toolbar__button"
            title="Fit view"
          >
            Fit view
          </button>
          <span className="toolbar__separator" aria-hidden="true" />
          <div className="toolbar__layout-group" ref={layoutGroupRef}>
            <button
              type="button"
              onClick={() => void applyAutoLayout(layoutDirection)}
              disabled={layouting}
              className="toolbar__button"
              title={`Auto layout (${layoutDirection === "DOWN" ? "top to bottom" : "left to right"})`}
            >
              {layouting
                ? "Laying out…"
                : `Layout ${layoutDirection === "DOWN" ? "↓" : "→"}`}
            </button>
            <button
              type="button"
              className="toolbar__button toolbar__button--chevron"
              disabled={layouting}
              onClick={() => setLayoutMenuOpen((prev) => !prev)}
              aria-expanded={layoutMenuOpen}
              aria-label="Choose layout direction"
            >
              ▾
            </button>
            {layoutMenuOpen && (
              <div className="toolbar__layout-menu">
                <button
                  type="button"
                  className="toolbar__layout-option"
                  onClick={() => {
                    setLayoutDirection("DOWN");
                    setLayoutMenuOpen(false);
                    void applyAutoLayout("DOWN");
                  }}
                >
                  ↓ Top to bottom
                </button>
                <button
                  type="button"
                  className="toolbar__layout-option"
                  onClick={() => {
                    setLayoutDirection("RIGHT");
                    setLayoutMenuOpen(false);
                    void applyAutoLayout("RIGHT");
                  }}
                >
                  → Left to right
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {!readOnly && (
        <div className="toolbar__group toolbar__group--end">
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            disabled={diagramId === null}
            className="toolbar__button"
            title="Share diagram"
          >
            Share
          </button>
        </div>
      )}

      {!readOnly && diagramId !== null && (
        <ShareModal
          diagramId={diagramId}
          open={shareOpen}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  );
}
