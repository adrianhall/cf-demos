import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  getNodesBounds,
  MiniMap,
  type Node,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { valueOrDefault } from "@adrianhall/cloudflare-toolkit";
import { useCallback, useEffect, useRef, useState } from "react";
import { CATEGORY_COLORS, NODE_TYPE_MAP } from "../../../catalog";
import {
  getDiagram,
  saveDiagramGraph,
  updateDiagram,
} from "../../api/diagrams";
import type { SharedDiagram } from "../../api/shares";
import { useDiagramLiveSync } from "../../hooks/useDiagramLiveSync";
import { nextClientOpId, useDiagramStore } from "../../stores/diagramStore";
import { edgeTypes } from "./edges/edgeTypes";
import { LiveUpdateToast } from "./LiveUpdateToast";
import { nodeTypes } from "./nodes/nodeTypes";
import { DetailsPanel } from "./panels/DetailsPanel";
import { ServicePalette } from "./panels/ServicePalette";
import { RemoteCursorsOverlay } from "./RemoteCursorsOverlay";
import { StatusBar } from "./toolbar/StatusBar";
import { Toolbar } from "./toolbar/Toolbar";
import type { CFEdgeData, CFNodeData } from "./types";

/** Debounce interval, in milliseconds, before an unsaved change autosaves. */
const AUTOSAVE_DEBOUNCE_MS = 500;
/** Debounce interval, in milliseconds, before a title change is persisted. */
const TITLE_SAVE_DEBOUNCE_MS = 1_000;
/** Delay, in milliseconds, between fitting the view for print and opening the print dialog --
 * gives the browser one paint to apply the fitted viewport before `window.print()` snapshots it. */
const PRINT_DIALOG_DELAY_MS = 300;
/** Body class applied while the canvas is in print mode; toggled print-only rules in
 * `../app.css` key off of it. */
const PRINT_MODE_BODY_CLASS = "diagram-editor-print-mode";
/** DOM id for the injected `@page` orientation `<style>` element, removed again on exit. */
const PRINT_ORIENTATION_STYLE_ID = "diagram-editor-print-orientation";

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
 * palette, keyboard shortcuts (Delete, Ctrl+Z, Ctrl+Shift+Z), print mode (Phase 5), and renders
 * the full editor layout (toolbar, palette, canvas, properties panel, status bar). Ported from
 * CF-Architect's `src/islands/DiagramCanvas.tsx`.
 *
 * Also serves as the anonymous read-only share viewer (`../../views/ShareView.tsx`) via
 * `readOnly`/`initialDiagram`, matching CF-Architect's own single-component design (its
 * `readOnly` prop guards the same effects and hides the same editing UI this port's does) rather
 * than a second, near-duplicate component: every editing effect below (autosave, title save, the
 * unload guard, keyboard shortcuts) is a no-op in read-only mode, and the palette/properties
 * panel simply are not rendered.
 *
 * @param diagramId Diagram id to load and autosave, taken from the current URL
 * (`../../views/EditorView.tsx`), or already known by `initialDiagram` in read-only mode.
 * @param readOnly When `true`, disables every editing affordance (autosave, palette,
 * properties panel, undo/redo, keyboard shortcuts) and renders an immutable graph.
 * @param initialDiagram When `readOnly` is `true`, the diagram's fields already fetched by
 * `GET /api/share/:token` (an anonymous, unauthenticated call) -- read-only mode never calls the
 * owner-authenticated `getDiagram()` at all, since an anonymous viewer cannot.
 */
export function DiagramCanvas({
  diagramId,
  readOnly = false,
  initialDiagram,
}: {
  diagramId: string;
  readOnly?: boolean;
  initialDiagram?: Pick<SharedDiagram, "title" | "description" | "graphData">;
}) {
  const { fitView, getNodes, screenToFlowPosition } = useReactFlow();
  const nodesInitialized = useNodesInitialized();

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
    selectedNodeId,
    selectedEdgeId,
    undo,
    redo,
    dirty,
    markSaving,
    markSaved,
    markSaveError,
    title,
    description,
    printMode,
    setPrintMode,
    paletteOpen,
    propertiesOpen,
    minimapOpen,
  } = useDiagramStore();

  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (readOnly && initialDiagram) {
      const parsed = parseGraphData(initialDiagram.graphData);
      // A read-only share viewer has no `updatedAt` of its own to seed
      // (`../../api/shares.ts`'s `SharedDiagram`) and never opens the live-sync WebSocket
      // (`useDiagramLiveSync` below is disabled for `readOnly`), so `null` is never compared
      // against here. `SharedDiagram` also deliberately never carries `ownerEmail` (a public
      // share must never leak who owns the diagram it points to), so `ownerEmail` is `null` too
      // -- matching `useDiagramStore`'s `ownerEmail` JSDoc.
      setDiagram(
        diagramId,
        null,
        initialDiagram.title,
        initialDiagram.description ?? "",
        parsed.nodes,
        parsed.edges,
        parsed.viewport,
        null,
      );
      return;
    }

    let cancelled = false;
    getDiagram(diagramId)
      .then((diagram) => {
        if (cancelled) return;
        const parsed = parseGraphData(diagram.graphData);
        setDiagram(
          diagramId,
          diagram.ownerEmail,
          diagram.title,
          diagram.description ?? "",
          parsed.nodes,
          parsed.edges,
          parsed.viewport,
          diagram.updatedAt,
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
  }, [diagramId, setDiagram, readOnly, initialDiagram]);

  // Live-sync: an open editor tab both sends its own edits and visibly updates the instant
  // another identity's edit -- human or a 9B MCP tool call -- changes this diagram
  // (docs/09C-COLLABORATIVE-EDITING.md's Live-Editing Architecture). Disabled in read-only mode
  // -- the anonymous share viewer authenticates via a share token, not a Cloudflare Access
  // identity, and could never pass `/api/diagrams/:id/live`'s access check anyway. Declared
  // ahead of the autosave effect below, which reads `connected`/`sendOperation` to decide
  // whether to flush queued operations over the socket or fall back to the `PUT`-based autosave.
  const diagramLoaded = useDiagramStore((state) => state.diagramId !== null);
  const {
    connected,
    sendOperation,
    participants,
    cursors,
    remoteSelections,
    sendCursor,
    sendSelectionChange,
    chatTranscript,
    chatInFlight,
    sendChatMessage,
    stopChatTurn,
    clearChatTranscript,
  } = useDiagramLiveSync(diagramLoaded ? diagramId : null, !readOnly);

  // Relay this tab's own current selection to every other connected identity
  // (docs/09C-COLLABORATIVE-EDITING.md's Phase 19 Message Protocol) whenever it changes. Never
  // runs in read-only mode -- the anonymous share viewer has no live-sync connection to send
  // over (`useDiagramLiveSync` is disabled there above).
  useEffect(() => {
    if (readOnly) return;
    sendSelectionChange(selectedNodeId, selectedEdgeId);
  }, [readOnly, selectedNodeId, selectedEdgeId, sendSelectionChange]);

  // Debounced flush of unsaved changes, on the same timer regardless of which path it takes.
  // `dirty` never becomes true in read-only mode -- nothing wires `onNodesChange`/
  // `onEdgesChange`/`onConnect`/`addNode` there -- but the explicit `readOnly` guard documents
  // that intent directly, matching CF-Architect's own structure, rather than relying on that
  // indirectly.
  //
  // While the live socket is connected, this sends every queued discrete operation
  // (`../../stores/diagramStore.ts`'s `pendingOperations`) instead of the whole graph --
  // docs/09C-COLLABORATIVE-EDITING.md's "Retiring The Whole-Graph Autosave." While it is not
  // (not yet connected, or dropped), this keeps doing exactly what it always did: `PUT` the
  // entire graph. A successful `PUT` also discards any operations queued while disconnected --
  // they describe changes that `PUT` just persisted in full, so resending them once the socket
  // reconnects would risk applying an `add_node`/`add_edge` a second time.
  useEffect(() => {
    if (readOnly || !dirty) return;

    const timer = setTimeout(() => {
      if (connected) {
        const ops = useDiagramStore.getState().drainPendingOperations();
        for (const op of ops) {
          sendOperation(op, nextClientOpId());
        }
        markSaved(new Date().toISOString());
        return;
      }

      void (async () => {
        markSaving();
        try {
          const state = useDiagramStore.getState();
          const graphData = JSON.stringify({
            nodes: state.nodes,
            edges: state.edges,
            viewport: state.viewport,
          });
          const updatedAt = await saveDiagramGraph(diagramId, graphData);
          useDiagramStore.getState().drainPendingOperations();
          markSaved(updatedAt);
        } catch (error) {
          markSaveError(
            error instanceof Error ? error.message : "Failed to save.",
          );
        }
      })();
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [
    readOnly,
    dirty,
    diagramId,
    connected,
    sendOperation,
    markSaving,
    markSaved,
    markSaveError,
  ]);

  // Warn before leaving with unsaved changes. Not attached at all in read-only mode, which never
  // has any.
  useEffect(() => {
    if (readOnly) return;
    const handler = (event: BeforeUnloadEvent) => {
      if (useDiagramStore.getState().dirty) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [readOnly]);

  // Persist title changes independently of the graph autosave, matching CF-Architect's
  // separate, slightly longer debounce for the (much smaller, much less frequently updated)
  // metadata write. Never runs in read-only mode -- there is no `updateDiagram()` call an
  // anonymous viewer is even authorized to make.
  useEffect(() => {
    if (readOnly || !diagramLoaded) return;
    const timer = setTimeout(() => {
      updateDiagram(diagramId, { title }).catch(() => {
        /* the title autosave failing silently matches CF-Architect's own behavior; the
           graph autosave surfaces failures in the status bar, which is the save signal
           users actually watch. */
      });
    }, TITLE_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [title, diagramLoaded, diagramId, readOnly]);

  // Fit the freshly loaded diagram's nodes into view once, covering both a brand-new diagram
  // (e.g. created from a blueprint like "API Gateway") and reopening an existing one (Bug 29,
  // docs/09-ARCHITECT.md Phase 9). `<ReactFlow>`'s own `fitView` prop below only fits once, at
  // first mount, using whatever node dimensions are available *at that instant* -- but this
  // custom `CFNode` renderer (`./nodes/CFNode.tsx`) has no explicit width/height, so its real
  // size isn't known until the browser has actually laid it out, which happens slightly after
  // that first mount. The prop's fit therefore ran against effectively unmeasured (zero-size)
  // nodes, computing a viewport that left every real, later-measured node scrolled out of
  // frame. `useNodesInitialized()` flips to `true` only once every node has a real measured
  // size, so re-fitting then (rather than relying on the mount-time prop alone) reliably frames
  // the actual rendered diagram. Fits only once per mount (guarded by `fittedOnLoadRef`) so it
  // never fights a user's own subsequent pan/zoom.
  const fittedOnLoadRef = useRef(false);
  useEffect(() => {
    if (fittedOnLoadRef.current || !diagramLoaded || !nodesInitialized) {
      return;
    }
    fittedOnLoadRef.current = true;
    void fitView({ duration: 0 });
  }, [diagramLoaded, nodesInitialized, fitView]);

  // Print mode side effects: force a light color scheme, choose a page orientation matching the
  // diagram's own aspect ratio, fit the view, and trigger the browser print dialog. Ported from
  // CF-Architect's own `DiagramCanvas` effect (docs/09-ARCHITECT.md Phase 5), adapted for this
  // port's `color-scheme`-driven theming (`../../lib/theme.ts`) instead of CF-Architect's `.dark`
  // class toggle. Runs identically in read-only mode -- print mode is available to anonymous
  // share viewers too (`./toolbar/PrintButton.tsx`).
  useEffect(() => {
    if (!printMode) return;

    const previousColorScheme = document.documentElement.style.colorScheme;
    document.documentElement.style.colorScheme = "light";
    document.body.classList.add(PRINT_MODE_BODY_CLASS);

    const flowNodes = getNodes();
    let isLandscape = true;
    if (flowNodes.length > 0) {
      const bounds = getNodesBounds(flowNodes);
      isLandscape = bounds.width > bounds.height;
    }
    const orientationStyle = document.createElement("style");
    orientationStyle.id = PRINT_ORIENTATION_STYLE_ID;
    orientationStyle.textContent = `@page { size: ${isLandscape ? "landscape" : "portrait"}; margin: 0.5in; }`;
    document.head.appendChild(orientationStyle);

    const cleanup = () => {
      document.documentElement.style.colorScheme = previousColorScheme;
      document.body.classList.remove(PRINT_MODE_BODY_CLASS);
      document.getElementById(PRINT_ORIENTATION_STYLE_ID)?.remove();
    };

    const exitPrintMode = () => {
      cleanup();
      setPrintMode(false);
    };
    window.addEventListener("afterprint", exitPrintMode);

    const rafId = requestAnimationFrame(() => {
      void fitView({ duration: 0 });
      setTimeout(() => window.print(), PRINT_DIALOG_DELAY_MS);
    });

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("afterprint", exitPrintMode);
      cleanup();
    };
  }, [printMode, fitView, getNodes, setPrintMode]);

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

  /** Relay this tab's own cursor position (converted from screen to flow-space coordinates)
   * to every other connected identity, client-throttled inside `sendCursor()` itself. Skipped
   * in read-only/print mode -- neither has a live-sync connection or a canvas anyone else is
   * watching live. */
  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (readOnly || printMode) return;
      const { x, y } = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      sendCursor(x, y);
    },
    [readOnly, printMode, screenToFlowPosition, sendCursor],
  );

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
      if (readOnly) return;

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
    [readOnly, removeSelected, undo, redo],
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
      className={`diagram-editor${printMode ? " diagram-editor--print" : ""}`}
      role="application"
      aria-label="Diagram editor"
      onKeyDown={onKeyDown}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: see the comment above this element.
      tabIndex={0}
    >
      {/* Visually hidden top-level heading (Bug 19): without it, the first heading a
          screen-reader user reaches is `ServicePalette`'s "Services" <h2>, skipping a level,
          and the diagram's own title (`Toolbar.tsx`'s <input>) is never exposed as a heading at
          all. Kept in sync with the store's `title`; also covers the read-only share viewer
          (`../../views/ShareView.tsx`), which renders this same component. */}
      <h1 className="visually-hidden">{title} — Diagram editor</h1>
      {!printMode && (
        <Toolbar readOnly={readOnly} participants={participants} />
      )}
      <div className="diagram-editor__body">
        {!readOnly && !printMode && paletteOpen && (
          <ServicePalette onAddNode={onAddNodeFromPalette} />
        )}
        <div className="diagram-editor__canvas">
          {!readOnly && !printMode && <LiveUpdateToast />}
          {printMode && (
            <div className="diagram-editor__print-overlay">
              <div className="diagram-editor__print-title-box">
                <h2 className="diagram-editor__print-title">{title}</h2>
                {description && (
                  <p className="diagram-editor__print-description">
                    {description}
                  </p>
                )}
              </div>
            </div>
          )}
          {printMode && (
            <button
              type="button"
              className="diagram-editor__print-exit"
              onClick={() => setPrintMode(false)}
              title="Exit print mode"
              aria-label="Exit print mode"
            >
              ← Back
            </button>
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={readOnly ? undefined : onNodesChange}
            onEdgesChange={readOnly ? undefined : onEdgesChange}
            onConnect={readOnly ? undefined : onConnect}
            onViewportChange={onViewportChange}
            onDragOver={readOnly ? undefined : onDragOver}
            onDrop={readOnly ? undefined : onDrop}
            onPointerMove={onPointerMove}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            // No `fitView` prop here: it only fits once, at first mount, using whatever node
            // dimensions are available at that instant -- unreliable for `CFNode`'s unmeasured
            // custom size (Bug 29 above). The `fittedOnLoadRef` effect above fits reliably once
            // real node measurements are available instead.
            snapToGrid
            snapGrid={[16, 16]}
            deleteKeyCode={null}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            defaultEdgeOptions={{ type: "cf-edge" }}
          >
            {!printMode && (
              <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
            )}
            {!printMode && minimapOpen && (
              <MiniMap
                nodeColor={(node) => {
                  const data = node.data as CFNodeData;
                  const typeDef = NODE_TYPE_MAP.get(data?.typeId);
                  const category = valueOrDefault(
                    typeDef?.category,
                    "external",
                  );
                  return CATEGORY_COLORS[category];
                }}
              />
            )}
            {!printMode && <Controls showInteractive={!readOnly} />}
            {!printMode && !readOnly && (
              <RemoteCursorsOverlay
                cursors={cursors}
                remoteSelections={remoteSelections}
              />
            )}
          </ReactFlow>
        </div>
        {!readOnly && !printMode && propertiesOpen && (
          <DetailsPanel
            chatTranscript={chatTranscript}
            chatInFlight={chatInFlight}
            sendChatMessage={sendChatMessage}
            stopChatTurn={stopChatTurn}
            clearChatTranscript={clearChatTranscript}
          />
        )}
      </div>
      {!printMode && <StatusBar readOnly={readOnly} />}
    </div>
  );
}
