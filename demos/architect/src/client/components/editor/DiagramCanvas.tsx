import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  ReactFlow,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useState } from "react";
import { CATEGORY_COLORS, NODE_TYPE_MAP } from "../../../catalog";
import {
  getDiagram,
  saveDiagramGraph,
  updateDiagram,
} from "../../api/diagrams";
import { useDiagramStore } from "../../stores/diagramStore";
import { edgeTypes } from "./edges/edgeTypes";
import { nodeTypes } from "./nodes/nodeTypes";
import { PropertiesPanel } from "./panels/PropertiesPanel";
import { ServicePalette } from "./panels/ServicePalette";
import { StatusBar } from "./toolbar/StatusBar";
import { Toolbar } from "./toolbar/Toolbar";
import type { CFEdgeData, CFNodeData } from "./types";

/** Debounce interval, in milliseconds, before an unsaved change autosaves. */
const AUTOSAVE_DEBOUNCE_MS = 500;
/** Debounce interval, in milliseconds, before a title change is persisted. */
const TITLE_SAVE_DEBOUNCE_MS = 1_000;

/** Parsed shape of a diagram's `graphData` JSON string. */
interface ParsedGraphData {
  nodes: Node<CFNodeData>[];
  edges: Edge<CFEdgeData>[];
  viewport: { x: number; y: number; zoom: number };
}

/** Parse a diagram's `graphData` string, tolerating an empty or malformed value. */
function parseGraphData(graphData: string): ParsedGraphData {
  try {
    const parsed = JSON.parse(graphData || "{}") as Partial<ParsedGraphData>;
    return {
      nodes: parsed.nodes ?? [],
      edges: (parsed.edges as ParsedGraphData["edges"]) ?? [],
      viewport: parsed.viewport ?? { x: 0, y: 0, zoom: 1 },
    };
  } catch {
    return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  }
}

/**
 * Main diagram editor: loads a diagram by id, wires autosave (debounced graph and title saves),
 * an unload guard for unsaved changes, drag-and-drop and click-to-add node creation from the
 * palette, keyboard shortcuts (Delete, Ctrl+Z, Ctrl+Shift+Z), and renders the full editor layout
 * (toolbar, palette, canvas, properties panel, status bar). Ported from CF-Architect's
 * `src/islands/DiagramCanvas.tsx`, scoped to this phase: read-only sharing, print mode, and
 * export are added in their own later phases.
 *
 * @param diagramId Diagram id to load and autosave, taken from the current URL
 * (`../../views/EditorView.tsx`).
 */
export function DiagramCanvas({ diagramId }: { diagramId: string }) {
  const { screenToFlowPosition } = useReactFlow();

  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    onViewportChange,
    setDiagram,
    addNode,
    removeSelected,
    setSelectedNode,
    setSelectedEdge,
    undo,
    redo,
    dirty,
    markSaving,
    markSaved,
    markSaveError,
    title,
  } = useDiagramStore();

  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDiagram(diagramId)
      .then((diagram) => {
        if (cancelled) return;
        const parsed = parseGraphData(diagram.graphData);
        setDiagram(
          diagramId,
          diagram.title,
          diagram.description ?? "",
          parsed.nodes,
          parsed.edges,
          parsed.viewport,
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : "Could not load diagram.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [diagramId, setDiagram]);

  // Autosave the graph shortly after the last change.
  useEffect(() => {
    if (!dirty) return;

    const timer = setTimeout(() => {
      void (async () => {
        markSaving();
        try {
          const state = useDiagramStore.getState();
          const graphData = JSON.stringify({
            nodes: state.nodes,
            edges: state.edges,
            viewport: state.viewport,
          });
          await saveDiagramGraph(diagramId, graphData);
          markSaved();
        } catch (error) {
          markSaveError(
            error instanceof Error ? error.message : "Failed to save.",
          );
        }
      })();
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [dirty, diagramId, markSaving, markSaved, markSaveError]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (useDiagramStore.getState().dirty) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // Persist title changes independently of the graph autosave, matching CF-Architect's
  // separate, slightly longer debounce for the (much smaller, much less frequently updated)
  // metadata write.
  const diagramLoaded = useDiagramStore((state) => state.diagramId !== null);
  useEffect(() => {
    if (!diagramLoaded) return;
    const timer = setTimeout(() => {
      updateDiagram(diagramId, { title }).catch(() => {
        /* the title autosave failing silently matches CF-Architect's own behavior; the
           graph autosave surfaces failures in the status bar, which is the save signal
           users actually watch. */
      });
    }, TITLE_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [title, diagramLoaded, diagramId]);

  /** Add a node dropped from the palette at the drop position. */
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const typeId = event.dataTransfer.getData("application/cf-node-type");
      if (!typeId) return;
      const typeDef = NODE_TYPE_MAP.get(typeId);
      if (!typeDef) return;

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      addNode({
        data: { description: "", label: typeDef.label, typeId },
        id: `${typeId}-${Date.now()}`,
        position,
        type: "cf-node",
      });
    },
    [screenToFlowPosition, addNode],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  /** Add a node from a palette click/keyboard activation, at the canvas center. */
  const onAddNodeFromPalette = useCallback(
    (typeId: string) => {
      const typeDef = NODE_TYPE_MAP.get(typeId);
      if (!typeDef) return;
      const position = screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });
      addNode({
        data: { description: "", label: typeDef.label, typeId },
        id: `${typeId}-${Date.now()}`,
        position,
        type: "cf-node",
      });
    },
    [screenToFlowPosition, addNode],
  );

  const onNodeClick = useCallback(
    (_event: unknown, node: { id: string }) => setSelectedNode(node.id),
    [setSelectedNode],
  );
  const onEdgeClick = useCallback(
    (_event: unknown, edge: { id: string }) => setSelectedEdge(edge.id),
    [setSelectedEdge],
  );
  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
  }, [setSelectedNode, setSelectedEdge]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const isEditing =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      if ((event.key === "Delete" || event.key === "Backspace") && !isEditing) {
        removeSelected();
      }
      if (event.ctrlKey && event.key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      }
      if (event.ctrlKey && event.shiftKey && event.key === "Z") {
        event.preventDefault();
        redo();
      }
    },
    [removeSelected, undo, redo],
  );

  if (loadError) {
    return (
      <div className="diagram-editor__error" role="alert">
        <p>{loadError}</p>
        <a href="/app">Back to dashboard</a>
      </div>
    );
  }

  if (!diagramLoaded) {
    return <p className="diagram-editor__loading">Loading diagram…</p>;
  }

  return (
    // `role="application"` marks this region as its own keyboard-interaction context for the
    // Delete/Ctrl+Z/Ctrl+Shift+Z shortcuts below. `tabIndex={0}` is what actually lets a
    // keyboard user reach that context in the first place -- biome's static-analysis role
    // allowlist for this rule does not happen to include "application", but a real screen
    // reader/keyboard user's experience is unaffected by that gap.
    <div
      className="diagram-editor"
      role="application"
      aria-label="Diagram editor"
      onKeyDown={onKeyDown}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: see the comment above this element.
      tabIndex={0}
    >
      <Toolbar />
      <div className="diagram-editor__body">
        <ServicePalette onAddNode={onAddNodeFromPalette} />
        <div className="diagram-editor__canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onViewportChange={onViewportChange}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            snapToGrid
            snapGrid={[16, 16]}
            deleteKeyCode={null}
            defaultEdgeOptions={{ type: "cf-edge" }}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
            <MiniMap
              nodeColor={(node) => {
                const data = node.data as CFNodeData;
                const typeDef = NODE_TYPE_MAP.get(data?.typeId);
                return (
                  CATEGORY_COLORS[typeDef?.category ?? "external"] ?? "#6B7280"
                );
              }}
            />
            <Controls />
          </ReactFlow>
        </div>
        <PropertiesPanel />
      </div>
      <StatusBar readOnly={false} />
    </div>
  );
}
