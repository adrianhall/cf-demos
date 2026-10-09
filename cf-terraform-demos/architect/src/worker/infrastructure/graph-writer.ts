import type { DiagramRepository } from '../application/ports/diagram-repository.ts';
import type {
  GraphWriteOutcome,
  RejectedGraphWrite
} from '../application/ports/diagram-session.ts';
import { WriteQueue } from './write-queue.ts';

/**
 * @file The serialized persistence half of a live session: the ordered queue every graph write
 *   passes through, and the conversion of a failure into the refusal a caller is given. It is
 *   separate from `./diagram-session.ts` because the two halves fail in completely different ways
 *   and are worth being able to reason about — and test — apart. The session owns the working
 *   graph, the sockets and hydration, none of which can be exercised outside the Workers runtime.
 *   What is written here owns ordering and error recovery, which are exactly the two properties the
 *   Phase 16 spike found were easy to get wrong, and which this module makes testable in plain Node
 *   against a fake repository — including the storage-failure path, which has no way to be provoked
 *   through a real D1.
 */

/**
 * Converts a caught value into the refusal a caller should be given.
 *
 * Every domain refusal in this application is a `ProblemDetailsError`, but this function matches on
 * the _shape_ rather than importing the class, and that is deliberate. These refusals are produced
 * inside a Durable Object and read by callers on the other side of an RPC boundary; matching
 * structurally keeps the conversion working for a value that has crossed one.
 *
 * Anything unrecognised becomes a `500` carrying a fixed, user-safe message. A storage failure's
 * own message can name a table, a column or a query, and none of that belongs in a response.
 *
 * @param error Value thrown by a mutation, a canonicalisation or a repository write.
 * @returns The refusal to hand back. Never throws, which is the point: an uncaught exception in a
 *   Durable Object discards its in-memory state and can reset the instance, so an ordinary
 *   concurrent-editing outcome must never be expressed as one.
 */
export function toRejection(error: unknown): RejectedGraphWrite {
  const problem = (error as { problemDetails?: { status?: unknown; detail?: unknown } })
    ?.problemDetails;

  if (typeof problem?.status === 'number' && typeof problem.detail === 'string') {
    return { detail: problem.detail, outcome: 'rejected', status: problem.status };
  }

  return { detail: 'The change could not be saved.', outcome: 'rejected', status: 500 };
}

/**
 * Persists one diagram's graph, strictly in the order the writes were applied.
 *
 * One instance per live session. It holds no graph of its own: the session owns the working copy,
 * and this writer is handed a **reader** for it rather than a value, which is what gives the
 * freshness property described on {@link SerializedGraphWriter.write}.
 */
export class SerializedGraphWriter {
  /**
   * The ordered queue. See `./write-queue.ts` for what its ordering does and does not guarantee.
   */
  private readonly queue = new WriteQueue();

  /**
   * @param repository Diagram persistence. A port rather than a D1 binding, so the write this class
   *   performs is "replace this diagram's graph" rather than "run this SQL" — and so its failure
   *   handling can be exercised against a repository that fails on demand.
   * @param diagramId Id of the one diagram this writer writes. Fixed at construction, so no caller
   *   can direct a write at a different row.
   */
  constructor(
    private readonly repository: DiagramRepository,
    private readonly diagramId: string
  ) {}

  /**
   * Queues one write, and reports what reached storage.
   *
   * The graph is supplied as a **reader** rather than a value, and that is the second of the two
   * properties the spike separated. Ordering makes the final persisted value last-applied-wins;
   * reading when the turn arrives stops a write that has been waiting from storing a graph that has
   * since been superseded. It is an intermediate-freshness optimisation and not an atomicity
   * guarantee: a write already in flight cannot be retroactively changed, so storage may
   * transiently hold an older graph before the queue drains.
   *
   * @param readGraph Produces the canonical graph JSON to store, called when this write's turn
   *   arrives rather than now.
   * @param sequence Order the change was applied in, reported back unchanged.
   * @returns What was persisted, or a refusal — `404` when the row has gone, `500` when the write
   *   failed. A failure is returned rather than thrown, and the queue stays usable afterwards.
   */
  async write(readGraph: () => string, sequence: number): Promise<GraphWriteOutcome> {
    try {
      return await this.queue.run(async (): Promise<GraphWriteOutcome> => {
        const graphData = readGraph();

        const updatedAt = await this.repository.replaceGraph(this.diagramId, graphData);
        if (updatedAt === null) {
          // The row has gone — a concurrent delete. Nothing was persisted, so there is nothing to
          // announce either.
          return { detail: 'Diagram not found.', outcome: 'rejected', status: 404 };
        }

        return { graphData, outcome: 'applied', sequence, updatedAt };
      });
    } catch (error) {
      return toRejection(error);
    }
  }
}
