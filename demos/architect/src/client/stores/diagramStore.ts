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
  applyGraphOperation,
  type GraphOperation,
} from "../../graph-mutations";
import type { GraphData } from "../../worker/diagrams/types";
import {
  chooseConnectionHandles,
  validateConnection,
} from "../components/editor/connect";
import type { CFEdgeData, CFNodeData } from "../components/editor/types";

/**
 * Monotonically increasing counter backing {@link nextClientOpId} -- a plain module-level
 * counter, not `crypto.randomUUID()` per call: this id only needs to be unique for the lifetime
 * of one browser tab (it reconciles an outgoing `operation` frame against its own
 * `operation_applied`/`operation_rejected` echo, `../hooks/useDiagramLiveSync.ts`), never
 * persisted or compared across tabs, and a small counter is easier to read in a debugger or log
 * than a random string.
 */
let clientOpIdCounter = 0;

/**
 * Generate a locally-unique id for the next outgoing `operation` frame
 * (`../hooks/useDiagramLiveSync.ts`'s `sendOperation()`).
 *
 * @returns A fresh, process-local id, never repeated within this tab's lifetime.
 */
export function nextClientOpId(): string {
  clientOpIdCounter += 1;
  return `op-${clientOpIdCounter}`;
}

/**
 * The coalescing key for one queued {@link GraphOperation} in {@link DiagramState.pendingOperations}
 * -- a node- or edge-targeting operation (`update_node`/`remove_node`/`update_edge`/
 * `remove_edge`) is keyed by its target id, so a rapid sequence of edits to the same node/edge
 * (a drag, several properties-panel keystrokes) collapses into just the most recent one by the
 * time the debounce timer flushes the queue -- "last one wins per id"
 * (`../components/editor/DiagramCanvas.tsx`'s flush effect). An `add_node`/`add_edge` operation
 * has no existing target to coalesce against, so each gets its own unique key instead.
 */
function operationKey(op: GraphOperation): string {
  switch (op.kind) {
    case "add_node":
    case "add_edge":
      return `${op.kind}:${crypto.randomUUID()}`;
    case "update_node":
    case "remove_node":
      return `node:${op.nodeId}`;
    case "update_edge":
    case "remove_edge":
      return `edge:${op.edgeId}`;
  }
}

/** A snapshot of the node and edge arrays for undo/redo. */
interface HistoryEntry {
  nodes: Node<CFNodeData>[];
  edges: Edge<CFEdgeData>[];
}

/** Read-only state slice of the diagram store. */
interface DiagramState {
  /** UUID of the currently loaded diagram, or null before initial fetch. */
  diagramId: string | null;
  /**
   * Verified Cloudflare Access identity email that owns the currently loaded diagram, or
   * `null` before a diagram has loaded, or in read-only share-viewer mode (`../api/shares.ts`'s
   * `SharedDiagram` deliberately never carries `ownerEmail` -- docs/09-ARCHITECT.md's
   * non-negotiable tests: a public share must never leak who owns the diagram it points to).
   * Compared against the signed-in identity's own email (`../hooks/useIdentity.ts`) by
   * `../components/editor/toolbar/CollaboratorsModal.tsx` to distinguish an owner from a
   * collaborator client-side, without a separate "role" field traveling over the wire
   * (docs/09C-COLLABORATIVE-EDITING.md's Client section).
   */
  ownerEmail: string | null;
  /** User-editable diagram title. */
  title: string;
  /** User-editable diagram description. */
  description: string;
  /**
   * ISO-8601 timestamp of the most recent graph state this store knows about -- either from the
   * diagram's initial load or this tab's own most recent autosave. `null` before a diagram has
   * loaded, or in read-only share-viewer mode (see `../api/shares.ts`'s `SharedDiagram`). Not
   * updated by a live-sync push any more (docs/09C-COLLABORATIVE-EDITING.md's Message Protocol:
   * a `graph_snapshot`/`operation_applied` frame carries a `sequence` number, not an
   * `updatedAt` timestamp -- ordering within one live connection is tracked entirely inside
   * `../hooks/useDiagramLiveSync.ts` instead).
   */
  updatedAt: string | null;
  /**
   * State backing the "Updated by…" toast (`../components/editor/LiveUpdateToast.tsx`), shown
   * after {@link DiagramActions.applyRemoteOperation} applied another identity's live edit to
   * this tab's canvas -- without this, the canvas would silently change under the user with no
   * explanation. `null` when no notice is currently shown. `origin: "agent"` renders "Updated by
   * your agent"; `origin: "human"` renders "Updated by \<actorEmail\>" -- see
   * `../hooks/useDiagramLiveSync.ts` for exactly when this is set versus suppressed for this
   * tab's own optimistic edit.
   */
  liveUpdateNotice: { actorEmail: string; origin: "human" | "agent" } | null;
  /**
   * Discrete graph operations queued since the last flush, coalesced by target id
   * (`operationKey()`) so a rapid sequence of edits to the same node/edge collapses into just
   * the most recent one. Drained and sent over the live socket by
   * `../components/editor/DiagramCanvas.tsx`'s debounced flush effect when connected, or left
   * to accumulate harmlessly while the socket is not connected (the `PUT`-based autosave
   * fallback sends the *whole* graph in that case, making this queue's own contents moot until
   * the socket reconnects and starts draining it again).
   */
  pendingOperations: Map<string, GraphOperation>;

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
  /** Whether the canvas minimap (`../components/editor/DiagramCanvas.tsx`'s `<MiniMap>`) is
   * visible. Defaults to `true`, matching the minimap's pre-existing always-on behavior before
   * this toggle existed. A view preference only -- deliberately not persisted to `localStorage`
   * or saved graph data, unlike `../lib/palette-preferences.ts`'s collapsed-category list. */
  minimapOpen: boolean;

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
   * @param ownerEmail The diagram's owner email, or `null` in read-only share-viewer mode --
   * see {@link DiagramState.ownerEmail}.
   * @param title Diagram title.
   * @param description Diagram description.
   * @param nodes Parsed React Flow nodes.
   * @param edges Parsed React Flow edges.
   * @param viewport Parsed viewport state.
   * @param updatedAt The diagram's own `updatedAt`, or `null` in read-only share-viewer mode
   * (`../api/shares.ts`'s `SharedDiagram` carries no `updatedAt` field at all). Seeds
   * {@link DiagramState.updatedAt} so a later live-sync push
   * (`../hooks/useDiagramLiveSync.ts`) can tell whether it is actually newer than what this tab
   * already has.
   */
  setDiagram: (
    id: string,
    ownerEmail: string | null,
    title: string,
    description: string,
    nodes: Node<CFNodeData>[],
    edges: Edge<CFEdgeData>[],
    viewport: Viewport,
    updatedAt: string | null,
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

  /** Add a new node to the canvas. Pushes history before mutating, and enqueues the equivalent
   * `add_node` operation (docs/09C-COLLABORATIVE-EDITING.md's Message Protocol) for
   * `../components/editor/DiagramCanvas.tsx`'s debounced live-sync flush. */
  addNode: (node: Node<CFNodeData>) => void;
  /** Merge partial data into an existing node's `data` payload, and enqueue the equivalent
   * `update_node` operation for whichever of `label`/`description` actually changed --
   * `../components/editor/panels/PropertiesPanel.tsx`'s only way to edit a node's fields. */
  updateNodeData: (nodeId: string, data: Partial<CFNodeData>) => void;
  /** Merge partial data into an existing edge's `data` payload, and enqueue the equivalent
   * `update_edge` operation for whichever of `edgeType`/`label`/`description`/`protocol`
   * actually changed -- `../components/editor/panels/PropertiesPanel.tsx`'s only way to edit an
   * edge's fields. */
  updateEdgeData: (edgeId: string, data: Partial<CFEdgeData>) => void;
  /** Remove all currently selected nodes and edges. Pushes history, and enqueues one
   * `remove_node`/`remove_edge` operation per removed id (never a bulk-remove operation kind --
   * `../../graph-mutations.ts`'s shared vocabulary has none). */
  removeSelected: () => void;

  /**
   * Queue one discrete graph operation for `../components/editor/DiagramCanvas.tsx`'s debounced
   * live-sync flush, coalescing by target id (`operationKey()`) so a rapid sequence of edits to
   * the same node/edge collapses into just the most recent one. Called by this store's own
   * mutation actions above (`addNode`, `updateNodeData`, `updateEdgeData`, `removeSelected`,
   * `onConnect`, `connectNodes`) immediately after their existing optimistic local mutation, and
   * directly by `../components/editor/toolbar/Toolbar.tsx`'s auto-layout flow, which repositions
   * every node at once via {@link DiagramActions.setNodes} rather than one call per node.
   */
  enqueueOperation: (op: GraphOperation) => void;
  /**
   * Remove and return every currently queued operation, in insertion order. Called by
   * `../components/editor/DiagramCanvas.tsx`'s debounced flush effect (to send them over the
   * live socket) and after a successful `PUT`-based fallback autosave (to discard them, since
   * that autosave already persisted the whole graph they describe -- resending a queued
   * `add_node`/`add_edge` afterward would create a duplicate node/edge once the socket
   * reconnects).
   *
   * @returns Every operation queued since the last drain.
   */
  drainPendingOperations: () => GraphOperation[];

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
  /** Toggle the canvas minimap's visibility. */
  toggleMinimap: () => void;

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
  /**
   * Set `saving` to false, clear `dirty`, record `lastSavedAt`, clear error, and record the new
   * `updatedAt` this tab's own autosave just produced -- so a later live-sync push
   * (`../hooks/useDiagramLiveSync.ts`) that raced this same save is correctly recognised as not
   * actually newer than what this tab already has.
   *
   * @param updatedAt The new `updated_at` timestamp `PUT /api/diagrams/:id/graph` returned.
   */
  markSaved: (updatedAt: string) => void;
  /** Record a save failure. */
  markSaveError: (error: string) => void;

  /**
   * Replace the canvas wholesale with a `graph_snapshot` frame's graph
   * (`../hooks/useDiagramLiveSync.ts`, docs/09C-COLLABORATIVE-EDITING.md's Message Protocol) --
   * sent once, immediately on connect, and again after any whole-graph replace
   * (`auto_layout_diagram`, or the `PUT`-based autosave fallback). Ordering against a previous
   * snapshot is the hook's own job (comparing `sequence`, which this frame carries but this
   * action does not need); by the time this action is called, the hook has already decided the
   * snapshot should be applied. Clears `dirty` and the undo/redo history: the snapshot is
   * already persisted, and a stale undo entry from before this external change would restore
   * graph state D1 no longer has. Does not mutate anything if `graphData` fails to parse -- a
   * malformed push must never corrupt the current canvas.
   *
   * @param graphData Canonical JSON string from the `graph_snapshot` message.
   */
  applyRemoteGraphSnapshot: (graphData: string) => void;
  /**
   * Apply one other identity's discrete operation to this tab's local `nodes`/`edges`
   * (`../hooks/useDiagramLiveSync.ts`'s `operation_applied` handling, for an operation that did
   * not originate from this tab's own pending sends) via the same shared
   * `../../graph-mutations.ts`'s `applyGraphOperation()` the server uses -- one code path, no
   * second, duplicated mutation implementation in the browser. A stale-target operation (this
   * tab's own local state has already diverged, for example by removing the same node itself)
   * is silently ignored rather than thrown, matching this channel's "no separate reconciliation"
   * handling for the rejected side.
   *
   * @param op The operation to apply.
   */
  applyRemoteOperation: (op: GraphOperation) => void;
  /**
   * Show the "Updated by…" toast (`../components/editor/LiveUpdateToast.tsx`) for another
   * identity's live edit. Called by `../hooks/useDiagramLiveSync.ts` -- see that hook's own
   * JSDoc for exactly when this is called versus suppressed for this tab's own optimistic edit.
   *
   * @param actorEmail The identity that performed the edit.
   * @param origin `"human"` or `"agent"` -- selects the toast's rendered text.
   */
  showLiveUpdateNotice: (actorEmail: string, origin: "human" | "agent") => void;
  /** Dismiss the "Updated by…" toast, whether by its own auto-dismiss timer or a manual click
   * (`../components/editor/LiveUpdateToast.tsx`). */
  dismissLiveUpdateNotice: () => void;

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
  ownerEmail: null,
  title: "Untitled Diagram",
  description: "",
  updatedAt: null,
  liveUpdateNotice: null,
  pendingOperations: new Map(),
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
  minimapOpen: true,
  undoStack: [],
  redoStack: [],

  setDiagram: (
    id,
    ownerEmail,
    title,
    description,
    nodes,
    edges,
    viewport,
    updatedAt,
  ) =>
    // `description` is declared as a plain `string` (see `DiagramActions.setDiagram`'s JSDoc),
    // and both real call sites (`../components/editor/DiagramCanvas.tsx`) already normalize a
    // `string | null` API value to `""` before calling this action, so no further fallback is
    // needed -- or reachable -- here.
    set({
      diagramId: id,
      ownerEmail,
      title,
      description,
      updatedAt,
      liveUpdateNotice: null,
      pendingOperations: new Map(),
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

    // A canvas drag fires many intermediate "position" changes before its final one -- each
    // one enqueues an `update_node` operation, but `operationKey()` coalesces them by nodeId, so
    // only the drag's most recent position actually gets sent once the debounce timer flushes.
    for (const change of changes) {
      if (change.type === "position" && change.position !== undefined) {
        get().enqueueOperation({
          kind: "update_node",
          nodeId: change.id,
          patch: { position: change.position },
        });
      }
    }
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
    get().enqueueOperation({
      input: {
        edgeType: "data-flow",
        source: connection.source,
        target: connection.target,
      },
      kind: "add_edge",
    });
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
    get().enqueueOperation({
      input: { edgeType, source: sourceId, target: targetId },
      kind: "add_edge",
    });
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
    get().enqueueOperation({
      input: {
        description: node.data.description,
        label: node.data.label,
        position: node.position,
        typeId: node.data.typeId,
      },
      kind: "add_node",
    });
  },

  updateNodeData: (nodeId, data) => {
    get().pushHistory();
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n,
      ),
      dirty: true,
    }));

    // Only `label`/`description` are part of the shared operation vocabulary
    // (`../../graph-mutations.ts`'s `NodePatch`) -- any other field the properties panel might
    // one day set (a style override, for example) has no wire representation and is simply not
    // synced live; it still saves via the `PUT`-based autosave fallback like everything else.
    const patch: { label?: string; description?: string } = {};
    if (data.label !== undefined) patch.label = data.label;
    if (data.description !== undefined) patch.description = data.description;
    if (Object.keys(patch).length > 0) {
      get().enqueueOperation({ kind: "update_node", nodeId, patch });
    }
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

    const patch: {
      edgeType?: CFEdgeData["edgeType"];
      label?: string;
      description?: string;
      protocol?: string;
    } = {};
    if (data.edgeType !== undefined) patch.edgeType = data.edgeType;
    if (data.label !== undefined) patch.label = data.label;
    if (data.description !== undefined) patch.description = data.description;
    if (data.protocol !== undefined) patch.protocol = data.protocol;
    if (Object.keys(patch).length > 0) {
      get().enqueueOperation({ edgeId, kind: "update_edge", patch });
    }
  },

  removeSelected: () => {
    const state = get();
    const removedNodeIds = state.nodes
      .filter((n) => n.selected)
      .map((n) => n.id);
    const removedEdgeIds = state.edges
      .filter((e) => e.selected)
      .map((e) => e.id);

    get().pushHistory();
    set((current) => ({
      nodes: current.nodes.filter((n) => !n.selected),
      edges: current.edges.filter((e) => !e.selected),
      selectedNodeId: null,
      selectedEdgeId: null,
      dirty: true,
    }));

    // One operation per removed id -- there is no bulk-remove operation kind in the shared
    // vocabulary (`../../graph-mutations.ts`).
    for (const nodeId of removedNodeIds) {
      get().enqueueOperation({ kind: "remove_node", nodeId });
    }
    for (const edgeId of removedEdgeIds) {
      get().enqueueOperation({ edgeId, kind: "remove_edge" });
    }
  },

  enqueueOperation: (op) =>
    set((state) => {
      const pending = new Map(state.pendingOperations);
      pending.set(operationKey(op), op);
      return { pendingOperations: pending };
    }),

  drainPendingOperations: () => {
    const ops = Array.from(get().pendingOperations.values());
    set({ pendingOperations: new Map() });
    return ops;
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
  toggleMinimap: () => set((state) => ({ minimapOpen: !state.minimapOpen })),

  setTitle: (title) => set({ title, dirty: true }),
  setDescription: (description) => set({ description, dirty: true }),

  setNodes: (nodes) => set({ nodes, dirty: true }),
  setEdges: (edges) => set({ edges, dirty: true }),

  markSaving: () => set({ saving: true, saveError: null }),
  markSaved: (updatedAt) =>
    set({
      saving: false,
      dirty: false,
      lastSavedAt: Date.now(),
      saveError: null,
      updatedAt,
    }),
  markSaveError: (error) => set({ saving: false, saveError: error }),

  applyRemoteGraphSnapshot: (graphData) => {
    let parsed: {
      nodes: Node<CFNodeData>[];
      edges: Edge<CFEdgeData>[];
      viewport: Viewport;
    };
    try {
      const decoded = JSON.parse(graphData) as Partial<{
        nodes: Node<CFNodeData>[];
        edges: Edge<CFEdgeData>[];
        viewport: Viewport;
      }>;
      parsed = {
        nodes: decoded.nodes ?? [],
        edges: decoded.edges ?? [],
        viewport: decoded.viewport ?? { x: 0, y: 0, zoom: 1 },
      };
    } catch {
      return;
    }

    set({
      nodes: parsed.nodes,
      edges: parsed.edges,
      viewport: parsed.viewport,
      dirty: false,
      undoStack: [],
      redoStack: [],
    });
  },

  applyRemoteOperation: (op) => {
    const state = get();
    const graph: GraphData = {
      edges: state.edges as unknown as Record<string, unknown>[],
      nodes: state.nodes as unknown as Record<string, unknown>[],
      viewport: state.viewport,
    };

    let mutated: GraphData;
    try {
      mutated = applyGraphOperation(graph, op);
    } catch {
      // A stale-target operation against this tab's own, possibly already-diverged local
      // state -- nothing to apply; see this action's own JSDoc.
      return;
    }

    set({
      nodes: mutated.nodes as unknown as Node<CFNodeData>[],
      edges: mutated.edges as unknown as Edge<CFEdgeData>[],
    });
  },

  showLiveUpdateNotice: (actorEmail, origin) =>
    set({ liveUpdateNotice: { actorEmail, origin } }),

  dismissLiveUpdateNotice: () => set({ liveUpdateNotice: null }),

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
