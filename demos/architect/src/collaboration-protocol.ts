/**
 * WebSocket wire protocol shared by the `DiagramRoom` Durable Object
 * (`./worker/diagram-room.ts`) and the browser's collaboration store/composable
 * (`./client/composables/useDiagramSocket.ts`, `./client/stores/diagram-document.ts`).
 *
 * Keeping one module as the source of truth for the frame shapes, close codes, trusted header
 * names, and the cursor rate limit prevents the client and the Durable Object from silently
 * drifting apart on the protocol they both speak — the same convention `./access-policies.ts`
 * uses for Access path policies shared by the Worker and the local Vite plugin, and
 * `demos/chat/src/chat-protocol.ts` uses for that demo's own room protocol.
 *
 * This matches `docs/09-ARCHITECT.md`'s Collaboration Protocol and the measured decisions in
 * `spikes/07-architect-collaboration/REPORT.md`, extended from that spike's two-node
 * `final_position`-only probe to this demo's full `DurableOperation` envelope
 * (`./graph/operations.ts`) — see this repository's `AGENTS.md` for why the Durable Object's
 * existing `document_state`/`operations` schema and `applyOperation` semantics are reused
 * unchanged rather than forked for the WebSocket transport.
 */
import type { DurableOperation } from "./graph/operations";
import type { GraphDocument } from "./graph/types";

/** A diagram member's role, sourced only from Cloudflare Access + D1 — never a WebSocket message. */
export type ParticipantRole = "owner" | "editor";

/**
 * One currently connected collaborator.
 *
 * Presence is transient: it is always derived from `ctx.getWebSockets()` and each socket's
 * `serializeAttachment()`-backed identity, never from a persisted table (`docs/09-ARCHITECT.md`'s
 * Data And State Model).
 */
export interface Participant {
  /** Verified Cloudflare Access email. */
  email: string;
  /** The member's `diagram_members` role. */
  role: ParticipantRole;
}

/** A selected node or edge, mirroring `useDiagramDocumentStore`'s own selection shape. */
export interface CursorSelection {
  /** Whether the selection is a node or an edge. */
  kind: "node" | "edge";
  /** Selected element's id. */
  id: string;
}

/**
 * Request header the Worker's `/api/diagrams/:id/ws` route sets with the caller's verified
 * Cloudflare Access email before forwarding the upgrade to `DiagramRoom`. Any client-supplied
 * value is deleted first — see `./worker/routes/diagrams.ts`.
 */
export const TRUSTED_IDENTITY_HEADER = "X-Architect-Identity";

/**
 * Request header the Worker's `/api/diagrams/:id/ws` route sets with the caller's verified
 * `diagram_members` role (`"owner"` or `"editor"`) before forwarding the upgrade to
 * `DiagramRoom`. Any client-supplied value is deleted first — see `./worker/routes/diagrams.ts`.
 */
export const TRUSTED_ROLE_HEADER = "X-Architect-Role";

/**
 * WebSocket close code for a malformed or unsupported collaboration frame — matches
 * `spikes/07-architect-collaboration/REPORT.md`'s measured decision exactly.
 */
export const MALFORMED_FRAME_CLOSE_CODE = 4400;

/**
 * WebSocket close code sent when a socket forwarded to `DiagramRoom` carries no trusted identity
 * attachment. Unreachable through the real Worker upgrade route — which always sets
 * {@link TRUSTED_IDENTITY_HEADER}/{@link TRUSTED_ROLE_HEADER} before forwarding — this exists so
 * the Durable Object never silently trusts a request that bypassed the Worker. Matches
 * `spikes/07-architect-collaboration/REPORT.md`'s measured decision exactly.
 */
export const MISSING_TRUSTED_IDENTITY_CLOSE_CODE = 4401;

/**
 * Minimum interval between transient cursor broadcasts accepted from one connection, matching
 * `spikes/07-architect-collaboration/REPORT.md`'s measured decision exactly.
 */
export const CURSOR_BROADCAST_INTERVAL_MS = 50;

/**
 * Client -> room: one durable, revisioned edit.
 *
 * Deliberately the exact same envelope `POST /api/diagrams/:id/operations` already accepts
 * (`./worker/diagrams/operation-input.ts`'s `validateOperationInput`), so the Durable Object
 * validates and applies a WebSocket-submitted operation with the identical logic as the Phase 2
 * HTTP route — see `./worker/diagram-room.ts`'s `applyOperation()`, which both transports call.
 */
export interface OperationFrame {
  type: "operation";
  /** The revisioned edit envelope. */
  operation: DurableOperation;
}

/**
 * Client -> room: a transient cursor/selection update.
 *
 * Never persisted and never included in a `resync`/`sync` document — see
 * `docs/09-ARCHITECT.md`'s Collaboration Protocol ("Cursor, selection, and drag-preview messages
 * are transient"). `x`/`y` are graph-space coordinates (the same coordinate system as
 * `ArchitectureNode.position`), not screen pixels, so every viewer can correctly place a remote
 * cursor regardless of its own pan/zoom.
 */
export interface CursorFrame {
  type: "cursor";
  /** Graph-space horizontal position. */
  x: number;
  /** Graph-space vertical position. */
  y: number;
  /** The sender's current selection, or `null` when nothing is selected. */
  selection: CursorSelection | null;
}

/** Every frame shape a client may send over a diagram's WebSocket. */
export type ClientFrame = OperationFrame | CursorFrame;

/**
 * Room -> client: sent once, immediately after a successful upgrade, with the complete
 * authoritative state a newly connected client needs to render the diagram and its current
 * collaborators without a separate HTTP request.
 */
export interface SyncFrame {
  type: "sync";
  /** Current authoritative revision. */
  revision: number;
  /** Current authoritative document. */
  document: GraphDocument;
  /** Every currently connected participant, including the socket that just connected. */
  participants: Participant[];
}

/**
 * Room -> client: broadcast to every connected socket, including the one that submitted the
 * operation, after an operation is newly accepted or recognized as a harmless retry of an
 * already-accepted `operationId`.
 *
 * Every client — sender included — applies this exact frame identically, which is what
 * guarantees convergence on one authoritative document per `docs/09-ARCHITECT.md`'s Phase 4
 * "Definition of done." There is deliberately no separate sender-only acknowledgement shape.
 */
export interface OperationAcceptedFrame {
  type: "operation_accepted";
  /** The operation's client-generated idempotency key. */
  operationId: string;
  /** The authoritative revision after processing. */
  revision: number;
  /**
   * `true` when this `operationId` had already been accepted (a harmless retry, matching
   * `spikes/07-architect-collaboration/REPORT.md`'s measured duplicate semantics) and was not
   * re-applied. Sent to the retrying sender only — see the module documentation on the deliberate
   * divergence from the spike's broadcast-to-everyone duplicate handling.
   */
  duplicate: boolean;
  /** The authoritative document after processing. */
  document: GraphDocument;
}

/**
 * Room -> client, sender only: the operation's `baseRevision` did not match the room's current
 * revision. Never merged automatically — the client replaces its local state with this frame's
 * document/revision and must ask the user to retry their edit against the fresh state
 * (`docs/09-ARCHITECT.md`'s Collaboration Protocol).
 */
export interface ResyncFrame {
  type: "resync";
  /** Current authoritative revision. */
  revision: number;
  /** Current authoritative document. */
  document: GraphDocument;
}

/**
 * Room -> client, sender only: the operation's envelope was well-formed and its `baseRevision`
 * was current, but applying it produced an invalid result (an unknown node/edge reference, an
 * uncurated product, and so on — see `./graph/operations.ts` and `./graph/validation.ts`).
 * Nothing was applied; this is never broadcast, since no other participant's state changed.
 */
export interface OperationRejectedFrame {
  type: "operation_rejected";
  /** The rejected operation's client-generated idempotency key. */
  operationId: string;
  /** User-safe explanation of the rejection. */
  error: string;
}

/**
 * Room -> client: one participant's transient cursor/selection, broadcast to every other
 * connected socket (never back to the sender, which already knows its own cursor position).
 */
export interface CursorBroadcastFrame {
  type: "cursor";
  /** Verified Cloudflare Access email of the participant whose cursor moved. */
  email: string;
  /** That participant's `diagram_members` role. */
  role: ParticipantRole;
  /** Graph-space horizontal position. */
  x: number;
  /** Graph-space vertical position. */
  y: number;
  /** That participant's current selection, or `null`. */
  selection: CursorSelection | null;
}

/**
 * Room -> client: a new participant connected, broadcast to every socket that was already
 * connected before it (the new socket itself learns about every participant, itself included,
 * from its own {@link SyncFrame}).
 */
export interface ParticipantJoinedFrame {
  type: "participant_joined";
  /** The participant that just connected. */
  participant: Participant;
  /** The complete, updated participant list. */
  participants: Participant[];
}

/**
 * Room -> client: a participant disconnected, broadcast to every remaining connected socket.
 */
export interface ParticipantLeftFrame {
  type: "participant_left";
  /** The participant that disconnected. */
  participant: Participant;
  /** The complete, updated participant list. */
  participants: Participant[];
}

/** Every frame shape `DiagramRoom` may send over a diagram's WebSocket. */
export type ServerFrame =
  | SyncFrame
  | OperationAcceptedFrame
  | ResyncFrame
  | OperationRejectedFrame
  | CursorBroadcastFrame
  | ParticipantJoinedFrame
  | ParticipantLeftFrame;
