import { DurableObject } from "cloudflare:workers";

/**
 * One applied operation, recorded purely for test observability. Not part of the design being
 * spiked -- the real `DiagramSession` (docs/09C-COLLABORATIVE-EDITING.md, Phase 18) has no
 * equivalent log; this exists only so a test can independently determine, after the fact, which
 * of two concurrently-dispatched operations the Durable Object actually mutated `this.graph`
 * with *last* -- the ground truth a "deterministic winner" assertion needs, since two promises
 * settling in one order does not by itself prove which one's synchronous mutation ran second.
 */
export interface AppliedOperation {
  /** Id of the node this operation targeted. */
  nodeId: string;
  /** Value the operation wrote. */
  value: string;
  /** Monotonic counter, incremented synchronously inside {@link TestDiagramSession.applyOperation}
   * before any `await` -- see that method's own JSDoc for why this ordering is trustworthy. */
  sequence: number;
}

/**
 * A small, standalone Durable Object mirroring the *shape* of the real `DiagramSession`'s planned
 * write path (docs/09C-COLLABORATIVE-EDITING.md's "Why D1 Stays The Only Copy" section, Phase 18)
 * closely enough to exercise the same two platform guarantees, without any of that class's real
 * graph-mutation vocabulary, D1 binding, or WebSocket fan-out -- none of which this spike's three
 * questions need. `this.graph` plays the role of the real class's in-memory working copy; the
 * plain `persisted` field plays the role of D1, exactly as `docs/09C-COLLABORATIVE-EDITING.md`'s
 * own Phase 16 spike item 2 sanctions ("a fake/stub 'D1' -- a plain in-memory store is fine").
 *
 * Two write paths are exposed side by side, deliberately, so the spike's tests can contrast them:
 *
 * - {@link applyOperation} implements the real design: a single per-object write chain
 *   (`this.writeChain`) that every persist joins, where each link reads `this.graph` **at the
 *   moment it actually runs**, not a value captured when it was enqueued.
 * - {@link applyOperationUnchained} implements the naive alternative the real design's own prose
 *   argues against: each call persists its own captured snapshot independently, with no shared
 *   ordering. `tests/slow-write-ordering.test.ts` uses it as a counter-example -- proof the
 *   `applyOperation` design is actually load-bearing, not merely untested.
 */
export class TestDiagramSession extends DurableObject<Env> {
  /** In-memory working copy, keyed by node id -- a deliberately simplified stand-in for the real
   * `GraphData` shape (`demos/architect/src/worker/diagrams/types.ts`), sufficient for two
   * clients to target "the same node id" as Phase 16 item 2 asks. */
  graph: Record<string, string> = {};

  /** The one persist every {@link applyOperation} call joins, exactly mirroring the real design's
   * `this.writeChain = this.writeChain.then(() => saveGraphData(...))` shape. */
  writeChain: Promise<void> = Promise.resolve();

  /** Stand-in for D1's `graph_data` column as {@link applyOperation} left it -- the "real" outcome
   * this spike inspects after a test's concurrent calls settle. */
  persisted: Record<string, string> | null = null;

  /** Stand-in for D1 as {@link applyOperationUnchained} left it -- kept as a separate field so a
   * test can run both write paths in the same Durable Object instance without one clobbering the
   * other's evidence. */
  persistedUnchained: Record<string, string> | null = null;

  /** Monotonic counter backing {@link AppliedOperation.sequence}. */
  sequence = 0;

  /** Every operation {@link applyOperation} has synchronously applied to {@link graph} so far, in
   * the exact order its mutation actually ran -- see {@link AppliedOperation}. */
  appliedLog: AppliedOperation[] = [];

  /**
   * Apply one operation against `this.graph`, then persist through the shared write chain --
   * the real `DiagramSession.applyOperation()` design
   * (docs/09C-COLLABORATIVE-EDITING.md's "Why D1 Stays The Only Copy") reduced to its two
   * load-bearing steps:
   *
   * 1. **Mutate `this.graph` synchronously, no `await` anywhere in this step.** This is what
   *    Phase 16 item 1 re-verifies: with no `await` between reading and replacing `this.graph`,
   *    no concurrently-dispatched call to this same method can possibly interleave its own
   *    mutation in the middle, by ordinary single-threaded JavaScript semantics. The
   *    {@link sequence} counter is incremented in this same synchronous step, so its final value
   *    for a given call is trustworthy evidence of exactly where that call's mutation landed
   *    relative to every other call's, independent of which call's returned `Promise` happens to
   *    settle first.
   * 2. **Join the shared write chain, awaiting this call's own turn.** `this.writeChain`'s new
   *    `.then()` link is registered before the `await`, guaranteeing every call's persist runs in
   *    the order its call was made -- but the link's callback reads `this.graph` **at the moment
   *    it actually runs**, not a value closed over when it was registered, so a link that ends up
   *    waiting behind a slower, earlier link still persists whatever is truly current by the time
   *    its turn comes up. `tests/slow-write-ordering.test.ts` is the test that this fresh-read
   *    property is what actually matters for.
   *
   * @param nodeId Id of the node this operation targets.
   * @param value New value to write.
   * @param persistDelayMs Artificial delay, in milliseconds, injected into this call's own link in
   * the write chain, before it reads `this.graph` and persists -- exists purely so a test can make
   * one call's persist slower than another's without needing a real, variable-latency D1 write to
   * provoke the race (Phase 16 item 3).
   * @returns The {@link AppliedOperation.sequence} value this call's mutation was assigned, so a
   * test can independently confirm which of several concurrent calls actually ran last.
   */
  applyOperation(
    nodeId: string,
    value: string,
    persistDelayMs = 0,
  ): Promise<number> {
    this.sequence += 1;
    const sequence = this.sequence;
    this.graph = { ...this.graph, [nodeId]: value };
    this.appliedLog = [...this.appliedLog, { nodeId, sequence, value }];

    this.writeChain = this.writeChain.then(async () => {
      if (persistDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, persistDelayMs));
      }
      // Fresh read, not a captured snapshot -- see this method's own JSDoc step 2.
      this.persisted = { ...this.graph };
    });

    return this.writeChain.then(() => sequence);
  }

  /**
   * The naive alternative {@link applyOperation}'s own JSDoc argues against: mutate `this.graph`
   * synchronously (same guarantee as step 1 above), then persist a snapshot captured **at the
   * moment this call was made**, with no shared ordering against any other call's persist.
   * `tests/slow-write-ordering.test.ts` uses this to demonstrate the exact clobber bug
   * {@link applyOperation}'s write chain exists to prevent -- a slower call's stale snapshot can
   * land in {@link persistedUnchained} after a faster, later call's correct one already did.
   *
   * @param nodeId Id of the node this operation targets.
   * @param value New value to write.
   * @param persistDelayMs Artificial delay before this call's own, independent persist runs.
   * @returns A promise that resolves once this call's own persist has landed in
   * {@link persistedUnchained} -- deliberately not chained to any other call's.
   */
  async applyOperationUnchained(
    nodeId: string,
    value: string,
    persistDelayMs = 0,
  ): Promise<void> {
    this.graph = { ...this.graph, [nodeId]: value };
    // Captured now, not read fresh when the persist below actually runs -- the bug this method
    // exists to demonstrate.
    const snapshot = { ...this.graph };
    if (persistDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, persistDelayMs));
    }
    this.persistedUnchained = snapshot;
  }

  /** @returns The current in-memory working copy. */
  getGraph(): Record<string, string> {
    return this.graph;
  }

  /** @returns The "D1" stub's current value as {@link applyOperation} left it, or `null` if no
   * call has completed a persist yet. */
  getPersisted(): Record<string, string> | null {
    return this.persisted;
  }

  /** @returns The "D1" stub's current value as {@link applyOperationUnchained} left it, or `null`
   * if no call has completed a persist yet. */
  getPersistedUnchained(): Record<string, string> | null {
    return this.persistedUnchained;
  }

  /** @returns Every operation {@link applyOperation} has applied so far, in true application
   * order -- see {@link appliedLog}. */
  getAppliedLog(): AppliedOperation[] {
    return this.appliedLog;
  }
}
