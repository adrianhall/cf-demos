/**
 * @file The ordered write queue a {@link DiagramSession} persists through. It is a dozen lines, and
 *   it is extracted into its own module for two reasons that are both about being able to see it.
 *   The first is that the property it provides is easy to state and easy to lose. Without it, a
 *   slow earlier write finishes **after** a faster later one and silently restores the older graph
 *   — the lost update this whole phase exists to remove. The Phase 16 spike reproduced exactly
 *   that, and `tests/worker/write-queue.test.ts` keeps the counter-example: the same scenario run
 *   with and without the queue, so the test fails against an unqueued implementation rather than
 *   passing against anything. The second is the failure mode the spike found underneath it.
 *   Chaining onto a promise that rejects makes every later link reject with that same earlier
 *   failure, so one transient storage error disables the session's write path until the object is
 *   evicted. Keeping the recovery in one named place, with a test for it, is what stops that
 *   reappearing the next time somebody edits the session. It is in `infrastructure/` rather than
 *   `domain/` because it exists to order **I/O**: it has no opinion about graphs, and the session
 *   is the only thing that uses it.
 */

/**
 * Runs asynchronous tasks strictly one after another, and keeps running after one fails.
 *
 * Each task starts only once the previous task has settled — fulfilled _or_ rejected. That is the
 * ordering guarantee: a write that takes 50ms cannot overtake, or be overtaken by, one submitted
 * after it.
 *
 * What it guarantees is the **final** state, which is worth being precise about because the source
 * design for this feature overstated it. Submitting B after A does not retroactively change A: A
 * still runs, and an observer watching storage while the queue drains can see A's value before B's.
 * What cannot happen is A landing last. For a whole-graph write that is exactly the guarantee
 * needed — each write carries the complete graph, so the last one to land is the one that counts.
 *
 * One instance per Durable Object instance. Ordering is only meaningful within the single-threaded
 * object that owns the state being written, and a queue shared between diagrams would make
 * unrelated writes wait for each other.
 */
export class WriteQueue {
  /**
   * The tail of the queue: a promise that settles when the most recently submitted task has
   * finished.
   *
   * Always **caught**, never the raw task promise. Assigning the raw one is the poisoning the file
   * comment describes — every later `.then()` would reject with the earlier task's failure, and the
   * queue would be permanently broken rather than transiently.
   */
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Submits a task, to run once every task submitted before it has settled.
   *
   * @typeParam T Value the task produces.
   * @param task Work to run when this queue position is reached. It is invoked at that moment, not
   *   now, which is what lets it read state that later changed: a task reading a working value when
   *   it begins writes the newest one rather than a snapshot captured at submission.
   * @returns What the task produced.
   * @throws {Error} Whatever the task threw, propagated to **this** caller alone. A later task is
   *   unaffected and still runs.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    const turn = this.tail.then(task);

    // The tail swallows the failure; the caller below still receives it. Both halves matter: the
    // first keeps the queue usable, the second keeps the failure from being silent.
    this.tail = turn.catch(() => undefined);

    return turn;
  }
}
