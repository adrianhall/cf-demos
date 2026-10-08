import type { DiagramSessionPort } from '../application/ports/diagram-session.ts';
import type { DiagramSession } from './diagram-session.ts';
import { withVerifiedIdentity } from './session-protocol.ts';

/**
 * Durable Objects implementation of the {@link DiagramSessionPort} port.
 *
 * This adapter exists to keep one Cloudflare-specific detail out of the application layer:
 * `getByName`. `DiagramService` asks to notify "the session for diagram `abc`"; this class is the
 * only place that knows translating a diagram id into a session means asking a
 * `DurableObjectNamespace` for a stub by that name.
 *
 * Addressing by the diagram's own D1 primary key rather than by a stored identifier is what makes
 * the two stores need no reconciliation. There is no session id to persist, no mapping table, and
 * no chance of a row pointing at a session that does not exist — a diagram's id simply _is_ its
 * session's name. Deleting the diagram leaves a session with no sockets and nothing stored, which
 * costs nothing and disappears on its own.
 *
 * ## Why `notifyGraphUpdated` is RPC and `connect` is not
 *
 * `notifyGraphUpdated` is a typed RPC call, which is what every operation here would ideally be:
 * the method name and its arguments are checked by the compiler, and there is no request, header or
 * status code to get wrong.
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
   * @param diagramId Id of a diagram the caller has **already** been shown to own. This adapter
   *   takes no authorization decision; see {@link DiagramSessionPort.connect}.
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
   * Tells a diagram's session that its graph has changed.
   *
   * @param diagramId Id of the diagram whose session should be notified.
   * @param graphData Canonical graph JSON exactly as it was persisted.
   * @param updatedAt ISO-8601 timestamp the persisting write recorded.
   * @returns A promise fulfilled once the session has fanned the update out to every connection.
   * @throws {Error} When the session cannot be reached.
   */
  async notifyGraphUpdated(diagramId: string, graphData: string, updatedAt: string): Promise<void> {
    await this.namespace.getByName(diagramId).notifyGraphUpdated(graphData, updatedAt);
  }
}
