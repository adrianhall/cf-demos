import type { GraphOperation } from '../../domain/graph-operations.ts';

/**
 * A graph write that happened: what was stored, and when.
 *
 * Both fields describe what **D1 now holds**, not what the caller asked for, and the difference is
 * real rather than pedantic. Writes are serialized, and a link in that queue reads the newest
 * working graph when its turn begins — so an operation whose persist ran after a later operation's
 * change had already been applied reports that newer graph. Reporting the caller's own intention
 * instead would hand back a graph nobody can read out of storage.
 */
export interface AppliedGraphWrite {
  /**
   * Discriminator: the write reached D1.
   */
  outcome: 'applied';
  /**
   * Canonical graph JSON exactly as it was persisted.
   */
  graphData: string;
  /**
   * ISO-8601 timestamp the persisting write recorded.
   */
  updatedAt: string;
  /**
   * How many writes this session has applied since it was last constructed.
   *
   * Session-scoped and deliberately not durable: it restarts at zero after hibernation, because it
   * identifies the order of writes within one live session rather than the version of a document.
   * D1's `updatedAt` is the durable ordering. The next sub-phase puts this on the wire so a client
   * can tell a frame it has already applied from a new one.
   */
  sequence: number;
}

/**
 * A graph write that was refused, with the answer every transport should give.
 *
 * A **value, not an exception**, and that is forced by the transport as much as chosen. These
 * refusals cross a Durable Object RPC boundary, where a thrown error arrives as a plain `Error`
 * carrying only a message: a `ProblemDetailsError`'s status would be stripped off in transit, and
 * an agent's stale-target refusal would silently become a `500`. Returning the status as data is
 * what keeps a refusal identical whichever transport asked for the write.
 *
 * It is also the behaviour the Durable Object itself needs. The Phase 16 spike confirmed that an
 * uncaught exception discards the object's in-memory state, so an ordinary concurrent-editing
 * outcome — two people deleting the same node — must not be expressed as a throw.
 */
export interface RejectedGraphWrite {
  /**
   * Discriminator: nothing was stored.
   */
  outcome: 'rejected';
  /**
   * HTTP status the equivalent REST call answers with — `404` for a stale target or a diagram that
   * has gone, `400` for an element id already in use, `422` for a graph that fails canonical
   * validation, `500` for a storage failure.
   */
  status: number;
  /**
   * User-safe explanation, used verbatim as the problem document's detail.
   */
  detail: string;
}

/**
 * What a write through the session produced.
 */
export type GraphWriteOutcome = AppliedGraphWrite | RejectedGraphWrite;

/**
 * Coordination port for one diagram's live editing session — and, since this phase, the **one
 * serialized path every graph write takes**.
 *
 * This is the seam that keeps everything above infrastructure independent of Durable Objects. A
 * caller asks the session for diagram X to apply a change; only
 * `../../infrastructure/durable-diagram-sessions.ts` knows that doing so means asking a
 * `DurableObjectNamespace` for a stub by that name.
 *
 * ## Why every write now goes through here
 *
 * Before this phase the application tier wrote to D1 itself and then told the session to push the
 * result. That left a race nothing could close: two writers could each read the stored graph, each
 * apply their change to it, and each write back — the second silently discarding the first, because
 * neither ever saw the other. The browser, the REST fallback and an agent's MCP tool were three
 * such writers.
 *
 * Routing them all through one Durable Object replaces that with the platform's own guarantee. A
 * Durable Object is single-threaded and there is exactly one instance per diagram id, so a
 * synchronous read-modify-replace cannot be interleaved; and the object orders its own persists in
 * a queue, so a slow earlier write cannot land after a faster later one. **The execution model is
 * the correctness mechanism** — there is no CRDT, no operational transform and no version vector
 * here, deliberately.
 *
 * D1 remains the diagram's only durable copy. The session caches the graph in memory to serialize
 * against; it stores nothing of its own, so there is no second copy for the two to disagree about.
 *
 * ## Why `connect` takes a `Request` and the write methods do not
 *
 * The write methods are typed RPC calls, which is what every operation here would ideally be: the
 * method name and its arguments are checked by the compiler, and there is no request, header or
 * status code to get wrong.
 *
 * {@link DiagramSessionPort.connect} cannot work that way, and the constraint is the protocol's
 * rather than this design's. Its result carries a live `WebSocket`, which is not serializable
 * across an RPC boundary, and the Hibernation API completes the protocol switch against the
 * incoming request itself. The upgrade therefore travels as a request and the identity travels as a
 * header, with `withVerifiedIdentity` (`../../infrastructure/session-protocol.ts`) responsible for
 * making sure that header can only ever hold a value this Worker verified.
 *
 * ## Authorization is not here
 *
 * Every method assumes the caller has already decided the actor may write to this diagram. The
 * session has no route of its own, so the only way to reach it is through a Worker that checked
 * first, and `../diagram-service.ts` is where that check is written once for every transport.
 */
export interface DiagramSessionPort {
  /**
   * Opens an authenticated WebSocket to a diagram's live session.
   *
   * The caller's own `Request` is part of the contract, which is unusual for a port and is a
   * deliberate concession to how WebSocket upgrades work — see this interface's own documentation.
   * The implementation is responsible for ensuring nothing the client sent on that request can
   * influence the identity the session records.
   *
   * @param diagramId Id of a diagram the caller has **already** been authorized against. The
   *   session performs no authorization of its own.
   * @param request The viewer's own upgrade request, forwarded so the session can complete the
   *   protocol switch against it.
   * @param viewer Verified Cloudflare Access identity to pin to the new connection.
   * @returns The `101 Switching Protocols` response produced by the session, returned unchanged so
   *   its `webSocket` reaches the browser.
   * @throws {Error} When the session cannot accept the connection.
   */
  connect(diagramId: string, request: Request, viewer: string): Promise<Response>;

  /**
   * Applies one granular operation to a diagram's graph, persists it, and pushes the result.
   *
   * The operation travels as a **value** rather than a function, which the RPC boundary requires:
   * arguments are structured-cloned and a closure is not cloneable. See
   * `../../domain/graph-operations.ts`.
   *
   * The implementation applies the change synchronously, awaits its ordered persist, and only then
   * broadcasts — persist before broadcast, so a connected editor can never render a change that a
   * reload would not show.
   *
   * @param diagramId Id of the diagram to change.
   * @param operation The single operation to apply.
   * @returns What was persisted, or a refusal carrying the status every transport should answer
   *   with. A stale target is a refusal rather than a thrown error, because two people editing the
   *   same diagram is the ordinary case this whole phase exists to serve.
   * @throws {Error} When the session itself cannot be reached — a transport failure, as distinct
   *   from a refusal, which arrives as a value.
   */
  applyOperation(diagramId: string, operation: GraphOperation): Promise<GraphWriteOutcome>;

  /**
   * Replaces a diagram's entire graph, persists it, and updates the session's working copy.
   *
   * The editor's autosave target. It stays a whole-graph replace rather than becoming a stream of
   * operations because the browser genuinely sends the complete graph today; what changes in this
   * phase is only that the write is serialized against every other writer instead of racing them.
   *
   * Nothing is broadcast. A tab's own autosave is its own change, and the current protocol has no
   * way for a recipient to tell whose change it is receiving — the next sub-phase adds that, and
   * with it the echo.
   *
   * @param diagramId Id of the diagram to change.
   * @param graphData Canonical, already-validated graph JSON to store verbatim.
   * @returns What was persisted, or a refusal — `404` when the diagram has gone.
   * @throws {Error} When the session cannot be reached.
   */
  replaceGraph(diagramId: string, graphData: string): Promise<GraphWriteOutcome>;
}

/**
 * A diagram's graph as one session currently holds it.
 *
 * Deliberately **not** on {@link DiagramSessionPort}: nothing in the application tier reads a graph
 * through a session, and it should stay that way. Because every write persists before it returns,
 * D1 is already current by the time any caller could ask, so `GET /api/diagrams/:id` reads the row
 * directly and spends no hop on a Durable Object. The session's own snapshot answers a different
 * question — "what is this session working from?" — which only the object itself and its tests have
 * any business asking. The next sub-phase's connect handshake needs it, and that happens inside the
 * object rather than through this port.
 */
export interface GraphSnapshot {
  /**
   * Canonical graph JSON.
   */
  graphData: string;
  /**
   * ISO-8601 timestamp of the write that produced it.
   */
  updatedAt: string;
}
