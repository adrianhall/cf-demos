import { useCallback, useEffect, useRef, useState } from 'react';
import { valueOrDefault } from '@adrianhall/cloudflare-toolkit';
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  ReactFlow,
  useNodesInitialized,
  useReactFlow
} from '@xyflow/react';
import { CATEGORY_COLORS, NODE_TYPE_MAP } from '../../../catalog.ts';
import { CF_EDGE_TYPE, CF_NODE_TYPE } from '../../../graph-element-types.ts';
import { getDiagram, saveDiagramGraph, updateDiagram } from '../../api/diagrams.ts';
import type { SharedDiagram } from '../../api/shares.ts';
import { useDiagramStore } from '../../stores/diagramStore.ts';
import { edgeTypes } from './edges/edgeTypes.ts';
import { nodeTypes } from './nodes/nodeTypes.ts';
import { DetailsPanel } from './panels/DetailsPanel.tsx';
import { ServicePalette } from './panels/ServicePalette.tsx';
import { StatusBar } from './toolbar/StatusBar.tsx';
import { Toolbar } from './toolbar/Toolbar.tsx';
import type { CFEdgeData, CFNodeData } from './types.ts';

/**
 * How long after the last change the graph is saved, in milliseconds.
 *
 * Short enough that a visitor who stops to think has already been saved, long enough that dragging
 * a node across the canvas is one save rather than fifty.
 */
const AUTOSAVE_DEBOUNCE_MS = 500;

/**
 * How long after the last keystroke the title is saved, in milliseconds.
 *
 * Longer than the graph's: a title is typed a character at a time, and each save is a whole request
 * for a field nobody is racing to persist.
 */
const TITLE_SAVE_DEBOUNCE_MS = 1_000;

/**
 * Grid, in pixels, that dragged nodes snap to. Alignment by construction rather than by eye.
 */
const SNAP_GRID: [number, number] = [16, 16];

/**
 * How long to wait after fitting the view before opening the print dialog, in milliseconds.
 *
 * `window.print()` snapshots the page synchronously, so it has to run after the browser has
 * actually painted the fitted viewport. One frame is not reliably enough — the fit animates the
 * transform — so this is a deliberate short wait rather than a `requestAnimationFrame`.
 */
const PRINT_DIALOG_DELAY_MS = 300;

/**
 * Class applied to `<body>` while the canvas is in print mode, which the stylesheet's print-only
 * rules key off.
 */
const PRINT_MODE_BODY_CLASS = 'diagram-editor-print-mode';

/**
 * Id of the `<style>` element carrying the chosen `@page` orientation, so it can be removed again
 * on the way out.
 */
const PRINT_ORIENTATION_STYLE_ID = 'diagram-editor-print-orientation';

/**
 * A diagram's graph, parsed.
 */
interface ParsedGraphData {
  /**
   * Nodes on the canvas.
   */
  nodes: Node<CFNodeData>[];
  /**
   * Edges on the canvas.
   */
  edges: Edge<CFEdgeData>[];
  /**
   * Stored pan and zoom.
   */
  viewport: { x: number; y: number; zoom: number };
}

/**
 * Parses a diagram's stored graph.
 *
 * Tolerant on purpose: an empty, truncated or unparseable value yields an empty canvas rather than
 * an exception. The alternative is an editor that refuses to open at all, which leaves the visitor
 * with no way to repair the diagram — whereas an empty canvas they can rebuild and save over is
 * recoverable.
 *
 * @param graphData Stored JSON string.
 * @returns The parsed graph, with every missing field defaulted.
 */
function parseGraphData(graphData: string): ParsedGraphData {
  try {
    const parsed = JSON.parse(graphData || '{}') as Partial<ParsedGraphData>;
    return {
      edges: parsed.edges ?? [],
      nodes: parsed.nodes ?? [],
      viewport: parsed.viewport ?? { x: 0, y: 0, zoom: 1 }
    };
  } catch {
    return { edges: [], nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  }
}

/**
 * Props for {@link DiagramCanvas}.
 */
export interface DiagramCanvasProps {
  /**
   * Id of the diagram to load, taken from the path by the app shell.
   */
  diagramId: string;
  /**
   * Whether the canvas is read-only — the anonymous share viewer's posture.
   *
   * Every editing affordance is withheld rather than disabled, and every editing effect is skipped
   * rather than left to find nothing to do.
   */
  readOnly?: boolean;
  /**
   * The diagram's fields, already fetched by the public share resolver.
   *
   * Required when `readOnly` is set, and the reason the two props travel together: an anonymous
   * viewer has no Access identity and therefore cannot call the owner-authenticated read this
   * component otherwise makes. Passing the already-resolved diagram in is what lets one component
   * serve both postures instead of a near-duplicate being written for the viewer.
   */
  initialDiagram?: SharedDiagram;
}

/**
 * The architecture canvas: the editor's working surface, and the anonymous share viewer's.
 *
 * It loads the diagram, autosaves it, and wires every way of changing it — dragging a service in
 * from the palette, activating one from the keyboard, selecting, deleting, undoing and redoing — to
 * the store that keeps those changes in step with the save state.
 *
 * Every mutation goes through that store rather than through local state, which is what makes the
 * autosave below correct: it reads the graph at the moment the timer fires, so it always sends the
 * canvas as it actually stands rather than as it stood when the change that scheduled it happened.
 *
 * **Read-only mode** is one component rather than two because the difference is genuinely a set of
 * omissions: the same graph, the same renderers, the same geometry, with every editing effect
 * skipped and every editing control absent. A second component would be this file with its verbs
 * removed, and would drift from it the first time a node renderer changed. Each `readOnly` guard
 * below is written explicitly even where the effect would be inert anyway — `dirty` never becomes
 * true when nothing can change the graph — because an inert effect is an accident of the current
 * wiring, and the guard is the statement of intent.
 *
 * @param props Diagram id and, for the share viewer, the already-resolved diagram; see
 *   {@link DiagramCanvasProps}.
 * @returns The canvas, a loading state, or the failure that stopped it loading.
 */
export function DiagramCanvas({ diagramId, readOnly = false, initialDiagram }: DiagramCanvasProps) {
  const { fitView, getNodes, getNodesBounds, screenToFlowPosition } = useReactFlow();
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
    minimapOpen
  } = useDiagramStore();

  const [loadError, setLoadError] = useState<string | null>(null);
  const diagramLoaded = useDiagramStore((state) => state.diagramId !== null);

  useEffect(() => {
    // The share viewer's diagram arrived with the props, resolved anonymously by `/api/shares`.
    // Calling `getDiagram` here would be a request an anonymous visitor is not authorized to
    // make, and would answer `401` for a page they are entitled to see.
    if (readOnly && initialDiagram) {
      const parsed = parseGraphData(initialDiagram.graphData);
      setDiagram(
        diagramId,
        initialDiagram.title,
        initialDiagram.description ?? '',
        parsed.nodes,
        parsed.edges,
        parsed.viewport
      );
      return undefined;
    }

    let cancelled = false;

    getDiagram(diagramId)
      .then((diagram) => {
        // The guard matters because the store outlives this component: committing a diagram that
        // arrived after the visitor navigated away would leave the next editor showing it.
        if (cancelled) {
          return;
        }
        const parsed = parseGraphData(diagram.graphData);
        setDiagram(
          diagramId,
          diagram.title,
          diagram.description ?? '',
          parsed.nodes,
          parsed.edges,
          parsed.viewport
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Could not load diagram.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [diagramId, setDiagram, readOnly, initialDiagram]);

  // Autosave. The whole graph every time: there is no partial-patch protocol, so a save is a
  // complete statement of the canvas rather than a difference against whatever the server holds.
  useEffect(() => {
    if (readOnly || !dirty) {
      return undefined;
    }

    const timer = setTimeout(() => {
      void (async () => {
        markSaving();
        try {
          // Read at this moment rather than captured when the effect ran, so a change made during
          // the debounce is included rather than silently dropped.
          const state = useDiagramStore.getState();
          await saveDiagramGraph(
            diagramId,
            JSON.stringify({ edges: state.edges, nodes: state.nodes, viewport: state.viewport })
          );
          markSaved();
        } catch (error) {
          markSaveError(error instanceof Error ? error.message : 'Failed to save.');
        }
      })();
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [readOnly, dirty, diagramId, markSaving, markSaved, markSaveError]);

  // The last line of defence for unsaved work: a visitor who closes the tab within the debounce
  // window is asked first. The browser shows its own wording, so there is no message to provide.
  // Not attached at all in read-only mode, which never has unsaved work to lose.
  useEffect(() => {
    if (readOnly) {
      return undefined;
    }

    const handler = (event: BeforeUnloadEvent): void => {
      if (useDiagramStore.getState().dirty) {
        event.preventDefault();
      }
    };

    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [readOnly]);

  // The title saves on its own timer rather than with the graph: it is metadata, it changes a
  // character at a time, and bundling it with the graph would send the whole canvas on every
  // keystroke. A failure here is deliberately silent — the status bar reports the graph's save
  // state, which is the one a visitor is watching, and a toast about a title that will be retried
  // on the next keystroke would be noise.
  useEffect(() => {
    if (readOnly || !diagramLoaded) {
      return undefined;
    }

    const timer = setTimeout(() => {
      updateDiagram(diagramId, { title }).catch(() => {
        /* Retried by the next keystroke; the graph's own save state is what is reported. */
      });
    }, TITLE_SAVE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [readOnly, title, diagramLoaded, diagramId]);

  // Fit the loaded diagram into view once it can actually be measured. React Flow's own `fitView`
  // prop fits at mount, against nodes that have no size yet: `CFNode` is sized by its content, so
  // at that instant every node is zero by zero and the computed viewport leaves the real diagram
  // off screen. `useNodesInitialized()` turns true only once every node has been measured, which
  // is the first moment the fit can be correct. The ref keeps it to once per mount, so it never
  // fights a visitor's own panning afterwards.
  const fittedOnLoadRef = useRef(false);
  useEffect(() => {
    if (fittedOnLoadRef.current || !diagramLoaded || !nodesInitialized) {
      return;
    }
    fittedOnLoadRef.current = true;
    void fitView({ duration: 0 });
  }, [diagramLoaded, nodesInitialized, fitView]);

  // Print mode. The button only sets the flag; everything printing actually requires happens
  // here, because all of it is about the document and the viewport rather than about a control.
  //
  // Four things have to be true for a printed diagram to be usable, and only the last is
  // obvious:
  //
  // - **A light colour scheme, forced.** A dark-mode diagram prints as a page of black ink. The
  //   override is an inline `color-scheme` rather than a class, because that is what drives
  //   every `light-dark()` value in the stylesheet — see `../../lib/theme.ts`.
  // - **An orientation matching the diagram.** A wide architecture on a portrait page is
  //   scaled down to nothing. The `@page` rule is injected rather than written in the stylesheet
  //   because the choice depends on this diagram's actual shape.
  // - **A fitted viewport.** Printing captures the page as it stands, so whatever the visitor had
  //   panned to is what would land on the paper.
  // - **The dialog itself**, one short wait later, so the browser has painted the fit first.
  //
  // Every one of them is undone on the way out, including when the effect is torn down by an
  // unmount mid-print: leaving the scheme forced would silently disable the appearance control.
  useEffect(() => {
    if (!printMode) {
      return undefined;
    }

    const previousColorScheme = document.documentElement.style.colorScheme;
    document.documentElement.style.colorScheme = 'light';
    document.body.classList.add(PRINT_MODE_BODY_CLASS);

    const flowNodes = getNodes();
    // Landscape for an empty diagram: there is no shape to infer one from, and a printed page of
    // a blank canvas is the same either way.
    const bounds = flowNodes.length > 0 ? getNodesBounds(flowNodes) : null;
    const isLandscape = bounds === null || bounds.width > bounds.height;

    const orientationStyle = document.createElement('style');
    orientationStyle.id = PRINT_ORIENTATION_STYLE_ID;
    orientationStyle.textContent = `@page { size: ${
      isLandscape ? 'landscape' : 'portrait'
    }; margin: 0.5in; }`;
    document.head.appendChild(orientationStyle);

    /**
     * Returns the document to the state it was in before print mode.
     *
     * @returns Nothing.
     */
    const restoreDocument = (): void => {
      document.documentElement.style.colorScheme = previousColorScheme;
      document.body.classList.remove(PRINT_MODE_BODY_CLASS);
      document.getElementById(PRINT_ORIENTATION_STYLE_ID)?.remove();
    };

    /**
     * Leaves print mode once the browser's print dialog has closed.
     *
     * Listening for `afterprint` rather than assuming the dialog succeeded is what returns the
     * editor to normal after a cancelled print as well as a completed one.
     *
     * @returns Nothing.
     */
    const exitPrintMode = (): void => {
      restoreDocument();
      setPrintMode(false);
    };

    window.addEventListener('afterprint', exitPrintMode);

    const frame = requestAnimationFrame(() => {
      void fitView({ duration: 0 });
      setTimeout(() => window.print(), PRINT_DIALOG_DELAY_MS);
    });

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('afterprint', exitPrintMode);
      restoreDocument();
    };
  }, [printMode, fitView, getNodes, getNodesBounds, setPrintMode]);

  /**
   * Adds a service dropped from the palette, at the point it was dropped.
   *
   * @param event Drop event carrying the catalogue type.
   * @returns Nothing.
   */
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const typeId = event.dataTransfer.getData('application/cf-node-type');
      const typeDef = NODE_TYPE_MAP.get(typeId);
      // Ignored rather than guessed at: a drag from outside the palette — a file, a link, another
      // tab — carries no type of ours, and inventing a node for it would be surprising.
      if (!typeId || !typeDef) {
        return;
      }

      addNode({
        data: { description: '', label: typeDef.label, typeId },
        id: `${typeId}-${Date.now()}`,
        position: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
        type: CF_NODE_TYPE
      });
    },
    [screenToFlowPosition, addNode]
  );

  /**
   * Allows a drop to land. Without this the browser's default refuses it and the drop never fires.
   *
   * @param event Drag-over event.
   * @returns Nothing.
   */
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  /**
   * Adds a service activated from the palette without a pointer, at the centre of the viewport.
   *
   * The centre because there is no drop point to use: a keyboard activation has no coordinates, and
   * the middle of what the visitor is looking at is where they can see the result arrive.
   *
   * @param typeId Catalogue type to add.
   * @returns Nothing.
   */
  const onAddNodeFromPalette = useCallback(
    (typeId: string) => {
      const typeDef = NODE_TYPE_MAP.get(typeId);
      if (!typeDef) {
        return;
      }

      addNode({
        data: { description: '', label: typeDef.label, typeId },
        id: `${typeId}-${Date.now()}`,
        position: screenToFlowPosition({
          x: window.innerWidth / 2,
          y: window.innerHeight / 2
        }),
        type: CF_NODE_TYPE
      });
    },
    [screenToFlowPosition, addNode]
  );

  const onNodeClick = useCallback(
    (_event: unknown, node: { id: string }) => setSelectedNode(node.id),
    [setSelectedNode]
  );

  const onEdgeClick = useCallback(
    (_event: unknown, edge: { id: string }) => setSelectedEdge(edge.id),
    [setSelectedEdge]
  );

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
  }, [setSelectedNode, setSelectedEdge]);

  /**
   * The canvas's keyboard shortcuts: delete the selection, undo, and redo.
   *
   * @param event Key event from the canvas region.
   * @returns Nothing.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Nothing on a read-only canvas can be deleted, undone or redone, so the shortcuts are not
      // merely inert here — they must not swallow a Backspace the browser would otherwise treat
      // as "go back".
      if (readOnly) {
        return;
      }

      const target = event.target as HTMLElement;
      // Deleting the selection while somebody is editing a text field would turn Backspace in the
      // title box into "delete the selected node", which is the single most destructive way this
      // editor could misread a keystroke.
      const isEditing =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      if ((event.key === 'Delete' || event.key === 'Backspace') && !isEditing) {
        removeSelected();
      }
      if (event.ctrlKey && event.key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      }
      if (event.ctrlKey && event.shiftKey && event.key === 'Z') {
        event.preventDefault();
        redo();
      }
    },
    [readOnly, removeSelected, undo, redo]
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
    // `role="application"` tells assistive technology that this region handles its own keys, which
    // is exactly true here: Delete, Ctrl+Z and Ctrl+Shift+Z mean something inside the canvas that
    // they do not mean on an ordinary page, and a screen reader needs to stop intercepting them.
    // `tabIndex={0}` is what lets a keyboard user reach that region at all — without it the
    // shortcuts exist and nothing can focus them.
    //
    // Both lint rules below treat a keyboard handler on a non-interactive element as a mistake,
    // because it usually is. Their allowlists do not include `application`, which is the one role
    // whose entire purpose is handling its own keys; moving the handler to a button or a link, as
    // they suggest, would mean a canvas that cannot be typed into. The behaviour is covered by the
    // keyboard cases in `tests/client/DiagramCanvas.test.tsx`.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className={`diagram-editor${printMode ? ' diagram-editor--print' : ''}`}
      role="application"
      aria-label="Diagram editor"
      onKeyDown={onKeyDown}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
    >
      {/* The page's heading, visually hidden because the title is already on screen in the
          toolbar as an editable field — which is not a heading, so without this the first heading
          a screen-reader user meets is the palette's "Services" and the diagram they opened is
          never announced at all. */}
      <h1 className="visually-hidden">{title} — Diagram editor</h1>
      {/* Print mode strips the editor down to the diagram itself: the toolbar, the panels, the
          status bar, the background grid, the minimap and the canvas controls are all chrome,
          and none of them belongs on paper. */}
      {!printMode && <Toolbar readOnly={readOnly} />}
      <div className="diagram-editor__body">
        {!readOnly && !printMode && paletteOpen && (
          <ServicePalette onAddNode={onAddNodeFromPalette} />
        )}
        <div className="diagram-editor__canvas">
          {/* The printed page's own title block. The editor shows the title in the toolbar,
              which print mode has just removed, so without this the paper carries a diagram with
              no name on it. Pointer-inert, so it cannot intercept a click on the canvas beneath
              during the moment before the dialog opens. */}
          {printMode && (
            <div className="diagram-editor__print-overlay">
              <div className="diagram-editor__print-title-box">
                <h2 className="diagram-editor__print-title">{title}</h2>
                {description && <p className="diagram-editor__print-description">{description}</p>}
              </div>
            </div>
          )}
          {/* The way out if the browser never fires `afterprint` — a cancelled dialog in some
              browsers, or a printing path that simply does not. Hidden by the stylesheet's own
              `@media print` rule, so it is never on the paper it exists to escape from. */}
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
            // The handlers are withheld rather than guarded internally, so React Flow itself stops
            // offering the interaction: with no `onConnect` there is no connection to start, and
            // with no `onDrop` the canvas is not a drop target at all.
            onNodesChange={readOnly ? undefined : onNodesChange}
            onEdgesChange={readOnly ? undefined : onEdgesChange}
            onConnect={readOnly ? undefined : onConnect}
            // Panning and zooming stay live in both postures: moving around a diagram is reading
            // it, not editing it.
            onViewportChange={onViewportChange}
            onDragOver={readOnly ? undefined : onDragOver}
            onDrop={readOnly ? undefined : onDrop}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            snapToGrid
            snapGrid={SNAP_GRID}
            // React Flow's own delete key is turned off because this canvas handles Delete
            // itself, above: leaving both on would delete through two code paths, only one of
            // which records undo history.
            deleteKeyCode={null}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            defaultEdgeOptions={{ type: CF_EDGE_TYPE }}
          >
            {!printMode && <Background variant={BackgroundVariant.Dots} gap={16} size={1} />}
            {!printMode && minimapOpen && (
              <MiniMap
                nodeColor={(node) => {
                  const data = node.data as CFNodeData;
                  const typeDef = NODE_TYPE_MAP.get(data?.typeId);
                  return CATEGORY_COLORS[valueOrDefault(typeDef?.category, 'external')];
                }}
              />
            )}
            {/* `showInteractive` hides React Flow's own lock control, which would otherwise be a
                tab stop offering to unlock a canvas this visitor may not edit. */}
            {!printMode && <Controls showInteractive={!readOnly} />}
          </ReactFlow>
        </div>
        {/* The details panel edits the selection, so it is absent rather than disabled — a
            read-only visitor who selects a node has nothing to change about it. */}
        {!readOnly && !printMode && propertiesOpen && <DetailsPanel />}
      </div>
      {!printMode && <StatusBar readOnly={readOnly} />}
    </div>
  );
}
