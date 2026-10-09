import type {
  DiagramSessionPort,
  GraphWriteOutcome,
  RejectedGraphWrite
} from '../../src/worker/application/ports/diagram-session.ts';
import {
  applyGraphOperation,
  type GraphOperation
} from '../../src/worker/domain/graph-operations.ts';
import { canonicalizeGraphData, type GraphData } from '../../src/worker/domain/graph.ts';
import type { FakeDiagramRepository } from './fake-diagram-repository.ts';

/**
 * @file An in-memory {@link DiagramSessionPort}, shared by every service and tool suite that
 *   exercises a graph write. It exists because the port does: the application tier depends on an
 *   interface rather than on a Durable Object namespace, so a whole use case can be asserted in
 *   plain Node with no Workers runtime. **What this fake does and does not stand in for.** Since
 *   the write path moved into the session, a fake that merely recorded calls would let the service
 *   suites pass against a service that never persisted anything, so this one genuinely applies each
 *   operation and writes it to the supplied repository. What it deliberately does **not** simulate
 *   is the part that makes the real object correct — the input gate, the ordered write chain,
 *   hibernation and the fan-out to real sockets. None of those has a meaningful fake: they are
 *   properties of the runtime, not of this interface, and pretending otherwise would produce a
 *   suite that proved serialization against an implementation that has none. They are covered
 *   against real `workerd` in `../integration/live-sync.test.ts`.
 */

/**
 * One recorded broadcast.
 */
export interface RecordedNotification {
  /**
   * Diagram whose session fanned the change out.
   */
  diagramId: string;
  /**
   * Canonical graph JSON that was pushed.
   */
  graphData: string;
  /**
   * Timestamp that was pushed.
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
 * In-memory {@link DiagramSessionPort} that applies writes for real and records what it did.
 *
 * It takes no authorization decision, deliberately: the point of a suite using it is to prove the
 * _service_ refused, so a fake that second-guessed the rule would make those assertions
 * meaningless.
 */
export class FakeDiagramSessions implements DiagramSessionPort {
  /**
   * Every broadcast this fake performed, in order.
   *
   * A whole-graph replace records nothing, exactly as the real session broadcasts nothing for one:
   * a tab's own autosave is not news to anybody in this sub-phase.
   */
  readonly notifications: RecordedNotification[] = [];

  /**
   * Every connection this fake was asked to open, in order.
   */
  readonly connections: RecordedConnection[] = [];

  /**
   * Set to make the next write fail its persist, so a suite can prove a storage failure reaches the
   * caller as the status the port promises rather than being swallowed or reported as a success.
   */
  persistError: Error | null = null;

  /**
   * How many writes this fake has applied, mirroring the real session's session-scoped counter.
   */
  private sequence = 0;

  /**
   * @param diagrams Diagram store this session reads and writes, standing in for D1. The same store
   *   the service under test uses, so a test can observe that a write the service requested
   *   genuinely landed rather than only that it was asked for.
   */
  constructor(private readonly diagrams: FakeDiagramRepository) {}

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
   * Applies one operation, persists it, and records the broadcast.
   *
   * @param diagramId Diagram to change.
   * @param operation Operation to apply.
   * @returns What was persisted, or the refusal the real session would return.
   */
  async applyOperation(diagramId: string, operation: GraphOperation): Promise<GraphWriteOutcome> {
    const current = await this.diagrams.find(diagramId);
    if (current === null) {
      return notFoundOutcome();
    }

    let graphData: string;
    try {
      graphData = canonicalizeGraphData(
        applyGraphOperation(JSON.parse(current.graphData) as GraphData, operation)
      );
    } catch (error) {
      return rejectionFrom(error);
    }

    const written = await this.persist(diagramId, graphData);
    if (written.outcome === 'applied') {
      this.notifications.push({ diagramId, graphData, updatedAt: written.updatedAt });
    }
    return written;
  }

  /**
   * Replaces a whole graph and persists it, broadcasting nothing.
   *
   * @param diagramId Diagram to change.
   * @param graphData Canonical graph JSON.
   * @returns What was persisted, or the refusal the real session would return.
   */
  async replaceGraph(diagramId: string, graphData: string): Promise<GraphWriteOutcome> {
    return this.persist(diagramId, graphData);
  }

  /**
   * Writes a graph, honouring a configured failure.
   *
   * @param diagramId Diagram to write to.
   * @param graphData Canonical graph JSON.
   * @returns The applied write, or the refusal describing why nothing was stored.
   */
  private async persist(diagramId: string, graphData: string): Promise<GraphWriteOutcome> {
    if (this.persistError !== null) {
      // Converted to a refusal rather than thrown, exactly as the real session does: an uncaught
      // throw there would discard the object's working graph as well as answering the caller.
      return rejectionFrom(this.persistError);
    }

    const updatedAt = await this.diagrams.replaceGraph(diagramId, graphData);
    if (updatedAt === null) {
      return notFoundOutcome();
    }

    this.sequence += 1;
    return { graphData, outcome: 'applied', sequence: this.sequence, updatedAt };
  }
}

/**
 * The refusal for a diagram that is not there.
 *
 * @returns A `404` refusal with the same detail every other not-found answer uses.
 */
function notFoundOutcome(): RejectedGraphWrite {
  return { detail: 'Diagram not found.', outcome: 'rejected', status: 404 };
}

/**
 * Converts a thrown value into a refusal, mirroring the real session's conversion.
 *
 * @param error Value thrown by a mutation, a canonicalisation or a write.
 * @returns The refusal to report. An unrecognised error becomes a `500` with a fixed message, so a
 *   storage error's own text cannot reach a caller.
 */
function rejectionFrom(error: unknown): RejectedGraphWrite {
  const problem = (error as { problemDetails?: { status?: unknown; detail?: unknown } })
    ?.problemDetails;

  return typeof problem?.status === 'number' && typeof problem.detail === 'string'
    ? { detail: problem.detail, outcome: 'rejected', status: problem.status }
    : { detail: 'The change could not be saved.', outcome: 'rejected', status: 500 };
}
