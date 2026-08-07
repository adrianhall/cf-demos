import { defineStore } from "pinia";
import type {
  AddEdgePayload,
  AddNodePayload,
  DeleteEdgePayload,
  DeleteNodePayload,
  MoveNodePayload,
  OperationKind,
  UpdateNodePayload,
} from "../../graph/operations";
import type { GraphDocument } from "../../graph/types";
import type { DiagramSummary } from "./diagrams";

/** RFC 9457 response fields displayed to the caller. */
interface ProblemDetails {
  /** User-safe explanation of a failed request. */
  detail?: string;
  /** Standard status text fallback. */
  title?: string;
}

/** The four possible outcomes `DiagramRoom.applyOperation` can report — see `../../worker/diagram-room.ts`. */
type OperationStatus = "accepted" | "duplicate" | "stale" | "rejected";

/** Shape of `POST /api/diagrams/:id/operations`'s `{ result }` response body. */
interface OperationResultResponse {
  status: OperationStatus;
  revision: number;
  document: GraphDocument;
  error?: string;
}

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
 * Shared client state for one open diagram's revisioned document.
 *
 * Every mutation goes through {@link applyOperation}, which sends the exact
 * `operationId`/`baseRevision`/`kind`/`payload` envelope `DiagramRoom.applyOperation` expects
 * (`docs/09-ARCHITECT.md`'s Collaboration Protocol), even though Phase 2 has only one editor.
 * Per that protocol, a `stale` result is never silently merged — this store simply replaces its
 * local document/revision with the server's authoritative resync and sets `staleNotice`, so the
 * view can ask the user to retry their edit against the fresh state.
 *
 * Phase 2 deliberately does not apply an operation optimistically before the server responds —
 * that is a Phase 4 (`docs/09-ARCHITECT.md`) concern once real concurrent editors and reconnect/
 * backoff exist. Every state change here reflects only what the server actually accepted.
 */
export const useDiagramDocumentStore = defineStore("diagram-document", {
  actions: {
    /** Add a new product or actor node from the palette. */
    async addNode(node: AddNodePayload["node"]): Promise<void> {
      await this.applyOperation("add_node", { node });
    },

    /** Connect two existing nodes with a typed, labeled edge. */
    async addEdge(edge: AddEdgePayload["edge"]): Promise<void> {
      await this.applyOperation("add_edge", { edge });
    },

    /** Remove one edge and clear its selection if it was selected. */
    async deleteEdge(edgeId: DeleteEdgePayload["edgeId"]): Promise<void> {
      await this.applyOperation("delete_edge", { edgeId });
      if (this.selection?.id === edgeId) {
        this.selection = null;
      }
    },

    /** Remove one node (and every edge connected to it), clearing its selection if selected. */
    async deleteNode(nodeId: DeleteNodePayload["nodeId"]): Promise<void> {
      await this.applyOperation("delete_node", { nodeId });
      if (this.selection?.id === nodeId) {
        this.selection = null;
      }
    },

    /** Persist a node's final position after a completed drag. */
    async moveNode(
      nodeId: MoveNodePayload["nodeId"],
      position: MoveNodePayload["position"],
    ): Promise<void> {
      await this.applyOperation("move_node", { nodeId, position });
    },

    /** Replace a node's editable data (the properties panel's label/description edit). */
    async updateNode(
      nodeId: UpdateNodePayload["nodeId"],
      data: UpdateNodePayload["data"],
    ): Promise<void> {
      await this.applyOperation("update_node", { nodeId, data });
    },

    /**
     * Send one durable operation and reconcile local state with the server's authoritative
     * result.
     *
     * @param kind Operation kind — see `../../graph/operations.ts`.
     * @param payload Operation-specific payload.
     * @returns The server's outcome, so a caller can react to `"rejected"` inline if useful.
     */
    async applyOperation(
      kind: OperationKind,
      payload: Record<string, unknown>,
    ): Promise<OperationResultResponse | undefined> {
      if (!this.diagram) {
        return undefined;
      }
      this.pending = true;
      this.error = "";
      this.staleNotice = false;
      try {
        const response = await fetch(
          `/api/diagrams/${encodeURIComponent(this.diagram.id)}/operations`,
          {
            body: JSON.stringify({
              operationId: crypto.randomUUID(),
              baseRevision: this.revision,
              kind,
              payload,
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          },
        );
        if (!response.ok) {
          this.error = await requestErrorMessage(response);
          return undefined;
        }
        const { result } = (await response.json()) as {
          result: OperationResultResponse;
        };
        this.revision = result.revision;
        this.document = result.document;
        if (result.status === "stale") {
          this.staleNotice = true;
        } else if (result.status === "rejected") {
          this.error = result.error ?? "The edit was rejected.";
        }
        return result;
      } catch {
        this.error =
          "Could not reach the server. Check your connection and try again.";
        return undefined;
      } finally {
        this.pending = false;
      }
    },

    /** Close (dismiss) the stale-resync notice once the user has seen it. */
    dismissStaleNotice(): void {
      this.staleNotice = false;
    },

    /** Load one diagram's metadata and current `DiagramRoom` document. */
    async load(id: string): Promise<void> {
      this.loading = true;
      this.error = "";
      this.selection = null;
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
      } finally {
        this.loading = false;
      }
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
  },
  state: () => ({
    /** Loaded diagram metadata, or `null` before/failing to load. */
    diagram: null as DiagramSummary | null,
    /** Current authoritative document, or `null` before/failing to load. */
    document: null as GraphDocument | null,
    /** User-safe message from the most recent failed request or rejected operation, if any. */
    error: "",
    /** Whether the initial load request is pending. */
    loading: false,
    /** Whether an operation request is currently in flight. */
    pending: false,
    /** Current authoritative revision. */
    revision: 0,
    /** Currently selected node or edge, driving the properties panel. */
    selection: null as { kind: "node" | "edge"; id: string } | null,
    /** Whether the most recent operation came back `stale` and was resynced. */
    staleNotice: false,
  }),
});
