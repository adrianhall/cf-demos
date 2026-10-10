import type { DocumentationSearchOutcome } from './worker/application/ports/documentation-search.ts';
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
 *
 * `ai-chat` is a third case rather than a flavour of `agent`, and the distinction is one a user can
 * act on. An `agent` change came from outside the application — an MCP client this person
 * configured, running somewhere they are not looking. An `ai-chat` change came from the assistant
 * panel in a browser tab, usually their own, as the direct result of a sentence somebody just
 * typed. Collapsing the two would make the notice say "an agent changed this" to the very person
 * who asked for the change a second ago.
 */
export type ChangeOrigin = 'human' | 'agent' | 'ai-chat';

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
 * One message a person typed at the assistant, starting a chat turn on this connection.
 *
 * It carries no author field, for exactly the reason {@link OperationFrame} does not: the turn is
 * attributed to the identity pinned to the socket it arrived on, and every mutation it makes is
 * attributed the same way. A chat message is the one place where letting a client name an actor
 * would be most tempting and most wrong — the text is free-form, so a frame carrying an `actor`
 * would read like a field the assistant honours. `src/worker/domain/client-frame.ts` refuses one.
 *
 * It carries no conversation history either. The session keeps the transcript per connection, as
 * ephemeral in-memory state alongside the cursor and selection data, so a client cannot replay an
 * invented exchange to steer a later turn.
 */
export interface ChatMessageFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'chat_message';
  /**
   * Client-chosen id for this turn, echoed on every frame the turn produces.
   *
   * It exists so a client can attribute a stream of tokens to the message that started it — the
   * same correlation job {@link OperationFrame.operationId} does, and with the same rule: the server
   * never interprets it.
   */
  clientRequestId: string;
  /**
   * The person's message text.
   */
  text: string;
}

/**
 * Every frame a client may send.
 *
 * Operations and resync requests concern the durable graph. Cursor and selection frames are
 * best-effort ephemeral awareness signals; the session relays them without touching D1. A chat
 * message starts a turn that may produce any number of operations, each of which travels back as an
 * ordinary {@link OperationAppliedFrame} rather than as anything chat-specific — which is what keeps
 * the canvas free of a second way to change itself.
 */
export type ClientFrame =
  | OperationFrame
  | ResyncFrame
  | CursorMovedFrame
  | SelectionChangedFrame
  | ChatMessageFrame;

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
 * A chat turn's progress narration, sent to the connection that started it and nobody else.
 *
 * Deliberately **not** emitted for a graph mutation. A mutation already narrates itself to every
 * connected tab through its confirmed {@link OperationAppliedFrame}, so a status would be a second
 * line about the same change — and, because a status is necessarily emitted before the operation is
 * applied, it would announce changes that were then rejected. This frame therefore serves only the
 * two tools that produce no broadcast of their own: renaming the diagram, and looking something up
 * in the documentation.
 */
export interface ChatStatusFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'chat_status';
  /**
   * The turn this belongs to, echoed from {@link ChatMessageFrame.clientRequestId}.
   */
  clientRequestId: string;
  /**
   * Short human-readable narration, written to be shown verbatim.
   */
  message: string;
}

/**
 * One fragment of the assistant's answer, as it is generated.
 *
 * The concatenation of every fragment in one turn is exactly {@link ChatDoneFrame.assistantText}, so
 * a client that replaces its streamed text with that final value never sees the answer change under
 * it.
 *
 * Only the model's answer travels here. A reasoning model streams its chain of thought on a
 * separate field, and the session never relays it: it is the model talking to itself, and showing
 * it to a user is both confusing and a disclosure nobody asked for.
 */
export interface ChatTokenFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'chat_token';
  /**
   * The turn this belongs to.
   */
  clientRequestId: string;
  /**
   * The next piece of the answer, to be appended to whatever has arrived so far.
   */
  text: string;
}

/**
 * The result of a documentation lookup the assistant performed during a turn.
 *
 * Separate from {@link ChatStatusFrame} because it carries structure rather than a sentence: a
 * client renders it as a list of followable citations, which a narration string could not be.
 */
export interface ChatToolResultFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'chat_tool_result';
  /**
   * The turn this belongs to.
   */
  clientRequestId: string;
  /**
   * The tool that produced it. Only the documentation search reports through this frame; a graph
   * mutation reports through its own broadcast instead.
   */
  tool: 'search_cloudflare_documentation';
  /**
   * The query the assistant chose, so a reader can see what was actually asked on their behalf.
   */
  query: string;
  /**
   * What the lookup produced — the matching pages, or the non-fatal "unavailable" outcome. The
   * failure case travels rather than being suppressed, because a turn that answered without being
   * able to check its facts is a thing the reader should know.
   */
  outcome: DocumentationSearchOutcome;
}

/**
 * A chat turn that finished, sent to the connection that started it.
 *
 * It repeats the whole answer rather than relying on the client's accumulation. That redundancy is
 * cheap and it closes a real gap: a client that missed a token frame would otherwise display a
 * silently incomplete answer with no way to notice.
 */
export interface ChatDoneFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'chat_done';
  /**
   * The turn this completes.
   */
  clientRequestId: string;
  /**
   * The assistant's complete answer.
   */
  assistantText: string;
}

/**
 * A chat turn that failed, sent to the connection that started it and nobody else.
 *
 * Nobody else asked for the turn, and a connection quietly editing the diagram should not be told
 * that somebody else's conversation went wrong. The connection stays open and usable: a model or
 * gateway failure is an outage of one feature, not of the editor.
 */
export interface ChatErrorFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'chat_error';
  /**
   * The turn that failed.
   */
  clientRequestId: string;
  /**
   * User-safe explanation of what did not happen. Any graph changes the turn had already applied
   * stay applied — each one persisted and broadcast on its own — so this says the conversation
   * ended, not that the diagram was rolled back.
   */
  message: string;
}

/**
 * The diagram's title and/or description changed, sent to **every** connection.
 *
 * Broadcast rather than unicast because it is a change to the document, exactly like an operation:
 * every open tab shows the title, so every open tab is now showing a stale one. It is a separate
 * frame rather than part of the graph protocol because the title and description are diagram
 * metadata and live in their own D1 columns — they are not expressible as a {@link GraphOperation}
 * at all.
 */
export interface DiagramRenamedFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'diagram_renamed';
  /**
   * The diagram's new title.
   */
  title: string;
  /**
   * The diagram's new description, or `null` when it has none.
   */
  description: string | null;
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
  | ChatStatusFrame
  | ChatTokenFrame
  | ChatToolResultFrame
  | ChatDoneFrame
  | ChatErrorFrame
  | DiagramRenamedFrame
  | ErrorFrame;
