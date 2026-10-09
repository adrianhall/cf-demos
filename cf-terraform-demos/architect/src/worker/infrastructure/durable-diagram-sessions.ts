import type {
  DiagramSessionPort,
  GraphWriteOutcome
} from '../application/ports/diagram-session.ts';
import type { GraphOperation } from '../domain/graph-operations.ts';
import type { DiagramSession } from './diagram-session.ts';
import { withVerifiedIdentity } from './session-protocol.ts';

/**
 * Durable Objects implementation of the {@link DiagramSessionPort} port.
 *
 * This adapter exists to keep one Cloudflare-specific detail out of the application layer:
 * `getByName`. `DiagramService` asks to apply a change to "the session for diagram `abc`"; this
 * class is the only place that knows translating a diagram id into a session means asking a
 * `DurableObjectNamespace` for a stub by that name.
 *
 * Addressing by the diagram's own D1 primary key rather than by a stored identifier is what makes
 * the two stores need no reconciliation. There is no session id to persist, no mapping table, and
 * no chance of a row pointing at a session that does not exist — a diagram's id simply _is_ its
 * session's name. It is also what lets the session derive the row it writes to from its own name
 * rather than trusting a caller to say, so no caller can address one session and have it write to
 * another diagram. Deleting the diagram leaves a session with no sockets and nothing stored, which
 * costs nothing and disappears on its own.
 *
 * Every method here is one line, and deliberately so: an adapter that decided anything would be a
 * second place authorization or ordering could be got wrong.
 *
 * ## Why the write methods are RPC and `connect` is not
 *
 * The write methods are typed RPC calls, which is what every operation here would ideally be: the
 * method name and its arguments are checked by the compiler, and there is no request, header or
 * status code to get wrong. This is also why an operation travels as a **value** — RPC arguments
 * are structured-cloned, and the closure the application tier used to pass is not cloneable.
 *
 * `connect` cannot work that way. Its result carries a live `WebSocket`, which is not serializable
 * across an RPC boundary — attempting it fails at runtime with `DataCloneError` — and the
 * Hibernation API completes the protocol switch against the incoming request itself. The upgrade
 * therefore goes over `fetch()` and the identity travels as a header, with `withVerifiedIdentity`
 * (see `./session-protocol.ts`) responsible for making sure that header can only ever hold a value
 * this Worker verified.
 */
export class DurableDiagramSessions implements DiagramSessionPort {
  /**
   * @param namespace Durable Object namespace bound to this Worker as `DIAGRAM_SESSIONS`, whose
   *   instances are {@link DiagramSession}s.
   */
  constructor(private readonly namespace: DurableObjectNamespace<DiagramSession>) {}

  /**
   * Opens an authenticated WebSocket to a diagram's live session.
   *
   * The viewer's own request is forwarded, because the Hibernation API completes the protocol
   * switch against it. `withVerifiedIdentity` rewrites its headers first, discarding any identity
   * header the client sent and replacing it with the one the Access middleware verified — which is
   * what makes the session's unconditional trust in that header sound.
   *
   * @param diagramId Id of a diagram the caller has **already** been authorized against. This
   *   adapter takes no authorization decision; see {@link DiagramSessionPort.connect}.
   * @param request The viewer's upgrade request.
   * @param viewer Verified Cloudflare Access identity to pin to the connection.
   * @returns The `101 Switching Protocols` response produced by the session, returned unchanged so
   *   its `webSocket` reaches the browser.
   * @throws {Error} When the session cannot accept the connection.
   */
  async connect(diagramId: string, request: Request, viewer: string): Promise<Response> {
    return this.namespace.getByName(diagramId).fetch(withVerifiedIdentity(request, viewer));
  }

  /**
   * Applies one granular operation to a diagram's graph through its session.
   *
   * @param diagramId Id of the diagram to change.
   * @param operation The single operation to apply.
   * @returns What was persisted, or the refusal to answer with.
   * @throws {Error} When the session cannot be reached.
   */
  async applyOperation(diagramId: string, operation: GraphOperation): Promise<GraphWriteOutcome> {
    return this.namespace.getByName(diagramId).applyOperation(operation);
  }

  /**
   * Replaces a diagram's entire graph through its session.
   *
   * @param diagramId Id of the diagram to change.
   * @param graphData Canonical, already-validated graph JSON.
   * @returns What was persisted, or the refusal to answer with.
   * @throws {Error} When the session cannot be reached.
   */
  async replaceGraph(diagramId: string, graphData: string): Promise<GraphWriteOutcome> {
    return this.namespace.getByName(diagramId).replaceGraph(graphData);
  }
}
