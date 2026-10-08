import { create } from 'zustand';
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
  type Viewport
} from '@xyflow/react';
import { CF_EDGE_TYPE } from '../../graph-element-types.ts';
import { chooseConnectionHandles, validateConnection } from '../components/editor/connect.ts';
import type { CFEdgeData, CFNodeData } from '../components/editor/types.ts';
import {
  getStoredDetailsPanelExpanded,
  setStoredDetailsPanelExpanded
} from '../lib/details-panel-preferences.ts';

/**
 * @file The editor's complete client-side state for one diagram: the React Flow graph, the
 *   selection, the save status, the panel preferences and a session-scoped undo history. Every
 *   canvas mutation goes through this store rather than through component state, and that is the
 *   whole design. The dirty flag drives autosave, and the undo history has to record the graph as
 *   it was _before_ a change — so a mutation applied anywhere else would be one autosave never
 *   hears about and one Ctrl+Z cannot reach.
 */

/**
 * One undo or redo snapshot: the graph as it stood before a change.
 */
interface HistoryEntry {
  /**
   * Nodes at the moment the snapshot was taken.
   */
  nodes: Node<CFNodeData>[];
  /**
   * Edges at the moment the snapshot was taken.
   */
  edges: Edge<CFEdgeData>[];
}

/**
 * The editor's state, without the actions that change it.
 */
interface DiagramState {
  /**
   * Id of the loaded diagram, or `null` before the first load has resolved. The components treat
   * this as "is a diagram on screen yet", which is why the loading state keys off it rather than
   * off a separate flag that could disagree with it.
   */
  diagramId: string | null;
  /**
   * Editable title, shown in the toolbar and saved on its own debounce.
   */
  title: string;
  /**
   * Editable description, shown on the printed page.
   */
  description: string;
  /**
   * Server-recorded ISO-8601 timestamp of the newest version of this diagram the tab knows about,
   * or `null` when there is none — before the first load, and for the anonymous share viewer, which
   * has no live channel and is never sent one.
   *
   * It exists for exactly one comparison: a live `graph_updated` push is applied only when its own
   * timestamp is newer than this. Without it a push that lost a race — delivered after a later save
   * had already been applied — would quietly revert the canvas to an older graph. It is a server
   * value and is never computed here; {@link lastSavedAt} is the separate, local wall-clock reading
   * the status bar shows and the two must not be confused.
   */
  updatedAt: string | null;
  /**
   * Nodes currently on the canvas.
   */
  nodes: Node<CFNodeData>[];
  /**
   * Edges currently on the canvas.
   */
  edges: Edge<CFEdgeData>[];
  /**
   * Current pan and zoom.
   */
  viewport: Viewport;
  /**
   * Id of the selected node, or `null`.
   */
  selectedNodeId: string | null;
  /**
   * Id of the selected edge, or `null`.
   */
  selectedEdgeId: string | null;
  /**
   * Whether the graph has changed since the last successful save.
   */
  dirty: boolean;
  /**
   * Whether a save is currently in flight.
   */
  saving: boolean;
  /**
   * Unix timestamp of the last successful save, or `null` when nothing has been saved yet.
   */
  lastSavedAt: number | null;
  /**
   * Message from the most recent failed save, or `null`. Shown in the status bar, which is the one
   * place a visitor looks to find out whether their work is safe.
   */
  saveError: string | null;
  /**
   * Whether the canvas is in its print presentation.
   */
  printMode: boolean;
  /**
   * Whether the service palette is shown. Open by default: adding a service is the first thing
   * anybody does in an empty editor.
   */
  paletteOpen: boolean;
  /**
   * Whether the details panel is shown. Closed by default, because it has nothing to say until
   * something is selected — selecting opens it.
   */
  propertiesOpen: boolean;
  /**
   * Whether the canvas minimap is shown.
   */
  minimapOpen: boolean;
  /**
   * Whether the details panel is at its wide width. Seeded from storage, unlike every other flag
   * here, so the choice survives a reload.
   */
  detailsPanelExpanded: boolean;
  /**
   * Undo snapshots, oldest first.
   */
  undoStack: HistoryEntry[];
  /**
   * Redo snapshots, oldest first.
   */
  redoStack: HistoryEntry[];
}

/**
 * The actions that change the editor's state.
 */
interface DiagramActions {
  /**
   * Loads a diagram into the editor, replacing whatever was there.
   *
   * @param id Diagram id.
   * @param title Diagram title.
   * @param description Diagram description, already normalised from the API's `string | null`.
   * @param nodes Parsed nodes.
   * @param edges Parsed edges.
   * @param viewport Parsed viewport.
   * @param updatedAt Server-recorded timestamp of the version being loaded, or `null` when the
   *   caller has none — the anonymous share viewer, which receives no timestamp and opens no live
   *   channel to compare one against.
   * @returns Nothing. Dirty state and history are cleared, because what has just been loaded is
   *   exactly what the server holds and the previous diagram's history belongs to another
   *   document.
   */
  setDiagram: (
    id: string,
    title: string,
    description: string,
    nodes: Node<CFNodeData>[],
    edges: Edge<CFEdgeData>[],
    viewport: Viewport,
    updatedAt?: string | null
  ) => void;
  /**
   * Replaces the graph with one an agent changed on the server, if it is genuinely newer.
   *
   * The newness check lives here rather than in the component so there is one rule rather than one
   * per caller, and so it can be tested as state. A push carrying a timestamp no newer than
   * {@link DiagramState.updatedAt} is discarded entirely: it describes a version this tab has
   * already moved past, and applying it would revert the canvas under the user.
   *
   * The graph is replaced rather than merged, which is the same thing the initial load does and the
   * same thing the autosave sends — this demo has no partial-patch protocol in either direction.
   * `dirty` is deliberately left alone: the push is now the saved state, but any local change the
   * user had pending is still pending, and clearing the flag would lose it.
   *
   * No undo entry is pushed. Ctrl+Z is for undoing _your own_ last action, and silently making it
   * revert somebody else's change instead would be the more surprising behaviour.
   *
   * @param nodes Nodes from the pushed graph.
   * @param edges Edges from the pushed graph.
   * @param updatedAt Server timestamp the push carried.
   * @returns `true` when the graph was replaced, and `false` when the push was discarded as stale.
   *   The caller uses it to decide whether to show the "updated by an agent" toast, so a discarded
   *   push explains nothing to the user — because nothing changed.
   */
  applyRemoteGraph: (
    nodes: Node<CFNodeData>[],
    edges: Edge<CFEdgeData>[],
    updatedAt: string
  ) => boolean;
  /**
   * React Flow's node-change handler. Records undo history for a structural change only.
   */
  onNodesChange: OnNodesChange;
  /**
   * React Flow's edge-change handler, with the same history rule as {@link onNodesChange}.
   */
  onEdgesChange: OnEdgesChange;
  /**
   * React Flow's pointer-drag connection handler, creating a data-flow edge.
   */
  onConnect: OnConnect;
  /**
   * Connects two nodes by id, the keyboard path React Flow's own drag-to-connect has no equivalent
   * for.
   *
   * Validates the proposed connection before changing anything, so a refusal leaves the canvas
   * exactly as it was, and selects the new edge so the properties panel opens on it.
   *
   * @param sourceId Id of the node to connect from.
   * @param targetId Id of the node to connect to.
   * @param edgeType Catalogue edge type for the new connection.
   * @returns The new edge's id, or `null` when the connection is invalid or either node is not on
   *   the canvas — in which case nothing has changed.
   */
  connectNodes: (
    sourceId: string,
    targetId: string,
    edgeType: CFEdgeData['edgeType']
  ) => string | null;
  /**
   * Records a pan or zoom.
   *
   * @param viewport New pan and zoom.
   * @returns Nothing. Deliberately does not mark the diagram dirty: looking at a different part of
   *   a diagram has not changed it.
   */
  onViewportChange: (viewport: Viewport) => void;
  /**
   * Adds a node to the canvas.
   *
   * @param node Node to add, already positioned by the caller.
   * @returns Nothing.
   */
  addNode: (node: Node<CFNodeData>) => void;
  /**
   * Merges fields into one node's data payload.
   *
   * @param nodeId Id of the node to change.
   * @param data Fields to merge; anything omitted is left as it was.
   * @returns Nothing. A node id that matches nothing is a no-op beyond the history entry.
   */
  updateNodeData: (nodeId: string, data: Partial<CFNodeData>) => void;
  /**
   * Merges fields into one edge's data payload.
   *
   * @param edgeId Id of the edge to change.
   * @param data Fields to merge.
   * @returns Nothing.
   */
  updateEdgeData: (edgeId: string, data: Partial<CFEdgeData>) => void;
  /**
   * Removes every selected node and edge.
   *
   * @returns Nothing. The selection is cleared, since what it pointed at is gone.
   */
  removeSelected: () => void;
  /**
   * Selects a node, clearing any edge selection and opening the details panel.
   *
   * @param id Node id, or `null` to clear the selection.
   * @returns Nothing.
   */
  setSelectedNode: (id: string | null) => void;
  /**
   * Selects an edge; the mirror of {@link setSelectedNode}.
   *
   * @param id Edge id, or `null` to clear the selection.
   * @returns Nothing.
   */
  setSelectedEdge: (id: string | null) => void;
  /**
   * Shows or hides the service palette.
   *
   * @returns Nothing.
   */
  togglePalette: () => void;
  /**
   * Shows or hides the details panel.
   *
   * @returns Nothing.
   */
  toggleProperties: () => void;
  /**
   * Shows or hides the canvas minimap.
   *
   * @returns Nothing.
   */
  toggleMinimap: () => void;
  /**
   * Switches the details panel between its wide and compact widths, persisting the choice.
   *
   * @returns Nothing. The write is best-effort; see `../lib/details-panel-preferences.ts`.
   */
  toggleDetailsPanelExpanded: () => void;
  /**
   * Renames the diagram.
   *
   * @param title New title.
   * @returns Nothing.
   */
  setTitle: (title: string) => void;
  /**
   * Changes the diagram's description.
   *
   * @param description New description.
   * @returns Nothing.
   */
  setDescription: (description: string) => void;
  /**
   * Replaces every node, for auto-layout.
   *
   * @param nodes New nodes.
   * @returns Nothing.
   */
  setNodes: (nodes: Node<CFNodeData>[]) => void;
  /**
   * Replaces every edge, for auto-layout.
   *
   * @param edges New edges.
   * @returns Nothing.
   */
  setEdges: (edges: Edge<CFEdgeData>[]) => void;
  /**
   * Marks a save as started, clearing any previous failure.
   *
   * @returns Nothing.
   */
  markSaving: () => void;
  /**
   * Marks a save as succeeded.
   *
   * @param updatedAt Server-recorded timestamp the save returned, recorded so a live push that
   *   describes an older version than this one is discarded rather than reverting the canvas.
   * @returns Nothing. Clears the dirty flag, so a change made _during_ the request stays pending
   *   and triggers the next autosave rather than being lost.
   */
  markSaved: (updatedAt: string) => void;
  /**
   * Records a failed save.
   *
   * @param error Message to show in the status bar.
   * @returns Nothing. The dirty flag is left set, so the next change retries rather than the
   *   failure quietly becoming a saved state.
   */
  markSaveError: (error: string) => void;
  /**
   * Enters or leaves print mode.
   *
   * The side effects — forcing a light scheme, choosing a page orientation, opening the print
   * dialog — belong to the canvas component, not here: this store holds state, and a store action
   * that reached into `document` could not be reasoned about or tested as state.
   *
   * @param printMode Whether print mode is active.
   * @returns Nothing.
   */
  setPrintMode: (printMode: boolean) => void;
  /**
   * Steps back to the previous snapshot.
   *
   * @returns Nothing. A no-op when there is no history.
   */
  undo: () => void;
  /**
   * Re-applies the most recently undone snapshot.
   *
   * @returns Nothing. A no-op when nothing has been undone.
   */
  redo: () => void;
  /**
   * Snapshots the current graph onto the undo stack and discards the redo stack.
   *
   * Public because auto-layout repositions every node at once through {@link setNodes} and wants the
   * whole re-layout to be a single undo step rather than none.
   *
   * @returns Nothing.
   */
  pushHistory: () => void;
}

/**
 * How many undo snapshots are kept.
 *
 * Each one is a complete copy of the graph, so this is a memory bound rather than a usability
 * choice: an unbounded stack would hold every version of a large diagram for as long as the tab is
 * open.
 */
const MAX_HISTORY = 50;

/**
 * The editor store's full type: state and the actions over it.
 */
export type DiagramStore = DiagramState & DiagramActions;

/**
 * The editor's Zustand store.
 *
 * Inside a component, read it as a hook:
 *
 * ```ts
 * const { nodes, addNode } = useDiagramStore();
 * ```
 *
 * Outside React — in an autosave callback, for instance — read it imperatively, which is also how a
 * callback avoids closing over a stale snapshot:
 *
 * ```ts
 * const { nodes } = useDiagramStore.getState();
 * ```
 */
export const useDiagramStore = create<DiagramStore>((set, get) => ({
  description: '',
  detailsPanelExpanded: getStoredDetailsPanelExpanded(),
  diagramId: null,
  dirty: false,
  edges: [],
  lastSavedAt: null,
  minimapOpen: true,
  nodes: [],
  paletteOpen: true,
  printMode: false,
  propertiesOpen: false,
  redoStack: [],
  saveError: null,
  saving: false,
  selectedEdgeId: null,
  selectedNodeId: null,
  title: 'Untitled Diagram',
  undoStack: [],
  updatedAt: null,
  viewport: { x: 0, y: 0, zoom: 1 },

  setDiagram: (id, title, description, nodes, edges, viewport, updatedAt = null) =>
    set({
      description,
      diagramId: id,
      dirty: false,
      edges,
      nodes,
      redoStack: [],
      title,
      undoStack: [],
      updatedAt,
      viewport
    }),

  applyRemoteGraph: (nodes, edges, updatedAt) => {
    const current = get().updatedAt;
    // A string comparison rather than parsed dates: every value here is a `Date#toISOString`
    // result written by the server, and that format sorts chronologically as text. Parsing would
    // add a failure mode — an unparseable value becoming `NaN`, which loses every comparison —
    // for no gain.
    if (current !== null && updatedAt <= current) {
      return false;
    }

    set({ edges, nodes, updatedAt });
    return true;
  },

  onNodesChange: (changes: NodeChange[]) => {
    // Only an added or removed node is worth an undo entry. A drag fires a position change on
    // every pointer move, and recording each one would make Ctrl+Z replay the drag a pixel at a
    // time instead of undoing it.
    if (changes.some((change) => change.type === 'remove' || change.type === 'add')) {
      get().pushHistory();
    }

    set((state) => ({
      dirty: true,
      nodes: applyNodeChanges(changes, state.nodes) as Node<CFNodeData>[]
    }));
  },

  onEdgesChange: (changes: EdgeChange[]) => {
    if (changes.some((change) => change.type === 'remove' || change.type === 'add')) {
      get().pushHistory();
    }

    set((state) => ({
      dirty: true,
      edges: applyEdgeChanges(changes, state.edges) as Edge<CFEdgeData>[]
    }));
  },

  onConnect: (connection: Connection) => {
    get().pushHistory();
    set((state) => ({
      dirty: true,
      edges: addEdge(
        { ...connection, data: { edgeType: 'data-flow' as const }, type: CF_EDGE_TYPE },
        state.edges
      )
    }));
  },

  connectNodes: (sourceId, targetId, edgeType) => {
    const state = get();
    if (validateConnection({ edgeType, edges: state.edges, sourceId, targetId })) {
      return null;
    }

    const sourceNode = state.nodes.find((node) => node.id === sourceId);
    const targetNode = state.nodes.find((node) => node.id === targetId);
    if (!sourceNode || !targetNode) {
      return null;
    }

    const { sourceHandle, targetHandle } = chooseConnectionHandles(sourceNode, targetNode);
    const newEdgeId = `edge-${sourceId}-${targetId}-${Date.now()}`;

    get().pushHistory();
    set((current) => ({
      dirty: true,
      // Appended directly rather than through React Flow's `addEdge`, which `onConnect` above does
      // use. That helper's duplicate check keys on source, target and handles only, ignoring the
      // edge type — so it would silently drop a second edge of a different type between the same
      // pair whenever the handles resolve the same way, which is exactly the case
      // `validateConnection` deliberately allows. Everything here has already been validated.
      edges: [
        ...current.edges,
        {
          data: { edgeType },
          id: newEdgeId,
          source: sourceId,
          sourceHandle,
          target: targetId,
          targetHandle,
          type: CF_EDGE_TYPE
        } as Edge<CFEdgeData>
      ]
    }));
    get().setSelectedEdge(newEdgeId);
    return newEdgeId;
  },

  onViewportChange: (viewport) => set({ viewport }),

  addNode: (node) => {
    get().pushHistory();
    set((state) => ({ dirty: true, nodes: [...state.nodes, node] }));
  },

  updateNodeData: (nodeId, data) => {
    get().pushHistory();
    set((state) => ({
      dirty: true,
      nodes: state.nodes.map((node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, ...data } } : node
      )
    }));
  },

  updateEdgeData: (edgeId, data) => {
    get().pushHistory();
    set((state) => ({
      dirty: true,
      edges: state.edges.map((edge) =>
        edge.id === edgeId ? { ...edge, data: { ...edge.data, ...data } as CFEdgeData } : edge
      )
    }));
  },

  removeSelected: () => {
    get().pushHistory();
    set((state) => ({
      dirty: true,
      edges: state.edges.filter((edge) => !edge.selected),
      nodes: state.nodes.filter((node) => !node.selected),
      selectedEdgeId: null,
      selectedNodeId: null
    }));
  },

  setSelectedNode: (id) =>
    set((state) => ({
      propertiesOpen: id !== null ? true : state.propertiesOpen,
      selectedEdgeId: null,
      selectedNodeId: id
    })),

  setSelectedEdge: (id) =>
    set((state) => ({
      propertiesOpen: id !== null ? true : state.propertiesOpen,
      selectedEdgeId: id,
      selectedNodeId: null
    })),

  togglePalette: () => set((state) => ({ paletteOpen: !state.paletteOpen })),
  toggleProperties: () => set((state) => ({ propertiesOpen: !state.propertiesOpen })),
  toggleMinimap: () => set((state) => ({ minimapOpen: !state.minimapOpen })),

  toggleDetailsPanelExpanded: () =>
    set((state) => {
      const next = !state.detailsPanelExpanded;
      setStoredDetailsPanelExpanded(next);
      return { detailsPanelExpanded: next };
    }),

  setTitle: (title) => set({ dirty: true, title }),
  setDescription: (description) => set({ description, dirty: true }),

  setNodes: (nodes) => set({ dirty: true, nodes }),
  setEdges: (edges) => set({ dirty: true, edges }),

  markSaving: () => set({ saveError: null, saving: true }),
  markSaved: (updatedAt) =>
    set({ dirty: false, lastSavedAt: Date.now(), saveError: null, saving: false, updatedAt }),
  markSaveError: (error) => set({ saveError: error, saving: false }),

  setPrintMode: (printMode) => set({ printMode }),

  pushHistory: () =>
    set((state) => ({
      // Deep copies. Holding the live node objects would mean the next edit mutated the very
      // snapshot undo exists to return to, so Ctrl+Z would restore the state it was undoing.
      undoStack: [
        ...state.undoStack.slice(-(MAX_HISTORY - 1)),
        { edges: structuredClone(state.edges), nodes: structuredClone(state.nodes) }
      ],
      // A new change makes the undone future unreachable: the visitor has chosen a different one,
      // and redoing into the old one would produce a graph that never existed.
      redoStack: []
    })),

  undo: () =>
    set((state) => {
      if (state.undoStack.length === 0) {
        return state;
      }

      const previous = state.undoStack[state.undoStack.length - 1] as HistoryEntry;
      return {
        dirty: true,
        edges: previous.edges,
        nodes: previous.nodes,
        redoStack: [
          ...state.redoStack,
          { edges: structuredClone(state.edges), nodes: structuredClone(state.nodes) }
        ],
        undoStack: state.undoStack.slice(0, -1)
      };
    }),

  redo: () =>
    set((state) => {
      if (state.redoStack.length === 0) {
        return state;
      }

      const next = state.redoStack[state.redoStack.length - 1] as HistoryEntry;
      return {
        dirty: true,
        edges: next.edges,
        nodes: next.nodes,
        redoStack: state.redoStack.slice(0, -1),
        undoStack: [
          ...state.undoStack,
          { edges: structuredClone(state.edges), nodes: structuredClone(state.nodes) }
        ]
      };
    })
}));
