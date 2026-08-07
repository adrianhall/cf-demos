import { defineStore } from "pinia";
import type {
  CursorSelection,
  Participant,
  ParticipantRole,
  ServerFrame,
} from "../../collaboration-protocol";
import {
  applyGraphOperation,
  GraphOperationError,
} from "../../graph/operations";
import type {
  AddEdgePayload,
  AddNodePayload,
  DeleteEdgePayload,
  DeleteNodePayload,
  DiagramOperation,
  MoveNodePayload,
  UpdateNodePayload,
} from "../../graph/operations";
import type { GraphDocument } from "../../graph/types";
import type {
  DiagramSocketHandle,
  DiagramSocketStatus,
} from "../composables/useDiagramSocket";
import { useDiagramSocket } from "../composables/useDiagramSocket";
import type { DiagramSummary } from "./diagrams";

/** RFC 9457 response fields displayed to the caller. */
interface ProblemDetails {
  /** User-safe explanation of a failed request. */
  detail?: string;
  /** Standard status text fallback. */
  title?: string;
}

/** The four possible outcomes an applied operation can report — see `../../worker/diagram-room.ts`. */
type OperationStatus = "accepted" | "duplicate" | "stale" | "rejected";

/** Outcome an action such as `moveNode()` resolves with, once the room has responded. */
interface OperationResultResponse {
  status: OperationStatus;
  revision: number;
  document: GraphDocument;
  error?: string;
}

/** One remote participant's last known transient cursor/selection, keyed by email in `remoteCursors`. */
interface RemoteCursor {
  /** That participant's `diagram_members` role. */
  role: ParticipantRole;
  /** Graph-space horizontal position. */
  x: number;
  /** Graph-space vertical position. */
  y: number;
  /** That participant's current selection, or `null`. */
  selection: CursorSelection | null;
}

/** Maximum time to wait for a submitted operation's outcome before treating it as unreachable. */
const OPERATION_TIMEOUT_MS = 10_000;

/**
 * Correlates one in-flight, client-submitted operation with the frame that eventually settles
 * it, and the pre-operation state needed to roll back an optimistic guess on rejection.
 *
 * At most one of these exists at a time — `resync` carries no `operationId`
 * (`../../collaboration-protocol.ts`), so a second concurrent in-flight operation from this same
 * client would make a `resync`'s target ambiguous. `sendOperation()` below serializes submissions
 * by awaiting any existing {@link InFlightOperation.promise} before starting a new one, matching
 * every existing call site's own pattern of `await`ing one store action before triggering
 * another.
 */
interface InFlightOperation {
  /** The idempotency key this operation was submitted with. */
  operationId: string;
  /** The document immediately before this operation's optimistic local apply. */
  preDocument: GraphDocument;
  /** The revision immediately before this operation's optimistic local apply. */
  preRevision: number;
  /** Resolves {@link InFlightOperation.promise} and clears `pending`/`currentOperation`. */
  settle: (result: OperationResultResponse | undefined) => void;
  /** Resolved once this operation's outcome (or a timeout) has been processed. */
  promise: Promise<OperationResultResponse | undefined>;
}

/**
 * This store's single live WebSocket connection, held outside Pinia's reactive state (mirroring
 * `demos/chat/src/client/stores/room.ts`'s own module-scoped connection handle) since a raw
 * `WebSocket`/timer handle is not meaningful reactive UI state and must survive exactly as many
 * store-instance lifetimes as the page does.
 */
let socketHandle: DiagramSocketHandle | null = null;

/** The one operation this client is currently waiting on a room outcome for, if any. */
let currentOperation: InFlightOperation | null = null;

/** Convert an unsuccessful same-origin API response into a user-safe error message. */
async function requestErrorMessage(response: Response): Promise<string> {
  try {
    const problem = (await response.json()) as ProblemDetails;
    return (
      problem.detail ?? problem.title ?? "The request could not be completed."
    );
  } catch {
    return "The request could not be completed.";
  }
}

/**
 * Shared client state for one open diagram's live, collaboratively edited document.
 *
 * Evolved in place from Phase 2/3's HTTP-polling `useDiagramDocumentStore` into Phase 4's
 * WebSocket-driven collaboration store — the store id, every existing action name/signature
 * (`addNode`, `updateNode`, `moveNode`, `deleteNode`, `addEdge`, `deleteEdge`, `select`,
 * `selectNothing`, `dismissStaleNotice`, `load`), and getters (`selectedNode`, `selectedEdge`)
 * are unchanged, so `DiagramPalette.vue`, `PropertiesPanel.vue`, `DiagramCanvas.vue`, and
 * `DiagramEditorView.vue` keep working exactly as before from the user's perspective. Only
 * `load()`'s internal transport for document edits changed, from an HTTP
 * `POST /:id/operations` request per edit to one persistent
 * `/api/diagrams/:id/ws` connection (`../composables/useDiagramSocket.ts`) carrying every edit,
 * cursor, and presence update for the life of the open diagram. `load()` still performs one HTTP
 * `GET /api/diagrams/:id` first, for the D1 directory metadata (`diagram.ownerEmail`/`title`)
 * the room's WebSocket protocol deliberately never carries (`docs/09-ARCHITECT.md`'s Data And
 * State Model keeps D1 as the directory, `DiagramRoom` as the sole live-document authority).
 *
 * Every mutation is applied optimistically — see `sendOperation()` — then reconciled against the
 * room's authoritative `operation_accepted`/`resync`/`operation_rejected` frame. A `stale` or
 * `rejected` result is never silently retried: the document/revision are rolled back or resynced
 * and `error`/`staleNotice` are set so the view can surface it; the user must explicitly repeat
 * their edit (`docs/09-ARCHITECT.md`'s Collaboration Protocol).
 */
export const useDiagramDocumentStore = defineStore("diagram-document", {
  actions: {
    /** Add a new product or actor node from the palette. */
    async addNode(
      node: AddNodePayload["node"],
    ): Promise<OperationResultResponse | undefined> {
      return this.sendOperation({ kind: "add_node", payload: { node } });
    },

    /** Connect two existing nodes with a typed, labeled edge. */
    async addEdge(
      edge: AddEdgePayload["edge"],
    ): Promise<OperationResultResponse | undefined> {
      return this.sendOperation({ kind: "add_edge", payload: { edge } });
    },

    /** Remove one edge and clear its selection if it was selected. */
    async deleteEdge(
      edgeId: DeleteEdgePayload["edgeId"],
    ): Promise<OperationResultResponse | undefined> {
      const result = await this.sendOperation({
        kind: "delete_edge",
        payload: { edgeId },
      });
      if (this.selection?.id === edgeId) {
        this.selection = null;
      }
      return result;
    },

    /** Remove one node (and every edge connected to it), clearing its selection if selected. */
    async deleteNode(
      nodeId: DeleteNodePayload["nodeId"],
    ): Promise<OperationResultResponse | undefined> {
      const result = await this.sendOperation({
        kind: "delete_node",
        payload: { nodeId },
      });
      if (this.selection?.id === nodeId) {
        this.selection = null;
      }
      return result;
    },

    /** Persist a node's final position after a completed drag. */
    async moveNode(
      nodeId: MoveNodePayload["nodeId"],
      position: MoveNodePayload["position"],
    ): Promise<OperationResultResponse | undefined> {
      return this.sendOperation({
        kind: "move_node",
        payload: { nodeId, position },
      });
    },

    /** Replace a node's editable data (the properties panel's label/description edit). */
    async updateNode(
      nodeId: UpdateNodePayload["nodeId"],
      data: UpdateNodePayload["data"],
    ): Promise<OperationResultResponse | undefined> {
      return this.sendOperation({
        kind: "update_node",
        payload: { nodeId, data },
      });
    },

    /**
     * Apply one durable operation optimistically, submit it over the live WebSocket, and
     * reconcile with the room's authoritative outcome.
     *
     * At most one operation from this client is ever in flight at a time (see
     * {@link InFlightOperation}'s documentation on why); a call while another is still pending
     * waits for it to settle first, matching every existing caller's own pattern of already
     * `await`ing one action before starting the next.
     *
     * @param operation The durable edit to apply, in the exact `DiagramOperation` shape
     * `DiagramRoom` and `POST /:id/operations` both already accept.
     * @returns The eventual outcome, or `undefined` when no diagram is loaded, there is no live
     * connection, or the room never responded before {@link OPERATION_TIMEOUT_MS}.
     */
    async sendOperation(
      operation: DiagramOperation,
    ): Promise<OperationResultResponse | undefined> {
      if (!this.diagram || !this.document) {
        return undefined;
      }
      if (currentOperation) {
        await currentOperation.promise;
      }

      this.error = "";
      this.staleNotice = false;

      const operationId = crypto.randomUUID();
      const baseRevision = this.revision;
      const preDocument = this.document;
      const preRevision = this.revision;

      try {
        // Optimistic: makes the UI feel instant. The room's authoritative frame always
        // overwrites this guess once it arrives, whether it agrees or not.
        this.document = applyGraphOperation(this.document, operation);
      } catch (error) {
        if (!(error instanceof GraphOperationError)) {
          throw error;
        }
        // Leave local state unchanged; the room is the real source of truth for validity.
      }
      this.pending = true;

      let settle!: (result: OperationResultResponse | undefined) => void;
      const promise = new Promise<OperationResultResponse | undefined>(
        (resolve) => {
          settle = resolve;
        },
      );

      if (!socketHandle) {
        this.document = preDocument;
        this.revision = preRevision;
        this.pending = false;
        this.error = "Not connected. Check your connection and try again.";
        settle(undefined);
        return promise;
      }

      const timeoutId = setTimeout(() => {
        if (currentOperation?.operationId !== operationId) {
          return;
        }
        this.document = preDocument;
        this.revision = preRevision;
        this.pending = false;
        this.error =
          "Could not reach the server. Check your connection and try again.";
        currentOperation = null;
        settle(undefined);
      }, OPERATION_TIMEOUT_MS);

      currentOperation = {
        operationId,
        preDocument,
        preRevision,
        promise,
        settle: (result) => {
          clearTimeout(timeoutId);
          currentOperation = null;
          this.pending = false;
          settle(result);
        },
      };

      socketHandle.send({
        type: "operation",
        operation: { operationId, baseRevision, ...operation },
      });
      return promise;
    },

    /** Close (dismiss) the stale-resync notice once the user has seen it. */
    dismissStaleNotice(): void {
      this.staleNotice = false;
    },

    /**
     * Load one diagram's D1 directory metadata, then open its live collaboration WebSocket.
     *
     * @param id Diagram id from the route.
     */
    async load(id: string): Promise<void> {
      this.loading = true;
      this.error = "";
      this.selection = null;
      this.staleNotice = false;
      this.participants = [];
      this.remoteCursors = {};
      this.disconnect();
      try {
        const response = await fetch(`/api/diagrams/${encodeURIComponent(id)}`);
        if (!response.ok) {
          this.error = await requestErrorMessage(response);
          this.diagram = null;
          this.document = null;
          return;
        }
        const body = (await response.json()) as {
          diagram: DiagramSummary;
          revision: number;
          document: GraphDocument;
        };
        this.diagram = body.diagram;
        this.revision = body.revision;
        this.document = body.document;
        this.connect(id);
      } finally {
        this.loading = false;
      }
    },

    /**
     * Open (or replace) this diagram's live collaboration WebSocket.
     *
     * @param diagramId Diagram to connect to.
     */
    connect(diagramId: string): void {
      socketHandle?.disconnect();
      socketHandle = useDiagramSocket(diagramId, {
        onFrame: (frame: ServerFrame) => {
          this.applyServerFrame(frame);
        },
        onStatusChange: (status: DiagramSocketStatus) => {
          this.connectionStatus = status;
        },
      });
    },

    /** Close the live connection without reconnecting — call when navigating away from the editor. */
    disconnect(): void {
      socketHandle?.disconnect();
      socketHandle = null;
      this.connectionStatus = "idle";
    },

    /**
     * Reconcile one inbound `ServerFrame` with reactive store state.
     *
     * @param frame Decoded frame from `../composables/useDiagramSocket.ts`.
     */
    applyServerFrame(frame: ServerFrame): void {
      switch (frame.type) {
        case "sync": {
          this.revision = frame.revision;
          this.document = frame.document;
          this.participants = frame.participants;
          return;
        }
        case "operation_accepted": {
          this.revision = frame.revision;
          this.document = frame.document;
          if (currentOperation?.operationId === frame.operationId) {
            currentOperation.settle({
              status: frame.duplicate ? "duplicate" : "accepted",
              revision: frame.revision,
              document: frame.document,
            });
          }
          return;
        }
        case "resync": {
          this.revision = frame.revision;
          this.document = frame.document;
          this.staleNotice = true;
          if (currentOperation) {
            currentOperation.settle({
              status: "stale",
              revision: frame.revision,
              document: frame.document,
            });
          }
          return;
        }
        case "operation_rejected": {
          if (currentOperation?.operationId === frame.operationId) {
            this.document = currentOperation.preDocument;
            this.revision = currentOperation.preRevision;
            this.error = frame.error;
            currentOperation.settle({
              status: "rejected",
              revision: currentOperation.preRevision,
              document: currentOperation.preDocument,
              error: frame.error,
            });
          }
          return;
        }
        case "cursor": {
          this.remoteCursors = {
            ...this.remoteCursors,
            [frame.email]: {
              role: frame.role,
              selection: frame.selection,
              x: frame.x,
              y: frame.y,
            },
          };
          return;
        }
        case "participant_joined": {
          this.participants = frame.participants;
          return;
        }
        case "participant_left": {
          this.participants = frame.participants;
          const remaining = { ...this.remoteCursors };
          delete remaining[frame.participant.email];
          this.remoteCursors = remaining;
          return;
        }
        default: {
          // Exhaustiveness guard: a new ServerFrame variant added without a case here is a
          // compile-time error at this line, not a silently ignored frame.
          const exhaustive: never = frame;
          throw new Error(
            `Unsupported server frame: ${JSON.stringify(exhaustive)}`,
          );
        }
      }
    },

    /**
     * Send one transient cursor/selection update over the live connection. A no-op while not
     * currently connected — cursor frames are never queued or retried, matching their
     * deliberately best-effort, unpersisted nature.
     *
     * @param x Graph-space horizontal position.
     * @param y Graph-space vertical position.
     * @param selection The sender's current selection, or `null`.
     */
    sendCursor(x: number, y: number, selection: CursorSelection | null): void {
      socketHandle?.send({ selection, type: "cursor", x, y });
    },

    /** Clear the selected node/edge, closing the properties panel. */
    selectNothing(): void {
      this.selection = null;
    },

    /** Select one node or edge by id, driving the properties panel. */
    select(kind: "node" | "edge", id: string): void {
      this.selection = { kind, id };
    },
  },
  getters: {
    /** The currently selected node, if any and if it still exists. */
    selectedNode(state) {
      if (state.selection?.kind !== "node" || !state.document) {
        return undefined;
      }
      return state.document.nodes.find(
        (node) => node.id === state.selection?.id,
      );
    },
    /** The currently selected edge, if any and if it still exists. */
    selectedEdge(state) {
      if (state.selection?.kind !== "edge" || !state.document) {
        return undefined;
      }
      return state.document.edges.find(
        (edge) => edge.id === state.selection?.id,
      );
    },
    /** `remoteCursors` as a flat array (email included), convenient for `v-for` rendering. */
    remoteCursorList(state): Array<RemoteCursor & { email: string }> {
      return Object.entries(state.remoteCursors).map(([email, cursor]) => ({
        email,
        ...cursor,
      }));
    },
  },
  state: () => ({
    /** Live connection status — see `../composables/useDiagramSocket.ts`'s `DiagramSocketStatus`. */
    connectionStatus: "idle" as DiagramSocketStatus,
    /** Loaded diagram directory metadata, or `null` before/failing to load. */
    diagram: null as DiagramSummary | null,
    /** Current authoritative document, or `null` before/failing to load. */
    document: null as GraphDocument | null,
    /** User-safe message from the most recent failed request or rejected operation, if any. */
    error: "",
    /** Whether the initial load request is pending. */
    loading: false,
    /** Whether a submitted operation is currently awaiting the room's outcome. */
    pending: false,
    /** Every currently connected participant, from the most recent `sync`/presence frame. */
    participants: [] as Participant[],
    /** Current authoritative revision. */
    revision: 0,
    /** Currently selected node or edge, driving the properties panel. */
    selection: null as { kind: "node" | "edge"; id: string } | null,
    /** Each remote participant's last known transient cursor/selection, keyed by email. */
    remoteCursors: {} as Record<string, RemoteCursor>,
    /** Whether the most recent operation came back `stale` and was resynced. */
    staleNotice: false,
  }),
});
