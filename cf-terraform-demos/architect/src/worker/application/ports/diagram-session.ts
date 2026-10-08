/**
 * Coordination port for one diagram's live editing session.
 *
 * This is the seam that keeps everything above infrastructure independent of Durable Objects. The
 * MCP tool layer asks to "tell the session for diagram X that its graph changed"; only
 * `../../infrastructure/durable-diagram-sessions.ts` knows that doing so means asking a
 * `DurableObjectNamespace` for a stub by that name. A unit test can therefore exercise the whole
 * notify-after-persist sequence with a three-line double and no Workers runtime at all.
 *
 * The port is deliberately tiny, because the object behind it is. A session holds no durable data:
 * D1 remains the one authoritative copy of a diagram's graph, and the session exists only as a live
 * fan-out point for the browser connections currently open on it. Two independently persisted
 * copies of one diagram can silently disagree, and nothing in this demo should have to reason about
 * that failure mode — so there is only ever one.
 *
 * ## Why `connect` takes a `Request` and `notifyGraphUpdated` does not
 *
 * {@link DiagramSessionPort.notifyGraphUpdated} is a typed RPC call, which is what every operation
 * here would ideally be: the method name and its arguments are checked by the compiler, and there
 * is no request, header or status code to get wrong.
 *
 * {@link DiagramSessionPort.connect} cannot work that way, and the constraint is the protocol's
 * rather than this design's. Its result carries a live `WebSocket`, which is not serializable
 * across an RPC boundary, and the Hibernation API completes the protocol switch against the
 * incoming request itself. The upgrade therefore travels as a request and the identity travels as a
 * header, with `withVerifiedIdentity` (`../../infrastructure/session-protocol.ts`) responsible for
 * making sure that header can only ever hold a value this Worker verified.
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
   * @param diagramId Id of a diagram whose ownership the caller has **already** verified. The
   *   session performs no authorization of its own: it has no route of its own, so the only way to
   *   reach it is through a Worker that checked first.
   * @param request The viewer's own upgrade request, forwarded so the session can complete the
   *   protocol switch against it.
   * @param viewer Verified Cloudflare Access identity to pin to the new connection.
   * @returns The `101 Switching Protocols` response produced by the session, returned unchanged so
   *   its `webSocket` reaches the browser.
   * @throws {Error} When the session cannot accept the connection.
   */
  connect(diagramId: string, request: Request, viewer: string): Promise<Response>;

  /**
   * Tells a diagram's session that its graph has changed, so every open editor can be updated.
   *
   * Called **after** the write to D1 has succeeded, never before. Broadcasting first would let a
   * connected browser render a graph that a subsequent reload would not show, because the write
   * that would have made it real never happened. Persisting first can at worst lose the broadcast,
   * and the change is still in D1 for the next read.
   *
   * @param diagramId Id of the diagram whose session should be notified.
   * @param graphData Canonical graph JSON exactly as it was persisted.
   * @param updatedAt ISO-8601 timestamp the persisting write recorded, which each client compares
   *   against its own last-known value before replacing anything.
   * @returns A promise fulfilled once the session has fanned the update out to every connection it
   *   holds. A diagram nobody has open is not an error: the session simply has no sockets.
   * @throws {Error} When the session cannot be reached.
   */
  notifyGraphUpdated(diagramId: string, graphData: string, updatedAt: string): Promise<void>;
}
