import { DurableObject } from 'cloudflare:workers';
import type { SessionFrame } from '../../live-sync-protocol.ts';
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
 * One diagram's live editing session: the fan-out point every editor tab open on that diagram
 * connects to.
 *
 * There is exactly one instance per diagram id, addressed with
 * `env.DIAGRAM_SESSIONS.getByName(diagramId)`. Isolation between diagrams is therefore structural
 * rather than enforced: a different id is a different object, with its own sockets, so there is no
 * cross-diagram query to get wrong and no shared state to leak.
 *
 * ## It holds no durable graph, deliberately
 *
 * D1's `diagrams` table stays the single authoritative copy of a diagram, unconditionally. This
 * object never calls `ctx.storage` at all. That is the central design decision of this phase and it
 * is worth being explicit about: two independently persisted copies of one diagram can silently
 * disagree, and reconciling them would be a whole second problem the demo does not need. What this
 * object contributes is the one thing D1 cannot — it knows which browsers are connected right now,
 * so a change can reach them the instant it lands rather than whenever something next polls.
 *
 * A Durable Object is the right tool for precisely that and for nothing more here:
 *
 * - **Live fan-out.** The object holds the open WebSockets. Neither D1 nor KV has any notion of a
 *   connected reader.
 * - **A single addressable point per diagram.** Every writer of a given diagram reaches the same
 *   instance, so there is no "which replica holds the sockets" question to answer.
 *
 * ## The channel is one-way
 *
 * Server to client only. The browser's own edits keep using the debounced `PUT
 * /api/diagrams/:id/graph` autosave they always have; this phase adds a read channel, not a second
 * write path. {@link DiagramSession.webSocketMessage} therefore accepts nothing and says so — see
 * its own documentation for why it answers rather than simply ignoring the frame.
 *
 * ## Hibernation
 *
 * Connections are accepted with `ctx.acceptWebSocket()` rather than `socket.accept()`, which puts
 * them under the WebSocket Hibernation API. An editor tab left open overnight stays connected at
 * the edge while this object is evicted from memory, so an idle diagram costs nothing. When an
 * agent finally changes something, the runtime reconstructs the object and delivers the RPC call.
 * Everything the session needs after that reconstruction must therefore live in a socket attachment
 * — see {@link SocketAttachment} — because this object has no storage to put it in and an instance
 * field would be gone.
 *
 * ## Why this class is in the infrastructure tier
 *
 * It backs the `DiagramSessionPort` contract (`../application/ports/diagram-session.ts`), reached
 * through the `DurableDiagramSessions` adapter, and it is the adapter for a specific Cloudflare
 * product — so it belongs beside the D1 repositories rather than in the application layer. Nothing
 * above infrastructure mentions a Durable Object namespace.
 */
export class DiagramSession extends DurableObject<Env> {
  /**
   * Accepts an editor's connection to this diagram.
   *
   * This is a `fetch` handler rather than an RPC method, unlike
   * {@link DiagramSession.notifyGraphUpdated}, and that is forced by the protocol rather than
   * chosen. The response carries a live `WebSocket`, which cannot be serialized across an RPC
   * boundary, and the Hibernation API completes the protocol switch against the incoming request
   * itself. The upgrade therefore has to arrive as a request.
   *
   * The consequence is that the viewer's identity arrives in a header, which this method trusts
   * without checking. That is safe for two reasons, both established outside this class: a Durable
   * Object has no route of its own, so the only way here is through a Worker that authenticated the
   * caller **and** verified they own this diagram; and `withVerifiedIdentity` (see
   * `./session-protocol.ts`) strips any client-supplied copy of the header before setting the
   * verified one. This object never re-derives ownership — authorization lives at the Worker
   * boundary, where it is written once for every transport.
   *
   * The identity is pinned to the connection here, once, and read back from the attachment
   * afterwards. No graph is sent on connect: the editor has just fetched the diagram over `GET
   * /api/diagrams/:id` and holds a newer copy than this object could offer, since this object holds
   * none at all.
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
   * Pushes a diagram's new graph to every editor currently open on it.
   *
   * A typed RPC method, which every call into this object except the upgrade should be. It is
   * called by the Worker — never by a browser — immediately **after** a graph-mutating MCP tool has
   * persisted to D1. The ordering is load-bearing and is enforced at the call site in
   * `../application/diagram-service.ts`: broadcasting first would let a connected browser render a
   * graph a later reload would not show.
   *
   * No persistence happens here, because this object has nothing to persist to. A diagram nobody
   * has open simply has no sockets, which is an ordinary outcome rather than a failure.
   *
   * @param graphData Canonical graph JSON exactly as it was written to D1.
   * @param updatedAt ISO-8601 timestamp of that write, which each client compares against its own
   *   last-known value before replacing anything it is showing.
   * @returns A promise fulfilled once the frame has been offered to every open connection.
   */
  async notifyGraphUpdated(graphData: string, updatedAt: string): Promise<void> {
    this.broadcast({ graphData, type: 'graph_updated', updatedAt });
  }

  /**
   * Answers a frame sent by a browser, which this channel does not accept.
   *
   * The socket is a one-way push. Rather than ignoring the frame, the session says plainly that it
   * did nothing: a silent drop is indistinguishable from a delivery failure, and a client author
   * debugging one would have no way to tell which they were looking at. The connection stays open,
   * because a client sending here is confused rather than hostile — there is no field in the
   * protocol it could use to assert anything, and this method reads neither the frame's contents
   * nor any identity from it.
   *
   * The viewer is read from the socket attachment purely to prove the pinning survives: a
   * connection whose attachment is missing is closed rather than answered, because an
   * unattributable socket should not exist at all.
   *
   * @param socket Connection the frame arrived on.
   * @param _message Raw frame payload, deliberately never parsed. Nothing a client can send is
   *   actionable, so decoding it would only create a surface to get wrong.
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
   * leaves no entry in this object for anything to forget. The handler is declared anyway because
   * its absence would be ambiguous — a reader could not tell whether cleanup was unnecessary or
   * simply missing.
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
