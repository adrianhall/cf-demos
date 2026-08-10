import { type Edge, type Node as FlowNode, useReactFlow } from "@xyflow/react";
import { useCallback, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  Layout as LayoutIcon,
  Maximize,
  RotateCcw,
  RotateCw,
  Share2,
  Sidebar,
  ZoomIn,
  ZoomOut,
} from "react-feather";
import { NODE_TYPE_MAP } from "../../../../catalog";
import { DarkModeToggle } from "../../../components/DarkModeToggle";
import { useDismissableMenu } from "../../../hooks/useDismissableMenu";
import { useDiagramStore } from "../../../stores/diagramStore";
import type { CFEdgeData, CFNodeData } from "../types";
import { ExportButton } from "./ExportButton";
import { PrintButton } from "./PrintButton";
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
 * Top toolbar: back-to-dashboard link, editable diagram title, undo/redo, zoom controls, an
 * auto-layout button, sharing (`./ShareModal.tsx`), export (`./ExportButton.tsx`), print
 * (`./PrintButton.tsx`), and a dark mode toggle (`../../../components/DarkModeToggle.tsx`). Ported from
 * CF-Architect's `src/islands/toolbar/Toolbar.tsx`.
 *
 * ELK (`elkjs`) is dynamically imported only when auto-layout is actually used
 * (docs/09-ARCHITECT.md's catalog table note: this repository's prior Vue attempt measured a
 * ~540 KB gzip cost for the equivalent library bundled eagerly).
 */
export function Toolbar({ readOnly = false }: { readOnly?: boolean }) {
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const {
    undo,
    redo,
    undoStack,
    redoStack,
    title,
    setTitle,
    diagramId,
    paletteOpen,
    togglePalette,
    propertiesOpen,
    toggleProperties,
  } = useDiagramStore();
  const [layouting, setLayouting] = useState(false);
  const [layoutDirection, setLayoutDirection] =
    useState<LayoutDirection>("DOWN");
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const layoutGroupRef = useRef<HTMLDivElement>(null);

  useDismissableMenu(
    layoutMenuOpen,
    layoutGroupRef,
    useCallback(() => setLayoutMenuOpen(false), []),
  );

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
        {/* Bug 6 (docs/09-ARCHITECT.md Phase 7): this was a text "Architect" logo, duplicating
            `AppShellView.tsx`'s own "Architect" header brand whenever both are visible at once
            (the authenticated editor route). Icon-only here removes the duplicate text while
            keeping the same back-to-dashboard link and destination -- see the deferred Bug 23
            in Phase 9 for the fuller fix of merging this toolbar into that header entirely. */}
        <a
          href="/app"
          className="toolbar__button toolbar__logo"
          title="Back to dashboard"
          aria-label="Back to dashboard"
        >
          <ArrowLeft size={18} aria-hidden="true" />
        </a>
        {readOnly ? (
          <span className="toolbar__title-readonly">{title}</span>
        ) : (
          <>
            <label className="visually-hidden" htmlFor="diagram-title">
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
          {/* Bug 4 (docs/09-ARCHITECT.md Phase 7): toggles for the two collapsible sidebars.
              `.toolbar__button--flipped` mirrors the same `Sidebar` glyph horizontally for the
              properties panel, since react-feather has no distinct left/right sidebar icon. */}
          <button
            type="button"
            onClick={togglePalette}
            className="toolbar__button"
            title="Toggle service palette"
            aria-label="Toggle service palette"
            aria-pressed={paletteOpen}
          >
            <Sidebar size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={toggleProperties}
            className="toolbar__button toolbar__button--flipped"
            title="Toggle properties panel"
            aria-label="Toggle properties panel"
            aria-pressed={propertiesOpen}
          >
            <Sidebar size={18} aria-hidden="true" />
          </button>
          <span className="toolbar__separator" aria-hidden="true" />
          <button
            type="button"
            onClick={undo}
            disabled={undoStack.length === 0}
            className="toolbar__button"
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
          >
            <RotateCcw size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={redoStack.length === 0}
            className="toolbar__button"
            title="Redo (Ctrl+Shift+Z)"
            aria-label="Redo"
          >
            <RotateCw size={18} aria-hidden="true" />
          </button>
          <span className="toolbar__separator" aria-hidden="true" />
          <button
            type="button"
            onClick={() => void zoomIn()}
            className="toolbar__button"
            title="Zoom in"
            aria-label="Zoom in"
          >
            <ZoomIn size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => void zoomOut()}
            className="toolbar__button"
            title="Zoom out"
            aria-label="Zoom out"
          >
            <ZoomOut size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => void fitView({ duration: 300 })}
            className="toolbar__button"
            title="Fit view"
            aria-label="Fit view"
          >
            <Maximize size={18} aria-hidden="true" />
          </button>
          <span className="toolbar__separator" aria-hidden="true" />
          <div className="toolbar__layout-group" ref={layoutGroupRef}>
            <button
              type="button"
              onClick={() => void applyAutoLayout(layoutDirection)}
              disabled={layouting}
              className="toolbar__button"
              title={`Auto layout (${layoutDirection === "DOWN" ? "top to bottom" : "left to right"})`}
              aria-label="Auto layout"
            >
              <LayoutIcon size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="toolbar__button toolbar__button--chevron"
              disabled={layouting}
              onClick={() => setLayoutMenuOpen((prev) => !prev)}
              aria-expanded={layoutMenuOpen}
              aria-haspopup="menu"
              aria-label="Choose layout direction"
            >
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            {layoutMenuOpen && (
              <div className="toolbar__layout-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
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
                  role="menuitem"
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

      {/* Export, print, and dark mode are always available, including in read-only mode -- an
          anonymous share viewer can export or print a diagram it cannot edit
          (docs/09-ARCHITECT.md Phase 5). Share is the one control here still gated to the
          owner. */}
      <div className="toolbar__group toolbar__group--end">
        {!readOnly && (
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            disabled={diagramId === null}
            className="toolbar__button"
            title="Share diagram"
            aria-label="Share diagram"
          >
            <Share2 size={18} aria-hidden="true" />
          </button>
        )}
        <ExportButton />
        <PrintButton />
        <DarkModeToggle className="toolbar__button" />
      </div>

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
