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

  /** Set the selected node (clears any edge selection). */
  setSelectedNode: (id: string | null) => void;
  /** Set the selected edge (clears any node selection). */
  setSelectedEdge: (id: string | null) => void;

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
  undoStack: [],
  redoStack: [],

  setDiagram: (id, title, description, nodes, edges, viewport) =>
    set({
      diagramId: id,
      title,
      description: description ?? "",
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

  setSelectedNode: (id) => set({ selectedNodeId: id, selectedEdgeId: null }),
  setSelectedEdge: (id) => set({ selectedEdgeId: id, selectedNodeId: null }),

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
