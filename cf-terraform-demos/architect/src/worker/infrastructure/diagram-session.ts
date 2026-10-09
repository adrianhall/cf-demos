import { DurableObject } from 'cloudflare:workers';
import type { SessionFrame } from '../../live-sync-protocol.ts';
import type {
  GraphSnapshot,
  GraphWriteOutcome,
  RejectedGraphWrite
} from '../application/ports/diagram-session.ts';
import { applyGraphOperation, type GraphOperation } from '../domain/graph-operations.ts';
import { canonicalizeGraphData, type GraphData } from '../domain/graph.ts';
import { D1DiagramRepository } from './d1-diagram-repository.ts';
import { SerializedGraphWriter, toRejection } from './graph-writer.ts';
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
   * afterwards. No graph is sent on connect: the editor has just fetched the diagram over `GET
   * /api/diagrams/:id`, and because every write persists before it is acknowledged, that read is
   * already current. The next sub-phase replaces this with a snapshot frame, when the client starts
   * applying operations and needs the exact graph they will be applied to.
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

    server.serializeAttachment({ viewer } satisfies SocketAttachment);
    // Hibernatable: the runtime, not this object, holds the connection while the diagram is idle.
    this.ctx.acceptWebSocket(server);

    // Echoed from the attachment rather than from the local variable, so what the client is told
    // is literally the value a later frame would be attributed to. See `ConnectedFrame`.
    const attachment = server.deserializeAttachment() as SocketAttachment;
    send(server, { type: 'connected', viewer: attachment.viewer });

    return new Response(null, { status: 101, webSocket: client });
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
   * @returns What was persisted, or the refusal every transport should answer with.
   */
  async applyOperation(operation: GraphOperation): Promise<GraphWriteOutcome> {
    const refusal = await this.hydrate();
    if (refusal !== null) {
      return refusal;
    }

    const applied = this.apply((graph) => applyGraphOperation(graph, operation));
    if (applied.outcome === 'rejected') {
      // Refused before anything was enqueued, so the stored diagram is exactly as it was and no
      // sequence number was consumed. A stale target lands here.
      return applied;
    }

    const outcome = await applied.persisted;
    if (outcome.outcome === 'applied') {
      this.broadcast({
        graphData: outcome.graphData,
        type: 'graph_updated',
        updatedAt: outcome.updatedAt
      });
    }
    return outcome;
  }

  /**
   * Replaces the whole graph, persists it, and updates the session's working copy.
   *
   * The editor's autosave, arriving over the REST fallback route. It takes the same serialized path
   * as {@link DiagramSession.applyOperation} — which is the point of this phase — but broadcasts
   * nothing: a tab's own save is its own change, and the current protocol gives a recipient no way
   * to tell whose change it is receiving. The next sub-phase adds that attribution, and with it the
   * echo.
   *
   * The graph arrives already canonical, validated by `../domain/graph.ts` at the transport
   * boundary, so there is nothing to re-derive here.
   *
   * @param graphData Canonical, already-validated graph JSON to store verbatim.
   * @returns What was persisted, or a refusal — `404` when the diagram has gone, `500` when the
   *   write failed.
   */
  async replaceGraph(graphData: string): Promise<GraphWriteOutcome> {
    const refusal = await this.hydrate();
    if (refusal !== null) {
      return refusal;
    }

    // Straight to `replace`, skipping the mutation step an operation needs: the graph is already
    // canonical, so there is nothing here that can be refused. It is the identical synchronous
    // region and the identical queue position a granular operation gets — which is the point of
    // this phase — just without a step that would have no work to do.
    return this.replace(graphData).persisted;
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
   * Answers a frame sent by a browser, which this channel does not yet accept.
   *
   * The socket is still a one-way push in this sub-phase: the write path has moved into this object
   * but the wire protocol has not changed, so the editor keeps saving over REST and this method
   * keeps saying plainly that it did nothing. A silent drop is indistinguishable from a delivery
   * failure, and a client author debugging one would have no way to tell which they were looking
   * at. The connection stays open, because a client sending here is confused rather than hostile —
   * there is no field in the protocol it could use to assert anything, and this method reads
   * neither the frame's contents nor any identity from it.
   *
   * The viewer is read from the socket attachment purely to prove the pinning survives: a
   * connection whose attachment is missing is closed rather than answered, because an
   * unattributable socket should not exist at all.
   *
   * @param socket Connection the frame arrived on.
   * @param _message Raw frame payload, deliberately never parsed. Nothing a client can send is
   *   actionable yet, so decoding it would only create a surface to get wrong.
   */
  webSocketMessage(socket: WebSocket, _message: string | ArrayBuffer): void {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment === null) {
      // Unreachable through `fetch`, which always attaches before accepting. Closing rather than
      // continuing is the safe response to a connection with no provable identity.
      socket.close(1011, 'Connection is missing its identity.');
      return;
    }

    send(socket, {
      detail: 'This connection is read-only. Save changes with PUT /api/diagrams/:id/graph.',
      type: 'error'
    });
  }

  /**
   * Releases a closed connection.
   *
   * There is nothing to clean up, and that is a property of the design rather than an oversight:
   * the runtime owns the socket list and each socket owns its own identity, so a departed viewer
   * leaves no entry in this object for anything to forget. The working graph is not per-connection
   * state and outlives any one viewer. The handler is declared anyway because its absence would be
   * ambiguous — a reader could not tell whether cleanup was unnecessary or simply missing.
   *
   * @param _socket Connection that closed; unused, because the session tracks no per-socket state
   *   of its own.
   * @param _code Close code reported by the runtime.
   * @param _reason Close reason reported by the runtime.
   */
  webSocketClose(_socket: WebSocket, _code: number, _reason: string): void {
    // Intentionally empty; see this method's documentation.
  }

  /**
   * Releases a failed connection, identically to a clean close.
   *
   * From this object's point of view a viewer whose connection errored and one who closed their tab
   * are both simply gone, and treating them differently would be a distinction with no
   * consequence.
   *
   * @param _socket Connection that failed.
   * @param _error Error the runtime reported.
   */
  webSocketError(_socket: WebSocket, _error: unknown): void {
    // Intentionally empty; see `webSocketClose`.
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
   * Sends one frame to every connected editor.
   *
   * The socket list comes from `ctx.getWebSockets()` rather than from an instance field, because an
   * instance field would be empty after the session hibernated and was reconstructed — which is
   * precisely when a push arrives. The runtime owns the connections; this object only borrows the
   * list when it needs it.
   *
   * @param frame Frame to send to every open connection on this diagram.
   */
  private broadcast(frame: SessionFrame): void {
    for (const socket of this.ctx.getWebSockets()) {
      send(socket, frame);
    }
  }
}
