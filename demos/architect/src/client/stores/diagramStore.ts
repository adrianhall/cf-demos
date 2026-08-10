/**
 * Zustand store for the diagram editor canvas.
 *
 * Holds the complete client-side state for a single diagram editing session: React Flow graph
 * state (nodes, edges, viewport), selection tracking, save status, and a session-scoped
 * undo/redo history stack. All canvas mutations flow through this store so that the dirty flag
 * and history are kept in sync. Ported from CF-Architect's `src/islands/store/diagramStore.ts`
 * (docs/09-ARCHITECT.md) -- the store shape itself needed no changes for this host app.
 */
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
  type Viewport,
} from "@xyflow/react";
import { create } from "zustand";
import {
  chooseConnectionHandles,
  validateConnection,
} from "../components/editor/connect";
import type { CFEdgeData, CFNodeData } from "../components/editor/types";

/** A snapshot of the node and edge arrays for undo/redo. */
interface HistoryEntry {
  nodes: Node<CFNodeData>[];
  edges: Edge<CFEdgeData>[];
}

/** Read-only state slice of the diagram store. */
interface DiagramState {
  /** UUID of the currently loaded diagram, or null before initial fetch. */
  diagramId: string | null;
  /** User-editable diagram title. */
  title: string;
  /** User-editable diagram description. */
  description: string;

  /** React Flow node array (each node carries {@link CFNodeData}). */
  nodes: Node<CFNodeData>[];
  /** React Flow edge array (each edge carries {@link CFEdgeData}). */
  edges: Edge<CFEdgeData>[];
  /** Current canvas viewport (pan x/y and zoom level). */
  viewport: Viewport;

  /** ID of the currently selected node, or null. */
  selectedNodeId: string | null;
  /** ID of the currently selected edge, or null. */
  selectedEdgeId: string | null;

  /** Whether the graph has unsaved changes since the last successful save. */
  dirty: boolean;
  /** Whether an autosave request is currently in flight. */
  saving: boolean;
  /** Unix timestamp (ms) of the last successful save, or null if never saved. */
  lastSavedAt: number | null;
  /** Human-readable error message from the most recent failed save, or null. */
  saveError: string | null;

  /** Whether the canvas is currently in its print-optimized view mode (Phase 5). */
  printMode: boolean;

  /** Whether the service palette sidebar is visible. Defaults to `true` -- unlike
   * {@link DiagramState.propertiesOpen}, the palette starts open since adding a node is the
   * editor's first action, not a response to a selection. */
  paletteOpen: boolean;
  /** Whether the properties panel sidebar is visible. Defaults to `false` (Bug 4,
   * docs/09-ARCHITECT.md Phase 7): the panel is collapsed until a node or edge is selected --
   * see {@link DiagramActions.setSelectedNode}/{@link DiagramActions.setSelectedEdge}, which open
   * it automatically -- and stays open (showing its empty state) after deselecting, rather than
   * auto-closing, so a user who just closed it by deselecting isn't fighting the panel to keep
   * it open for the next selection. */
  propertiesOpen: boolean;

  /** Stack of previous states for undo. Most recent entry is at the end. */
  undoStack: HistoryEntry[];
  /** Stack of undone states for redo. Most recent entry is at the end. */
  redoStack: HistoryEntry[];
}

/** Mutation actions exposed by the diagram store. */
interface DiagramActions {
  /**
   * Initialise the store with a loaded diagram.
   *
   * @param id Diagram UUID.
   * @param title Diagram title.
   * @param description Diagram description.
   * @param nodes Parsed React Flow nodes.
   * @param edges Parsed React Flow edges.
   * @param viewport Parsed viewport state.
   */
  setDiagram: (
    id: string,
    title: string,
    description: string,
    nodes: Node<CFNodeData>[],
    edges: Edge<CFEdgeData>[],
    viewport: Viewport,
  ) => void;

  /** React Flow `onNodesChange` handler. Pushes history on structural changes (add/remove). */
  onNodesChange: OnNodesChange;
  /** React Flow `onEdgesChange` handler. Pushes history on structural changes (add/remove). */
  onEdgesChange: OnEdgesChange;
  /** React Flow `onConnect` handler. Creates a new `data-flow` edge and pushes history. */
  onConnect: OnConnect;
  /**
   * Create an edge between two nodes by id rather than by pointer-drag, for
   * `../components/editor/toolbar/ConnectNodesModal.tsx` (Bug 8, docs/09-ARCHITECT.md Phase 10):
   * `onConnect` above is wired directly to `@xyflow/react`'s drag-to-connect flow, which has no
   * keyboard/click-only equivalent, so this is the store-level primitive a keyboard-operable UI
   * calls instead. Validates via `../components/editor/connect.ts`'s `validateConnection`
   * (rejects a self-connection or an exact source/target/edge-type duplicate) before mutating
   * anything, resolves handles via that module's `chooseConnectionHandles`, pushes history,
   * marks the graph dirty, and selects the new edge -- which opens the properties panel
   * (see {@link DiagramActions.setSelectedEdge}) so the user lands directly on its fields.
   *
   * @param sourceId Id of an existing node to connect from.
   * @param targetId Id of an existing node to connect to.
   * @param edgeType Catalog edge type (`../../../catalog.ts`'s `EDGE_TYPES`) for the new edge.
   * @returns The new edge's id on success, or `null` when the connection is invalid (nothing is
   * mutated in that case) or either node id does not exist in the current graph.
   */
  connectNodes: (
    sourceId: string,
    targetId: string,
    edgeType: CFEdgeData["edgeType"],
  ) => string | null;
  /** Update the stored viewport (pan/zoom). Does not mark dirty. */
  onViewportChange: (viewport: Viewport) => void;

  /** Add a new node to the canvas. Pushes history before mutating. */
  addNode: (node: Node<CFNodeData>) => void;
  /** Merge partial data into an existing node's `data` payload. */
  updateNodeData: (nodeId: string, data: Partial<CFNodeData>) => void;
  /** Merge partial data into an existing edge's `data` payload. */
  updateEdgeData: (edgeId: string, data: Partial<CFEdgeData>) => void;
  /** Remove all currently selected nodes and edges. Pushes history. */
  removeSelected: () => void;

  /** Set the selected node (clears any edge selection). Opens the properties panel when `id` is
   * non-null; deselecting (`id === null`) leaves the panel's current open state unchanged. */
  setSelectedNode: (id: string | null) => void;
  /** Set the selected edge (clears any node selection). Opens the properties panel when `id` is
   * non-null; deselecting (`id === null`) leaves the panel's current open state unchanged. */
  setSelectedEdge: (id: string | null) => void;

  /** Toggle the service palette sidebar's visibility. */
  togglePalette: () => void;
  /** Toggle the properties panel sidebar's visibility. */
  toggleProperties: () => void;

  /** Update the diagram title and mark dirty. */
  setTitle: (title: string) => void;
  /** Update the diagram description and mark dirty. */
  setDescription: (description: string) => void;

  /** Replace the entire nodes array. Used by auto-layout. */
  setNodes: (nodes: Node<CFNodeData>[]) => void;
  /** Replace the entire edges array. Used by auto-layout. */
  setEdges: (edges: Edge<CFEdgeData>[]) => void;

  /** Set `saving` to true and clear any previous save error. */
  markSaving: () => void;
  /** Set `saving` to false, clear `dirty`, record `lastSavedAt`, clear error. */
  markSaved: () => void;
  /** Record a save failure. */
  markSaveError: (error: string) => void;

  /** Enter or exit print mode. Side effects (forcing light mode, orientation, `window.print()`)
   * live in `../components/editor/DiagramCanvas.tsx`'s print-mode effect, not here. */
  setPrintMode: (printMode: boolean) => void;

  /** Revert to the most recent undo snapshot. No-op if the stack is empty. */
  undo: () => void;
  /** Re-apply the most recently undone snapshot. No-op if the stack is empty. */
  redo: () => void;
  /** Push the current nodes/edges onto the undo stack and clear the redo stack. */
  pushHistory: () => void;
}

/** Maximum number of undo snapshots retained in memory. */
const MAX_HISTORY = 50;

/** Combined state + actions type for the diagram Zustand store. */
export type DiagramStore = DiagramState & DiagramActions;

/**
 * Zustand store hook for diagram editor state.
 *
 * Use inside React components:
 * ```ts
 * const { nodes, edges, addNode } = useDiagramStore();
 * ```
 *
 * Access outside React (e.g. in autosave callbacks):
 * ```ts
 * const state = useDiagramStore.getState();
 * ```
 */
export const useDiagramStore = create<DiagramStore>((set, get) => ({
  diagramId: null,
  title: "Untitled Diagram",
  description: "",
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  selectedNodeId: null,
  selectedEdgeId: null,
  dirty: false,
  saving: false,
  lastSavedAt: null,
  saveError: null,
  printMode: false,
  paletteOpen: true,
  propertiesOpen: false,
  undoStack: [],
  redoStack: [],

  setDiagram: (id, title, description, nodes, edges, viewport) =>
    // `description` is declared as a plain `string` (see `DiagramActions.setDiagram`'s JSDoc),
    // and both real call sites (`../components/editor/DiagramCanvas.tsx`) already normalize a
    // `string | null` API value to `""` before calling this action, so no further fallback is
    // needed -- or reachable -- here.
    set({
      diagramId: id,
      title,
      description,
      nodes,
      edges,
      viewport,
      dirty: false,
      undoStack: [],
      redoStack: [],
    }),

  onNodesChange: (changes: NodeChange[]) => {
    const hasStructuralChange = changes.some(
      (c) => c.type === "remove" || c.type === "add",
    );
    if (hasStructuralChange) get().pushHistory();

    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes) as Node<CFNodeData>[],
      dirty: true,
    }));
  },

  onEdgesChange: (changes: EdgeChange[]) => {
    const hasStructuralChange = changes.some(
      (c) => c.type === "remove" || c.type === "add",
    );
    if (hasStructuralChange) get().pushHistory();

    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges) as Edge<CFEdgeData>[],
      dirty: true,
    }));
  },

  onConnect: (connection: Connection) => {
    get().pushHistory();
    set((state) => ({
      edges: addEdge(
        {
          ...connection,
          type: "cf-edge",
          data: { edgeType: "data-flow" as const },
        },
        state.edges,
      ),
      dirty: true,
    }));
  },

  connectNodes: (sourceId, targetId, edgeType) => {
    const state = get();
    const reason = validateConnection({
      edgeType,
      edges: state.edges,
      sourceId,
      targetId,
    });
    if (reason) return null;

    const sourceNode = state.nodes.find((n) => n.id === sourceId);
    const targetNode = state.nodes.find((n) => n.id === targetId);
    if (!sourceNode || !targetNode) return null;

    const { sourceHandle, targetHandle } = chooseConnectionHandles(
      sourceNode,
      targetNode,
    );
    const newEdgeId = `edge-${sourceId}-${targetId}-${Date.now()}`;

    get().pushHistory();
    set((current) => ({
      // Appended directly rather than through `@xyflow/react`'s own `addEdge` helper (as
      // `onConnect` above does): that helper's duplicate check keys only on
      // source/target/handles, ignoring `edgeType` entirely, so it would silently drop a second,
      // different-`edgeType` edge between the same node pair whenever `chooseConnectionHandles`
      // (deterministic given fixed node positions) resolves to the same handle pair as an
      // existing edge -- exactly the case `../../components/editor/connect.ts`'s
      // `validateConnection` deliberately allows. Every input here has already been validated
      // above, so no further validation from `addEdge` is needed.
      edges: [
        ...current.edges,
        {
          data: { edgeType },
          id: newEdgeId,
          source: sourceId,
          sourceHandle,
          target: targetId,
          targetHandle,
          type: "cf-edge",
        } as Edge<CFEdgeData>,
      ],
      dirty: true,
    }));
    get().setSelectedEdge(newEdgeId);
    return newEdgeId;
  },

  onViewportChange: (viewport) => set({ viewport }),

  addNode: (node) => {
    get().pushHistory();
    set((state) => ({
      nodes: [...state.nodes, node],
      dirty: true,
    }));
  },

  updateNodeData: (nodeId, data) => {
    get().pushHistory();
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n,
      ),
      dirty: true,
    }));
  },

  updateEdgeData: (edgeId, data) => {
    get().pushHistory();
    set((state) => ({
      edges: state.edges.map((e) =>
        e.id === edgeId
          ? { ...e, data: { ...e.data, ...data } as CFEdgeData }
          : e,
      ),
      dirty: true,
    }));
  },

  removeSelected: () => {
    get().pushHistory();
    set((state) => ({
      nodes: state.nodes.filter((n) => !n.selected),
      edges: state.edges.filter((e) => !e.selected),
      selectedNodeId: null,
      selectedEdgeId: null,
      dirty: true,
    }));
  },

  setSelectedNode: (id) =>
    set((state) => ({
      selectedNodeId: id,
      selectedEdgeId: null,
      propertiesOpen: id !== null ? true : state.propertiesOpen,
    })),
  setSelectedEdge: (id) =>
    set((state) => ({
      selectedEdgeId: id,
      selectedNodeId: null,
      propertiesOpen: id !== null ? true : state.propertiesOpen,
    })),

  togglePalette: () => set((state) => ({ paletteOpen: !state.paletteOpen })),
  toggleProperties: () =>
    set((state) => ({ propertiesOpen: !state.propertiesOpen })),

  setTitle: (title) => set({ title, dirty: true }),
  setDescription: (description) => set({ description, dirty: true }),

  setNodes: (nodes) => set({ nodes, dirty: true }),
  setEdges: (edges) => set({ edges, dirty: true }),

  markSaving: () => set({ saving: true, saveError: null }),
  markSaved: () =>
    set({
      saving: false,
      dirty: false,
      lastSavedAt: Date.now(),
      saveError: null,
    }),
  markSaveError: (error) => set({ saving: false, saveError: error }),

  setPrintMode: (printMode) => set({ printMode }),

  pushHistory: () =>
    set((state) => ({
      undoStack: [
        ...state.undoStack.slice(-(MAX_HISTORY - 1)),
        {
          nodes: structuredClone(state.nodes),
          edges: structuredClone(state.edges),
        },
      ],
      redoStack: [],
    })),

  undo: () =>
    set((state) => {
      if (state.undoStack.length === 0) return state;
      const prev = state.undoStack[state.undoStack.length - 1];
      return {
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [
          ...state.redoStack,
          {
            nodes: structuredClone(state.nodes),
            edges: structuredClone(state.edges),
          },
        ],
        nodes: prev.nodes,
        edges: prev.edges,
        dirty: true,
      };
    }),

  redo: () =>
    set((state) => {
      if (state.redoStack.length === 0) return state;
      const next = state.redoStack[state.redoStack.length - 1];
      return {
        redoStack: state.redoStack.slice(0, -1),
        undoStack: [
          ...state.undoStack,
          {
            nodes: structuredClone(state.nodes),
            edges: structuredClone(state.edges),
          },
        ],
        nodes: next.nodes,
        edges: next.edges,
        dirty: true,
      };
    }),
}));
