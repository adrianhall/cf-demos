import type { DiagramSessionPort } from '../../src/worker/application/ports/diagram-session.ts';

/**
 * @file An in-memory {@link DiagramSessionPort}, shared by every service and tool suite that
 *   exercises a graph mutation. It exists because the port does: the application tier depends on an
 *   interface rather than on a Durable Object namespace, so the whole persist-then-notify sequence
 *   can be asserted in plain Node with no Workers runtime. The real fan-out behaviour —
 *   hibernatable sockets, attachment-pinned identity, two connections receiving one push — has no
 *   meaningful fake and is covered against real `workerd` in `../integration/live-sync.test.ts`.
 */

/**
 * One recorded `notifyGraphUpdated` call.
 */
export interface RecordedNotification {
  /**
   * Diagram whose session was notified.
   */
  diagramId: string;
  /**
   * Canonical graph JSON the caller pushed.
   */
  graphData: string;
  /**
   * Timestamp the caller pushed.
   */
  updatedAt: string;
}

/**
 * One recorded `connect` call.
 */
export interface RecordedConnection {
  /**
   * Diagram whose session was connected to.
   */
  diagramId: string;
  /**
   * Verified identity the Worker authorized the connection for.
   */
  viewer: string;
}

/**
 * In-memory {@link DiagramSessionPort} that records what it was asked to do.
 *
 * It takes no authorization decision and performs no validation of its own, deliberately: the point
 * of a suite using it is to prove the _service_ refused, or persisted before notifying, so a fake
 * that second-guessed either would make those assertions meaningless.
 */
export class FakeDiagramSessions implements DiagramSessionPort {
  /**
   * Every push this fake received, in order.
   */
  readonly notifications: RecordedNotification[] = [];

  /**
   * Every connection this fake was asked to open, in order.
   */
  readonly connections: RecordedConnection[] = [];

  /**
   * Set to make the next {@link FakeDiagramSessions.notifyGraphUpdated} reject, so a suite can prove
   * a transport failure after a successful write reaches the caller rather than being swallowed.
   */
  notifyError: Error | null = null;

  /**
   * Records a connection request and answers with a stand-in response.
   *
   * The response is neither a `101` nor does it carry a `webSocket`, and neither is a shortcut Node
   * permits avoiding: its `Response` constructor rejects any status below 200 outright, and nothing
   * outside the Workers runtime can produce a `WebSocket` to attach. A suite using this fake
   * therefore asserts which diagram and identity reached the port — the part the service decides —
   * while the protocol switch itself is covered against real `workerd` in
   * `../integration/live-sync.test.ts`.
   *
   * @param diagramId Diagram the service resolved and authorized.
   * @param _request Upgrade request, unused: this fake completes no protocol switch.
   * @param viewer Verified identity the service passed through.
   * @returns A stand-in response, whose status is deliberately not meaningful.
   */
  async connect(diagramId: string, _request: Request, viewer: string): Promise<Response> {
    this.connections.push({ diagramId, viewer });
    return new Response(null, { status: 200 });
  }

  /**
   * Records a push, or rejects when {@link FakeDiagramSessions.notifyError} is set.
   *
   * @param diagramId Diagram whose session was notified.
   * @param graphData Canonical graph JSON pushed.
   * @param updatedAt Timestamp pushed.
   * @returns A promise fulfilled once the call is recorded.
   * @throws {Error} The configured {@link FakeDiagramSessions.notifyError}, when one is set.
   */
  async notifyGraphUpdated(diagramId: string, graphData: string, updatedAt: string): Promise<void> {
    if (this.notifyError !== null) {
      throw this.notifyError;
    }
    this.notifications.push({ diagramId, graphData, updatedAt });
  }
}
