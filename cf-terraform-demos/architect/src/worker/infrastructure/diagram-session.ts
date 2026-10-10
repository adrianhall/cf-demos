import { DurableObject } from 'cloudflare:workers';
import type { ChangeOrigin, PresenceParticipant, SessionFrame } from '../../live-sync-protocol.ts';
import type {
  GraphSnapshot,
  GraphWriteOutcome,
  RejectedGraphWrite
} from '../application/ports/diagram-session.ts';
import { parseClientFrame } from '../domain/client-frame.ts';
import { applyGraphOperation, type GraphOperation } from '../domain/graph-operations.ts';
import { canonicalizeGraphData, type GraphData } from '../domain/graph.ts';
import { D1DiagramRepository } from './d1-diagram-repository.ts';
import { SerializedGraphWriter, toRejection } from './graph-writer.ts';
import { presenceColorFor } from './presence-color.ts';
import { IDENTITY_HEADER } from './session-protocol.ts';

/**
 * What the session pins to each accepted connection.
 *
 * Stored with `serializeAttachment` rather than in an instance field, because an instance field
 * would not survive hibernation: the session is evicted from memory while its sockets stay open at
 * the edge, and is reconstructed when the next event arrives. An in-memory map of socket to
 * identity would be empty at exactly the moment the identity is needed.
 */
interface SocketAttachment {
  /**
   * Verified Cloudflare Access identity the Worker authorized this connection for.
   *
   * Written once, when the socket is accepted, and read back from the attachment thereafter. It is
   * never taken from a frame — the wire protocol (`src/live-sync-protocol.ts`) has no field a
   * client could put one in.
   */
  viewer: string;
  /**
   * Deterministic display colour derived from the verified identity when the socket was accepted.
   *
   * It travels in the attachment so a reconstructed object can rebuild presence from the runtime's
   * surviving socket list without storing a second, durable presence record.
   */
  color: string;
}

/**
 * Sends one frame to a socket, skipping any socket that is no longer open.
 *
 * The state check matters during a fan-out: a browser can close a tab between the runtime listing
 * the sockets and the session reaching theirs, and sending to a closed socket throws. One departing
 * viewer must not abort delivery to everybody after them in the list.
 *
 * @param socket Connection to send on.
 * @param frame Frame to serialize and send.
 */
function send(socket: WebSocket, frame: SessionFrame): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}

/**
 * Reads the persisted attachment from a live socket.
 *
 * @param socket Hibernatable socket owned by this session.
 * @returns Its verified identity and display colour, or `null` for a malformed attachment.
 */
function attachmentFor(socket: WebSocket): SocketAttachment | null {
  const attachment = socket.deserializeAttachment();
  if (
    typeof attachment !== 'object'
    || attachment === null
    || !('viewer' in attachment)
    || !('color' in attachment)
    || typeof attachment.viewer !== 'string'
    || typeof attachment.color !== 'string'
  ) {
    return null;
  }
  return attachment as SocketAttachment;
}

/**
 * Returns an operation whose creating inputs carry a concrete id, minting one only when the
 * originator did not supply it.
 *
 * `operation_applied` is a **replicated** message. This session applies the operation to its own
 * working graph, and every connected browser re-applies the broadcast copy to its own. That is only
 * correct when applying the same operation twice produces the same ids — and an id-less `add_node`
 * or `add_edge` does not: `../domain/graph-mutations.ts` mints a fresh `crypto.randomUUID()` on
 * every call, so each replica invents a different id and diverges from this session permanently.
 * Nothing recovers from that on its own, because a snapshot is only sent on connect, on a
 * whole-graph write, and on request.
 *
 * It is a **protocol-level** fix rather than an AI-chat one. A remote human edit, an MCP tool call
 * and a chat turn all replicate through the same broadcast, so all three have the same defect; it
 * simply takes an actor that creates an element and then immediately references it by id to make
 * the divergence visible. The symptom is characteristic and misleading: the server reports every
 * edge connected, and the canvas shows none, because each `add_edge` named a node id only the
 * server has.
 *
 * The browser already supplies its own id (`src/client/lib/graph-operation-diff.ts`), so this is a
 * no-op for a human edit. It matters for every server-authored operation, which is every operation
 * that was never optimistically applied somewhere first.
 *
 * Applied **before** the mutation rather than after it, so the operation that is applied and the
 * operation that is broadcast are the same value. Deriving the id afterwards would leave two
 * objects that have to be kept in step, which is the shape of the bug rather than its fix.
 *
 * @param operation The operation as its originator authored it.
 * @returns The operation unchanged when it creates nothing or already names an id, and a copy
 *   carrying a minted `input.id` otherwise. `operation` itself is never mutated.
 */
function withReplicableIds(operation: GraphOperation): GraphOperation {
  if (operation.kind === 'add_node' && operation.input.id === undefined) {
    return { ...operation, input: { ...operation.input, id: crypto.randomUUID() } };
  }
  if (operation.kind === 'add_edge' && operation.input.id === undefined) {
    return { ...operation, input: { ...operation.input, id: crypto.randomUUID() } };
  }
  return operation;
}

/**
 * The result of a synchronous mutation region: either nothing happened, or a persist is pending.
 *
 * Returned as a value rather than awaited inside the mutation itself, which is the whole point —
 * the synchronous region must end before anything is awaited, or the input gate opens inside it.
 */
type AppliedSynchronously =
  | {
      /**
       * Discriminator: the working graph changed and its persist is queued.
       */
      outcome: 'enqueued';
      /**
       * The queued write's eventual outcome.
       */
      persisted: Promise<GraphWriteOutcome>;
    }
  | RejectedGraphWrite;

/**
 * One diagram's live editing session: the single serialized writer for its graph, and the fan-out
 * point every editor tab open on that diagram connects to.
 *
 * There is exactly one instance per diagram id, addressed with
 * `env.DIAGRAM_SESSIONS.getByName(diagramId)`. Isolation between diagrams is therefore structural
 * rather than enforced: a different id is a different object, with its own sockets and its own
 * working graph, so there is no cross-diagram query to get wrong and no shared state to leak.
 *
 * ## Why every write comes here
 *
 * Until this phase each writer wrote to D1 itself: the editor's autosave, the REST route behind it,
 * and an agent's MCP tool. Three independent writers reading a row, changing it and writing it back
 * is a lost-update race, and no amount of care at any one call site closes it — the second writer
 * never saw the first.
 *
 * Routing every write through one object replaces that with two guarantees the platform provides
 * directly, and **the execution model is the correctness mechanism**: there is no CRDT, no
 * operational transform and no version vector here, deliberately.
 *
 * - **A synchronous mutation cannot be interleaved.** A Durable Object is single-threaded, and the
 *   input gate holds new events while synchronous JavaScript runs. {@link DiagramSession.apply}
 *   reads the working graph, computes the replacement and assigns it with no `await` in between, so
 *   two concurrent operations are applied one after the other rather than both against the same
 *   starting graph. The gate opens at the first `await`, which is intended: a later edit may be
 *   accepted while an earlier persist is still in flight.
 * - **Persists are strictly ordered.** Each write joins the session's {@link WriteQueue} and waits
 *   for the previous one. Without that queue a slow earlier write lands _after_ a faster later one
 *   and silently restores the older graph — reproduced in the Phase 16 spike, and still pinned by a
 *   counter-example test that runs the same scenario with and without it.
 *
 * The honest statement of the guarantee, which the spike corrected: the chain makes the **final**
 * persisted value last-applied-wins. Reading the newest working graph when a link begins coalesces
 * queued writes toward current state, but it cannot retroactively change a write already in flight,
 * so an observer watching D1 mid-sequence may still see an intermediate graph.
 *
 * ## It holds no durable state, deliberately
 *
 * D1's `diagrams` table stays the single authoritative copy, unconditionally. This object never
 * calls `ctx.storage` at all. Two independently persisted copies of one diagram can silently
 * disagree, and reconciling them would be a whole second problem the demo does not need.
 *
 * The in-memory graph is therefore a **cache, not a copy**: it is what concurrent writers serialize
 * against, and it is reconstructed from D1 whenever the object is. A write is not acknowledged
 * until D1 has it.
 *
 * ## Persist before broadcast
 *
 * {@link DiagramSession.applyOperation} awaits its persist and only then broadcasts. The source
 * design for this feature broadcast first for latency; this repository's rule is the opposite, and
 * the rule wins. Broadcasting first lets a connected editor render a change that a reload would not
 * show, which is a worse failure than a slower update: the user is looking at something that does
 * not exist. Persisting first can at worst lose a broadcast, and the change is still in D1 for the
 * next read.
 *
 * ## Hibernation
 *
 * Connections are accepted with `ctx.acceptWebSocket()` rather than `socket.accept()`, which puts
 * them under the WebSocket Hibernation API. An editor tab left open overnight stays connected at
 * the edge while this object is evicted from memory, so an idle diagram costs nothing.
 *
 * Everything this object holds in a field is gone after that eviction — and, as the Phase 16 spike
 * recorded from the platform documentation, also after an uncaught exception. Both are handled the
 * same way and neither loses data: per-connection identity lives in a socket attachment (see
 * {@link SocketAttachment}), and the graph is re-read from D1 by {@link DiagramSession.hydrate}.
 * The uncaught-exception case is why an ordinary refusal — a stale target, a duplicate id — is
 * returned as a value and never thrown: two people deleting the same node is the case this phase
 * exists to serve, and it must not be able to discard a hot session.
 *
 * ## Why this class is in the infrastructure tier
 *
 * It backs the `DiagramSessionPort` contract (`../application/ports/diagram-session.ts`), reached
 * through the `DurableDiagramSessions` adapter, and it is the adapter for a specific Cloudflare
 * product — so it belongs beside the D1 repositories rather than in the application layer. It
 * depends on the `DiagramRepository` **port** rather than on D1 directly for the same reason every
 * other tier does: the write it performs is "replace this diagram's graph", not "run this SQL".
 * Nothing above infrastructure mentions a Durable Object namespace.
 */
export class DiagramSession extends DurableObject<Env> {
  /**
   * The diagram's canonical graph JSON as this session currently holds it, or `null` before the
   * first hydration.
   *
   * Held as the canonical string rather than a parsed object so that what is broadcast, what is
   * persisted and what the next operation is applied to are byte-identical by construction. Parsing
   * happens inside the synchronous mutation region, where it cannot be interleaved.
   */
  private graphData: string | null = null;

  /**
   * ISO-8601 timestamp of the most recent persisted write, or `null` before the first hydration.
   */
  private updatedAt: string | null = null;

  /**
   * How many writes this session has applied since it was constructed.
   *
   * Session-scoped and deliberately not durable — see `AppliedGraphWrite.sequence`. It restarts at
   * zero after hibernation because it orders writes within one live session rather than versioning
   * the document; D1's `updatedAt` is the durable ordering.
   */
  private sequence = 0;

  /**
   * Whether every socket surviving in this instance knows the base graph for its sequence counter.
   *
   * `false` on construction, including reconstruction after hibernation. That second case is the
   * reason this field exists: the counter is deliberately in memory and restarts at zero, while
   * hibernatable sockets stay open at the edge holding the old counter. Before the reconstructed
   * instance announces sequence 1, it must therefore broadcast a sequence-0 snapshot so those
   * clients adopt the new base rather than misreading 1 as an old duplicate.
   *
   * It is set after the initial connect snapshot in an ordinary fresh instance, so the first edit
   * does not send a redundant second copy.
   */
  private streamBased = false;

  /**
   * The serialized persistence half of this session, built during hydration — it needs the diagram
   * id, which hydration is also what establishes.
   *
   * Strict ordering is what makes the final persisted value last-applied-wins; see
   * `./graph-writer.ts` and `./write-queue.ts` for the guarantee it does and does not give, and for
   * the poisoning failure it recovers from.
   */
  private writer: SerializedGraphWriter | null = null;

  /**
   * Accepts an editor's connection to this diagram.
   *
   * This is a `fetch` handler rather than an RPC method, unlike every other operation on this
   * object, and that is forced by the protocol rather than chosen. The response carries a live
   * `WebSocket`, which cannot be serialized across an RPC boundary, and the Hibernation API
   * completes the protocol switch against the incoming request itself. The upgrade therefore has to
   * arrive as a request.
   *
   * The consequence is that the viewer's identity arrives in a header, which this method trusts
   * without checking. That is safe for two reasons, both established outside this class: a Durable
   * Object has no route of its own, so the only way here is through a Worker that authenticated the
   * caller **and** verified they may reach this diagram; and `withVerifiedIdentity` (see
   * `./session-protocol.ts`) strips any client-supplied copy of the header before setting the
   * verified one. This object never re-derives authorization — it lives at the Worker boundary,
   * where it is written once for every transport.
   *
   * The identity is pinned to the connection here, once, and read back from the attachment
   * afterwards.
   *
   * A snapshot follows the acknowledgement, and it is not redundant with the `GET
   * /api/diagrams/:id` the editor has just made. A change can land between that response and this
   * socket opening, and from now on the client applies _operations_ — so it needs to know exactly
   * which graph, and which point in the operation stream, those will be applied to. Being one frame
   * late with a base graph is how an operation-based client diverges silently.
   *
   * @param request Upgrade request forwarded by the Worker, carrying the verified identity in
   *   {@link IDENTITY_HEADER}.
   * @returns A `101 Switching Protocols` response whose `webSocket` is the client end of the new
   *   connection, or a `400` when the request is not an identified upgrade. That `400` is
   *   unreachable through the Worker, which answers a non-upgrade request with `426` and always
   *   sets the header; it exists so a direct call during development fails clearly instead of
   *   creating an unattributed connection.
   */
  async fetch(request: Request): Promise<Response> {
    const viewer = request.headers.get(IDENTITY_HEADER);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' || viewer === null) {
      return new Response('Expected an identified WebSocket upgrade.', { status: 400 });
    }

    const [client, server] = Object.values(new WebSocketPair());

    server.serializeAttachment({
      color: presenceColorFor(viewer),
      viewer
    } satisfies SocketAttachment);
    // Hibernatable: the runtime, not this object, holds the connection while the diagram is idle.
    this.ctx.acceptWebSocket(server);

    // Echoed from the attachment rather than from the local variable, so what the client is told
    // is literally the value a later frame would be attributed to. See `ConnectedFrame`.
    const attachment = attachmentFor(server);
    if (attachment === null) {
      server.close(1011, 'Connection is missing its identity.');
      return new Response('Could not establish connection identity.', { status: 500 });
    }
    send(server, { type: 'connected', viewer: attachment.viewer });

    // Presence is a projection of open sockets, not state this object owns. The joining socket gets
    // an accurate snapshot while everybody already here hears a join only when this is the first
    // tab for that identity; a second tab is not a second collaborator.
    const wasAlreadyPresent = this.hasOtherOpenSocketForViewer(server, attachment.viewer);
    if (!wasAlreadyPresent) {
      this.broadcast(
        { color: attachment.color, email: attachment.viewer, type: 'presence_joined' },
        server
      );
    }
    send(server, {
      participants: this.otherParticipants(server, attachment.viewer),
      type: 'presence_snapshot'
    });

    // Sent after the response is returned rather than awaited before it, because the client end
    // of this socket does not exist until the caller has the `101`. `waitUntil` is what keeps the
    // object alive for a hydration that outlives the request.
    this.ctx.waitUntil(this.sendInitialSnapshot(server));

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Sends a joining connection the graph its operations will be applied to.
   *
   * Separate from {@link DiagramSession.fetch} because it may have to read D1, which must not delay
   * the `101`: a client cannot receive anything until it holds its end of the socket.
   *
   * A diagram that has gone is answered with nothing rather than an error. The upgrade was
   * authorized against a diagram that existed moments ago, so this is a delete that raced the
   * connection — and the client is about to be told by every other route that the diagram is gone.
   * A failure frame here would be the least clear way it could find out.
   *
   * @param socket Server end of the newly accepted connection.
   * @returns A promise fulfilled once the snapshot has been offered.
   */
  private async sendInitialSnapshot(socket: WebSocket): Promise<void> {
    const snapshot = await this.getSnapshot();
    if (snapshot === null) {
      return;
    }

    // `origin: null` and `actor: null`: this is an answer rather than a change, so the client has
    // nothing to announce to its user.
    send(socket, {
      actor: null,
      graphData: snapshot.graphData,
      origin: null,
      sequence: this.sequence,
      type: 'snapshot',
      updatedAt: snapshot.updatedAt
    });
    this.streamBased = true;
  }

  /**
   * Applies one granular operation, persists it, and pushes the result to every open editor.
   *
   * The phase's central method, and the order of its three steps is the whole design:
   *
   * 1. **Mutate synchronously** through {@link DiagramSession.apply} — no `await` between reading the
   *    working graph and replacing it, so a concurrent operation cannot be applied to the same
   *    starting graph.
   * 2. **Persist through the ordered queue**, and wait for it.
   * 3. **Broadcast**, only once D1 has the change.
   *
   * A refusal is returned rather than thrown at every step, including a storage failure. Two people
   * editing one diagram is the ordinary case here, and an uncaught exception would discard the
   * session's working graph along with answering the caller.
   *
   * @param operation The single operation to apply; see `../domain/graph-operations.ts`.
   * @param actor Verified identity to attribute the change to. Supplied by the caller because this
   *   entry point is reached by RPC rather than over a socket, so there is no attachment to read it
   *   from — the application tier has already verified it.
   * @returns What was persisted, or the refusal every transport should answer with.
   */
  async applyOperation(operation: GraphOperation, actor: string): Promise<GraphWriteOutcome> {
    // Every RPC caller is an agent: a browser's own operations arrive over its socket and are
    // handled by `webSocketMessage`. The origin is therefore fixed here rather than taken as an
    // argument, so no caller can claim to be a person.
    return this.runOperation(operation, { actor, operationId: null, origin: 'agent' });
  }

  /**
   * Replaces the whole graph, persists it, and updates the session's working copy.
   *
   * The editor's autosave, arriving over the REST fallback route. It takes the same serialized path
   * as an operation does — which is the point of the serialization work — and announces itself as a
   * **snapshot** rather than an operation, because a whole-graph replace is not expressible as one.
   * A recipient therefore replaces its graph here, where it would otherwise have applied a change,
   * and that is precisely why the editor should prefer operations: this frame discards a
   * recipient's in-progress edit and an operation does not.
   *
   * The graph arrives already canonical, validated by `../domain/graph.ts` at the transport
   * boundary, so there is nothing to re-derive here.
   *
   * @param graphData Canonical, already-validated graph JSON to store verbatim.
   * @param actor Verified identity that saved it, used to attribute the snapshot.
   * @returns What was persisted, or a refusal — `404` when the diagram has gone, `500` when the
   *   write failed.
   */
  async replaceGraph(graphData: string, actor: string): Promise<GraphWriteOutcome> {
    const refusal = await this.hydrate();
    if (refusal !== null) {
      return refusal;
    }

    this.rebaseSurvivingSockets();

    // Straight to `replace`, skipping the mutation step an operation needs: the graph is already
    // canonical, so there is nothing here that can be refused. It is the identical synchronous
    // region and the identical queue position a granular operation gets, just without a step that
    // would have no work to do.
    const outcome = await this.replace(graphData).persisted;

    if (outcome.outcome === 'applied') {
      this.broadcast({
        actor,
        graphData: outcome.graphData,
        // Always a person: an agent has granular operations and never replaces a whole graph.
        origin: 'human',
        sequence: outcome.sequence,
        type: 'snapshot',
        updatedAt: outcome.updatedAt
      });
    }
    return outcome;
  }

  /**
   * Reads the session's working graph without changing it.
   *
   * Deliberately **not** on the port, and so not reachable from the application tier. Because every
   * write persists before it returns, D1 is already current by the time any caller could ask, so
   * `GET /api/diagrams/:id` reads the row directly and spends no hop on a Durable Object. What this
   * answers is a different question — "what is this session working from?" — which only the object
   * itself and its tests have any business asking. Two callers qualify: the next sub-phase's
   * connect handshake, which must hand a joining editor the graph that subsequent operations will
   * be applied to; and the hydration tests, which prove an evicted session re-reads D1 rather than
   * starting empty. That property has no other observation point, because a hydrated session nobody
   * asks anything looks exactly like one that lost its state.
   *
   * @returns The current graph and the timestamp of the write that produced it, or `null` when no
   *   diagram has this session's id.
   */
  async getSnapshot(): Promise<GraphSnapshot | null> {
    if ((await this.hydrate()) !== null) {
      return null;
    }

    return { graphData: this.graphData as string, updatedAt: this.updatedAt as string };
  }

  /**
   * Applies a frame a browser sent — the inbound half of the live channel.
   *
   * **The author comes from the socket, never from the frame.** It is read back out of the
   * attachment the upgrade pinned, which is what makes attribution unforgeable: the wire protocol
   * has no author field at all, and `../domain/client-frame.ts` refuses a payload that invents one.
   * A connection whose attachment is missing is closed rather than answered, because an
   * unattributable socket should not exist.
   *
   * Nothing here throws. An uncaught exception in a Durable Object discards its in-memory state and
   * can reset the instance, which would disconnect every other editor on the diagram — so a
   * malformed frame from one client must not be able to disturb anybody else. Every failure becomes
   * a frame sent back to the sender alone, and the connection stays open: a client sending
   * something unusable is confused rather than hostile.
   *
   * @param socket Connection the frame arrived on, and the only connection a refusal is sent to.
   * @param message Raw frame payload, validated before any part of it is used.
   * @returns A promise fulfilled once the frame has been applied and answered. Returned rather than
   *   fired and forgotten so the runtime keeps the object alive until the write completes.
   */
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = attachmentFor(socket);
    if (attachment === null) {
      // Unreachable through `fetch`, which always attaches before accepting. Closing rather than
      // continuing is the safe response to a connection with no provable identity.
      socket.close(1011, 'Connection is missing its identity.');
      return;
    }

    let frame;
    try {
      frame = parseClientFrame(message);
    } catch (error) {
      // Not an operation this server recognises, so there is no operation id to return and
      // nothing for the client to roll back — which is what distinguishes this from a rejection.
      send(socket, { detail: toRejection(error).detail, type: 'error' });
      return;
    }

    switch (frame.type) {
      case 'operation': {
        const outcome = await this.runOperation(frame.operation, {
          actor: attachment.viewer,
          operationId: frame.operationId,
          origin: 'human'
        });
        if (outcome.outcome === 'rejected') {
          // To the originator alone. Nobody else asked for this change, and telling them it
          // failed would name an element they may be editing quite happily.
          send(socket, {
            detail: outcome.detail,
            operationId: frame.operationId,
            status: outcome.status,
            type: 'operation_rejected'
          });
        }
        return;
      }
      case 'resync': {
        const snapshot = await this.getSnapshot();
        if (snapshot !== null) {
          // `origin: null` because this is an answer rather than a change — the client asked, so
          // it has nothing to announce to its user.
          send(socket, {
            actor: null,
            graphData: snapshot.graphData,
            origin: null,
            sequence: this.sequence,
            type: 'snapshot',
            updatedAt: snapshot.updatedAt
          });
        }
        return;
      }
      case 'cursor_moved':
        // Best effort only. It deliberately bypasses graph hydration, mutation and persistence: a
        // cursor that vanishes during hibernation is correct; a cursor that writes D1 is not.
        this.broadcast(
          {
            color: attachment.color,
            email: attachment.viewer,
            type: 'cursor_moved',
            x: frame.x,
            y: frame.y
          },
          socket
        );
        return;
      case 'selection_changed':
        this.broadcast(
          {
            color: attachment.color,
            edgeId: frame.edgeId,
            email: attachment.viewer,
            nodeId: frame.nodeId,
            type: 'selection_changed'
          },
          socket
        );
        return;
    }
  }

  /**
   * Announces an identity's departure when this was their final open tab.
   *
   * The runtime owns the authoritative live-socket list. Recomputing from that list avoids an
   * in-memory presence map that hibernation would erase, while deduplicating multiple tabs for the
   * same identity in exactly the same way connection joins do.
   *
   * @param socket Socket that closed or failed.
   * @returns Nothing.
   */
  private announceDeparture(socket: WebSocket): void {
    const attachment = attachmentFor(socket);
    if (attachment === null || this.hasOtherOpenSocketForViewer(socket, attachment.viewer)) {
      return;
    }
    this.broadcast({ email: attachment.viewer, type: 'presence_left' }, socket);
  }

  /**
   * Releases a closed connection and, when necessary, announces that its identity left.
   *
   * @param socket Connection that closed.
   * @param _code Close code reported by the runtime.
   * @param _reason Close reason reported by the runtime.
   * @returns Nothing.
   */
  webSocketClose(socket: WebSocket, _code: number, _reason: string): void {
    this.announceDeparture(socket);
  }

  /**
   * Releases a failed connection identically to a clean close.
   *
   * @param socket Connection that failed.
   * @param _error Error the runtime reported.
   * @returns Nothing.
   */
  webSocketError(socket: WebSocket, _error: unknown): void {
    this.announceDeparture(socket);
  }

  /**
   * Applies one operation from any source, persists it, and announces it — the one write path.
   *
   * Both entry points reach it: an agent's RPC call and a browser's socket frame. Sharing it is
   * what makes "the same change behaves the same way whoever made it" true by construction rather
   * than by two implementations agreeing, and it is why attribution is a parameter rather than
   * something each caller broadcasts for itself.
   *
   * The order of the three steps is the whole design:
   *
   * 1. **Mutate synchronously** through {@link DiagramSession.apply} — no `await` between reading the
   *    working graph and replacing it, so a concurrent operation cannot be applied to the same
   *    starting graph.
   * 2. **Persist through the ordered queue**, and wait for it.
   * 3. **Broadcast**, only once D1 has the change.
   *
   * A refusal is returned rather than thrown at every step, including a storage failure. Two people
   * editing one diagram is the ordinary case here, and an uncaught exception would discard the
   * session's working graph along with answering the caller.
   *
   * @param operation The single operation to apply.
   * @param attribution Who made the change and, for a socket operation, the client's own id for it.
   *   Never derived from the operation itself.
   * @returns What was persisted, or the refusal to answer the originator with.
   */
  private async runOperation(
    operation: GraphOperation,
    attribution: { actor: string; origin: ChangeOrigin; operationId: string | null }
  ): Promise<GraphWriteOutcome> {
    const refusal = await this.hydrate();
    if (refusal !== null) {
      return refusal;
    }

    this.rebaseSurvivingSockets();

    // Before the mutation, so what is applied here and what is broadcast below are one value. A
    // server-authored creating operation would otherwise persist an id it never announced; see
    // {@link withReplicableIds}.
    const replicable = withReplicableIds(operation);

    const applied = this.apply((graph) => applyGraphOperation(graph, replicable));
    if (applied.outcome === 'rejected') {
      // Refused before anything was enqueued, so the stored diagram is exactly as it was and no
      // sequence number was consumed. A stale target lands here.
      return applied;
    }

    const outcome = await applied.persisted;
    if (outcome.outcome === 'applied') {
      // The operation rather than the resulting graph, so a recipient can apply it without losing
      // the edit it has in progress. See `src/live-sync-protocol.ts`.
      this.broadcast({
        actor: attribution.actor,
        operation: replicable,
        operationId: attribution.operationId,
        origin: attribution.origin,
        sequence: outcome.sequence,
        type: 'operation_applied',
        updatedAt: outcome.updatedAt
      });
    }
    return outcome;
  }

  /**
   * Rebases sockets that survived this object's hibernation onto its restarted sequence counter.
   *
   * A hibernatable socket can outlive the object instance that accepted it. When an event wakes the
   * object, the socket still has the old instance's operation sequence while this instance's
   * in-memory counter has restarted at zero. Sending operation 1 straight away would look like an
   * old duplicate to a client already at operation 10, so it would discard a real edit. A
   * sequence-0 snapshot is the discontinuity marker: the client adopts both the graph and the new
   * base, then applies operation 1 normally.
   *
   * The check and broadcast are synchronous and happen before the mutation, so no operation can be
   * delivered between the rebase and the edit it prepares the sockets for.
   *
   * @returns Nothing. A fresh instance with no surviving sockets simply broadcasts to nobody and
   *   marks itself based, which is harmless and saves repeating the empty fan-out.
   */
  private rebaseSurvivingSockets(): void {
    if (this.streamBased) {
      return;
    }

    this.broadcast({
      actor: null,
      graphData: this.graphData as string,
      origin: null,
      sequence: this.sequence,
      type: 'snapshot',
      updatedAt: this.updatedAt as string
    });
    this.streamBased = true;
  }

  /**
   * Runs one mutation against the working graph and enqueues its persist, without ever awaiting.
   *
   * **Every statement in this method is synchronous, and that is the correctness property it exists
   * to make visible.** The input gate holds incoming events while synchronous JavaScript runs, so
   * no other operation can be delivered between the read of `this.graphData` and its replacement.
   * Introducing an `await` anywhere here — even one that looks harmless — reopens the lost-update
   * race the whole phase removes: the Phase 16 spike reproduced exactly that, with two concurrent
   * operations both reading the same starting value and one overwriting the other.
   *
   * @param mutate Produces the replacement graph from the current parsed graph.
   * @returns Either a refusal, when the mutation or its canonicalisation was rejected and nothing
   *   was enqueued, or the pending ordered persist for the change just applied.
   */
  private apply(mutate: (graph: GraphData) => GraphData): AppliedSynchronously {
    let next: string;
    try {
      next = canonicalizeGraphData(mutate(JSON.parse(this.graphData as string) as GraphData));
    } catch (error) {
      // A stale target, a duplicate element id, or a graph that fails canonical validation.
      // Nothing has been assigned or enqueued, so the session is exactly as it was.
      return toRejection(error);
    }

    return this.replace(next);
  }

  /**
   * Installs a new working graph and enqueues its persist, synchronously.
   *
   * The common tail of both write paths, and the point at which a change becomes this session's
   * current state. Kept to these three statements so that "nothing may `await` between reading the
   * graph and replacing it" is checkable by reading them.
   *
   * The sequence number is consumed here rather than at persist time, so it records the order
   * changes were _applied_, which is the order that resolves a same-target conflict. Which client's
   * promise settles first is not it.
   *
   * @param graphData Canonical graph JSON to become the working graph.
   * @returns The pending ordered persist for this change.
   */
  private replace(graphData: string): {
    outcome: 'enqueued';
    persisted: Promise<GraphWriteOutcome>;
  } {
    this.graphData = graphData;
    this.sequence += 1;

    return { outcome: 'enqueued', persisted: this.enqueuePersist(this.sequence) };
  }

  /**
   * Adds one persist to the ordered queue and records its result on the session.
   *
   * The queueing itself lives in {@link SerializedGraphWriter}, which is where the two properties
   * the spike separated are implemented and tested: strict ordering, which makes the final
   * persisted value last-applied-wins, and reading the working graph when the turn arrives rather
   * than capturing it at submission, which stops a waiting write storing a superseded graph.
   *
   * A failed persist leaves the working graph holding a change D1 does not have, and that is the
   * right choice rather than an accepted flaw. Every write here persists the **whole** graph rather
   * than a delta, so the next successful write carries the failed change with it: the session heals
   * itself on the next edit. Discarding the cache instead would mean throwing away edits that
   * succeeded alongside the one that did not, and would have to happen while later writes were
   * already queued against it. Nothing is broadcast and the caller is told the write failed, so no
   * client is shown the un-persisted change; a session that is never written to again is evicted
   * and rebuilt from D1, which is the correct end state for a change that never landed.
   *
   * @param sequence Order this change was applied in, reported back to its own caller.
   * @returns The outcome of this write, including a refusal when the write was rejected — never a
   *   rejected promise, so an ordinary storage failure cannot discard the session's state.
   */
  private async enqueuePersist(sequence: number): Promise<GraphWriteOutcome> {
    const outcome = await (this.writer as SerializedGraphWriter).write(
      // Read when the write's turn arrives, not now. See `./graph-writer.ts`.
      () => this.graphData as string,
      sequence
    );

    if (outcome.outcome === 'applied') {
      this.updatedAt = outcome.updatedAt;
    }
    return outcome;
  }

  /**
   * Loads the diagram's graph from D1 the first time this instance needs it.
   *
   * Called at the start of every write and read, because an instance is reconstructed after
   * hibernation or an uncaught exception and has no way to know which it is. The cost falls only on
   * the first such call: afterwards the working graph is the session's own, kept current by every
   * write that goes through it.
   *
   * `blockConcurrencyWhile` holds incoming events for the duration, so two operations arriving
   * together cannot both start a hydration and race each other's result. It is used here rather
   * than in the constructor on purpose: a session that only fans out a frame, or only accepts a
   * connection, never needs the graph at all, and paying a D1 read on every cold upgrade would be a
   * cost with no reader.
   *
   * @returns `null` once the working graph is available, or a `404` refusal when no diagram has
   *   this session's id — which is the only outcome a caller can act on, so it is returned rather
   *   than thrown.
   * @throws {Error} When D1 rejects the read. Deliberately not converted: a caller cannot proceed
   *   without a graph, and reporting a storage outage as "not found" would be a lie that a client
   *   would act on by deleting its local copy.
   */
  private async hydrate(): Promise<RejectedGraphWrite | null> {
    if (this.graphData !== null) {
      return null;
    }

    const id = this.ctx.id.name;
    if (id === undefined) {
      // Addressed by a raw id rather than by name, so there is no diagram to load. Unreachable
      // through `DurableDiagramSessions`, which only ever uses `getByName`; it is refused rather
      // than thrown for the same reason every other refusal here is a value — an uncaught
      // exception resets the instance and takes every open connection with it, which would turn a
      // caller's mistake into an outage for people who made none.
      return { detail: 'Diagram not found.', outcome: 'rejected', status: 404 };
    }

    const repository = new D1DiagramRepository(this.env.DB);
    const diagram = await this.ctx.blockConcurrencyWhile(async () => repository.find(id));

    if (diagram === null) {
      return { detail: 'Diagram not found.', outcome: 'rejected', status: 404 };
    }

    this.graphData = diagram.graphData;
    this.updatedAt = diagram.updatedAt;
    // Built with the id resolved above, so the writer physically cannot be pointed at another
    // diagram's row.
    this.writer = new SerializedGraphWriter(repository, id);
    return null;
  }

  /**
   * Reports whether an identity has another open tab on this diagram.
   *
   * @param except Socket to omit, normally the one joining or leaving.
   * @param viewer Verified identity to look for.
   * @returns Whether another open socket carries that identity's attachment.
   */
  private hasOtherOpenSocketForViewer(except: WebSocket, viewer: string): boolean {
    return this.ctx.getWebSockets().some((socket) => {
      const attachment = attachmentFor(socket);
      return (
        socket !== except && socket.readyState === WebSocket.OPEN && attachment?.viewer === viewer
      );
    });
  }

  /**
   * Builds the deduplicated participant projection for a joining connection.
   *
   * @param except Joining socket, which must not list itself.
   * @param viewer Joining identity, whose other tabs must also be hidden from its own snapshot.
   * @returns Current other participants, one per verified identity.
   */
  private otherParticipants(except: WebSocket, viewer: string): PresenceParticipant[] {
    const participants = new Map<string, PresenceParticipant>();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = attachmentFor(socket);
      if (
        socket !== except
        && socket.readyState === WebSocket.OPEN
        && attachment !== null
        && attachment.viewer !== viewer
      ) {
        participants.set(attachment.viewer, { color: attachment.color, email: attachment.viewer });
      }
    }
    return [...participants.values()];
  }

  /**
   * Sends one frame to every connected editor except an optional socket.
   *
   * The socket list comes from `ctx.getWebSockets()` rather than from an instance field, because an
   * instance field would be empty after the session hibernated and was reconstructed — which is
   * precisely when a push arrives. The runtime owns the connections; this object only borrows the
   * list when it needs it.
   *
   * @param frame Frame to send to every open connection on this diagram.
   * @param except Connection that originated an ephemeral frame and should not receive its echo.
   */
  private broadcast(frame: SessionFrame, except?: WebSocket): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== except) {
        send(socket, frame);
      }
    }
  }
}
