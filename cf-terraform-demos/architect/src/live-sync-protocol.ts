import type { GraphOperation } from './worker/domain/graph-operations.ts';

/**
 * @file The live-sync WebSocket wire protocol, shared verbatim by the Durable Object that produces
 *   the frames (`src/worker/infrastructure/diagram-session.ts`) and the canvas that consumes them
 *   (`src/client/components/editor/DiagramCanvas.tsx`). It sits in `src/` rather than under
 *   `src/worker/` or `src/client/` for the same reason `./graph-element-types.ts` does: it belongs
 *   to neither side, it is the contract between them. One definition means a frame the object can
 *   send is by construction a frame the canvas can handle — each side's `switch` is checked for
 *   exhaustiveness, so adding a frame here fails the build until both ends handle it. Two
 *   independently written copies would instead fail at runtime, in a browser, as a frame silently
 *   doing nothing. **The channel is now two-way.** A client may send an operation, and the session
 *   answers every one of them, with an acceptance broadcast to everybody or a rejection sent to the
 *   originator alone. That is what lets a second person's edit arrive while you are looking at the
 *   diagram rather than on your next reload.
 *
 *   ## Two kinds of frame, with different durability
 *
 *   Everything above the presence frames describes the **document**: it is persisted to D1 before
 *   it is broadcast, and a recipient that misses one has diverged. The presence, cursor and
 *   selection frames describe the **people**, and are the exact opposite in every respect — they
 *   are never persisted, never ordered, and losing one is invisible. A cursor is replaced by the
 *   next one a fraction of a second later; a missed graph operation is not replaced by anything.
 *   The two are deliberately separate frame types rather than one "update" carrying both, so that
 *   neither side can accidentally give presence the durability of a document change or give a
 *   document change the disposability of a cursor.
 *
 *   ## Why operations travel rather than graphs
 *
 *   A frame could carry the whole resulting graph, and the previous one-way channel did. Sending
 *   the operation instead buys two things a whole graph cannot:
 *
 *   - **A recipient keeps its own pending edits.** Applying "add this node" leaves whatever the user
 *     is halfway through typing; replacing the graph discards it. With two people editing, that is
 *     the difference between collaboration and taking turns.
 *   - **The interface can say what happened.** "Alice added a worker" is a sentence; "the graph
 *     changed" is not. The cost is that a recipient must apply every operation, in order, or
 *     diverge silently. That is what {@link OperationAppliedFrame.sequence} is for, and why a
 *     client that sees a gap asks for a {@link SnapshotFrame} rather than guessing.
 */

/**
 * Who made a change.
 *
 * Needed because the identity is not enough to tell them apart: an agent authenticates as the
 * person who configured it, so an MCP tool call and that same person's own edit arrive from the
 * same email address. Without this the interface could not honestly say "an agent changed this",
 * which is the one thing a user most needs to know about a change they did not make.
 */
export type ChangeOrigin = 'human' | 'agent';

/**
 * An operation a client asks the session to apply — the only frame a client may send.
 *
 * It carries no author field, and that absence is the security design rather than an omission. The
 * session attributes every operation to the identity pinned to the socket it arrived on, so there
 * is nothing here for a client to assert about who it is.
 */
export interface OperationFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'operation';
  /**
   * Client-chosen id for this operation, echoed on the acceptance or rejection.
   *
   * It exists so an originator can match the answer to the optimistic edit it already made, and so
   * skip applying its own change twice. The server never interprets it and two clients choosing the
   * same value affects only those clients.
   */
  operationId: string;
  /**
   * The change to apply; see `src/worker/domain/graph-operations.ts`.
   */
  operation: GraphOperation;
}

/**
 * A client asking for the whole graph again, because it can no longer apply operations safely.
 *
 * Sent when a client sees a gap in {@link OperationAppliedFrame.sequence}. Applying an operation to
 * the wrong base graph is the characteristic failure of operation-based sync and it is silent: the
 * canvas simply drifts from what is stored, and nobody finds out until a reload. Detecting the gap
 * and asking to start again turns that into a brief flicker.
 *
 * It carries nothing. The session knows which diagram it is and which socket asked, and a client
 * saying anything more would only be something to validate.
 */
export interface ResyncFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'resync';
}

/**
 * Every frame a client may send.
 *
 * A discriminated union, so the session's handler is exhaustiveness-checked the same way the
 * client's is: a frame added here cannot ship until the session handles it.
 */
/**
 * A cursor position in React Flow's canvas coordinate system.
 *
 * It is intentionally not a graph position: it marks where a person is looking right now, not where
 * a durable diagram element belongs.
 */
export interface CursorMovedFrame {
  /**
   * Frame discriminator.
   */
  type: 'cursor_moved';
  /**
   * Flow-space horizontal coordinate.
   */
  x: number;
  /**
   * Flow-space vertical coordinate.
   */
  y: number;
}

/**
 * A person's current advisory selection.
 *
 * At most one kind may be selected because the editor itself maintains the same invariant. `null`
 * clears the remote indicator; it does not delete or otherwise alter the selected graph element.
 */
export interface SelectionChangedFrame {
  /**
   * Frame discriminator.
   */
  type: 'selection_changed';
  /**
   * Selected node, or `null` when no node is selected.
   */
  nodeId: string | null;
  /**
   * Selected edge, or `null` when no edge is selected.
   */
  edgeId: string | null;
}

/**
 * Every frame a client may send.
 *
 * Operations and resync requests concern the durable graph. Cursor and selection frames are
 * best-effort ephemeral awareness signals; the session relays them without touching D1.
 */
export type ClientFrame = OperationFrame | ResyncFrame | CursorMovedFrame | SelectionChangedFrame;

/**
 * Sent once to a connection the moment it is accepted.
 *
 * It carries the identity the server pinned to this socket, read back out of the socket attachment
 * rather than echoed from the request. That round trip is the point: the value a later frame would
 * be attributed to is the value the client is shown, so the two cannot disagree. A client that
 * receives an identity it did not expect is looking at a stale Access session and can say so,
 * instead of silently trusting a connection opened for somebody else.
 */
export interface ConnectedFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'connected';
  /**
   * Verified Cloudflare Access identity the Worker authorized this connection for.
   */
  viewer: string;
}

/**
 * The diagram's whole graph, and the point in the operation stream it corresponds to.
 *
 * Sent in three situations, all of them "you cannot get there from here by applying an operation":
 *
 * - **On connect**, so a joining editor knows exactly which graph the operations that follow will be
 *   applied to. The client has just loaded the diagram over HTTP, but a change may have landed
 *   between that response and this socket opening, and an operation applied to the wrong base graph
 *   is worse than no operation at all.
 * - **After a whole-graph save**, which is how the editor still writes — there is no operation to
 *   send, because a whole-graph replace is not expressible as one.
 * - **On request**, when a client has detected a gap in the sequence and cannot safely continue.
 */
export interface SnapshotFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'snapshot';
  /**
   * Canonical graph JSON exactly as it was persisted, so a client renders what is actually stored
   * rather than a reconstruction of it.
   */
  graphData: string;
  /**
   * ISO-8601 timestamp of the write that produced this graph.
   */
  updatedAt: string;
  /**
   * Operation sequence this graph already includes. The client adopts it, and expects the next
   * {@link OperationAppliedFrame} to carry exactly one more.
   */
  sequence: number;
  /**
   * Who produced this graph, or `null` when the snapshot is an answer rather than a change — on
   * connect, and on a resync request. The client shows a notice only for a change.
   */
  origin: ChangeOrigin | null;
  /**
   * Verified identity that produced this graph, or `null` when the snapshot is an answer rather
   * than a change.
   *
   * Carried for the same reason {@link OperationAppliedFrame.actor} is, and from the same kind of
   * source — the verified identity behind the save, never anything a client sent. A whole-graph
   * save is the one change that cannot be described as an operation, so without this it would be
   * the one change the interface could not attribute.
   */
  actor: string | null;
}

/**
 * An operation that has been persisted, sent to every connection on the diagram.
 *
 * Including the originator's. Suppressing the echo would save a frame and cost the one thing that
 * makes an optimistic edit safe: confirmation that what the client drew locally is what the server
 * actually stored.
 */
export interface OperationAppliedFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'operation_applied';
  /**
   * The change that was applied, for a recipient to apply to its own copy.
   */
  operation: GraphOperation;
  /**
   * The originator's own operation id, or `null` when the change did not come from a socket — an
   * agent's tool call has no client id to echo.
   */
  operationId: string | null;
  /**
   * Whether a person or an agent made the change; see {@link ChangeOrigin}.
   */
  origin: ChangeOrigin;
  /**
   * Verified identity the change is attributed to, so the interface can name who made it.
   *
   * Always taken from the authenticated source of the change — the socket's attachment, or the
   * Access identity behind a tool call — and never from anything a client sent.
   */
  actor: string;
  /**
   * ISO-8601 timestamp of the write that applied it.
   */
  updatedAt: string;
  /**
   * Position of this operation in the session's stream, each one exactly one more than the last.
   *
   * A recipient that receives anything other than the number it expected has missed a frame and
   * cannot apply this one safely, because an operation names a node or edge that may no longer mean
   * what it did. It asks for a {@link SnapshotFrame} instead of guessing.
   *
   * The counter is session-scoped and restarts when the object is reconstructed after hibernation,
   * which is deliberate rather than a flaw: that restart is itself a discontinuity a client must
   * resynchronise across, and it produces exactly the mismatch that makes it do so.
   */
  sequence: number;
}

/**
 * An operation the session declined, sent to the originating connection **only**.
 *
 * Nobody else needs to know, and telling them would be worse than noise: a rejection names a node
 * or edge that another viewer may be looking at perfectly happily.
 *
 * The common cause is not a bug but the ordinary shape of collaboration: two people delete the same
 * node, and the second deletion refers to something that is already gone. The connection stays open
 * and the client stays usable — a stale target is a race, not misconduct.
 */
export interface OperationRejectedFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'operation_rejected';
  /**
   * The originator's own operation id, so it knows which optimistic edit to roll back.
   */
  operationId: string;
  /**
   * HTTP status the equivalent REST call would answer with — `404` for a stale target, `400` for an
   * element id already in use, `422` for a graph that fails validation, `500` for a storage
   * failure. Carried so an agent and a browser are told the same thing about the same mistake.
   */
  status: number;
  /**
   * User-safe explanation of why nothing was applied.
   */
  detail: string;
}

/**
 * Sent to one connection whose frame the session could not act on at all.
 *
 * Distinct from {@link OperationRejectedFrame}, which answers a well-formed operation that could not
 * be applied. This one answers a frame that was not a valid operation in the first place, so there
 * is no operation id to return and nothing for the client to roll back.
 *
 * The connection stays open. A client sending a frame this server does not understand is a bug in
 * that client rather than an attack — there is nothing it could say that would be honoured — so the
 * useful response is to say plainly why nothing happened rather than to disconnect a session the
 * user is working in.
 */
/**
 * One connected identity, assigned a deterministic display colour for this live session.
 *
 * Identity comes only from a socket attachment created after Access authorization; colour is
 * derived server-side from that identity so a client cannot impersonate another person's visual
 * marker. It is intentionally absent from D1 and Durable Object storage.
 */
export interface PresenceParticipant {
  /**
   * Verified email address of the connected person.
   */
  email: string;
  /**
   * Stable, session-derived colour used for their avatar, cursor and selection outline.
   */
  color: string;
}

/**
 * The currently connected identities, sent to a newly accepted socket.
 */
export interface PresenceSnapshotFrame {
  /**
   * Frame discriminator.
   */
  type: 'presence_snapshot';
  /**
   * Other identities currently connected to this diagram, one entry per email.
   */
  participants: PresenceParticipant[];
}

/**
 * Announces that an identity became present on the diagram.
 */
export interface PresenceJoinedFrame extends PresenceParticipant {
  /**
   * Frame discriminator.
   */
  type: 'presence_joined';
}

/**
 * Announces that the last socket for an identity left the diagram.
 */
export interface PresenceLeftFrame {
  /**
   * Frame discriminator.
   */
  type: 'presence_left';
  /**
   * Verified email address that is no longer connected.
   */
  email: string;
}

/**
 * Relays a connected person's latest cursor location.
 */
export interface RemoteCursorMovedFrame extends CursorMovedFrame, PresenceParticipant {}

/**
 * Relays a connected person's latest advisory selection.
 */
export interface RemoteSelectionChangedFrame extends SelectionChangedFrame, PresenceParticipant {}

/**
 * Sent to one connection whose frame the session could not act on at all.
 *
 * Distinct from {@link OperationRejectedFrame}, which answers a well-formed operation that could not
 * be applied. This one answers a frame that was not a valid operation in the first place, so there
 * is no operation id to return and nothing for the client to roll back.
 *
 * The connection stays open. A client sending a frame this server does not understand is a bug in
 * that client rather than an attack — there is nothing it could say that would be honoured — so the
 * useful response is to say plainly why nothing happened rather than to disconnect a session the
 * user is working in.
 */
export interface ErrorFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'error';
  /**
   * User-safe explanation of what the server did not do.
   */
  detail: string;
}

/**
 * Every frame the session may send.
 *
 * A discriminated union, so a `switch` on `type` in the browser is exhaustiveness-checked and a
 * frame added here cannot ship until the canvas handles it.
 */
export type SessionFrame =
  | ConnectedFrame
  | SnapshotFrame
  | OperationAppliedFrame
  | OperationRejectedFrame
  | PresenceSnapshotFrame
  | PresenceJoinedFrame
  | PresenceLeftFrame
  | RemoteCursorMovedFrame
  | RemoteSelectionChangedFrame
  | ErrorFrame;
