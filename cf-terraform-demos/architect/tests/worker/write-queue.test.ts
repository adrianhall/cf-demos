import { describe, expect, it } from 'vitest';
import { WriteQueue } from '../../src/worker/infrastructure/write-queue.ts';

/**
 * @file Covers the ordering guarantee every graph write depends on, and — more importantly — covers
 *   it with a test that can **fail**. The scenario below is the one the Phase 16 spike reproduced:
 *   a slow write submitted first and a fast write submitted immediately after. Run without a queue,
 *   the slow one finishes last and silently restores the older value, which is a lost update that
 *   no amount of care at the call site prevents. Run through the queue, it cannot. The
 *   counter-example is run explicitly, in the same test, rather than being described in a comment.
 *   A test that only exercised the queue would pass just as happily against an implementation that
 *   did nothing at all, which is precisely the kind of green test this project has been caught by
 *   before — so the unqueued arrangement is executed and asserted to produce the wrong answer, and
 *   the queued one the right answer.
 */

/**
 * A stand-in for D1: it records each value written, in the order the writes actually completed.
 */
interface Store {
  /**
   * Every value written, in completion order. The last entry is what the store ends up holding.
   */
  readonly written: string[];
  /**
   * Writes a value after a delay, standing in for a storage round trip of a given speed.
   *
   * @param value Value to write.
   * @param delayMs How long the write takes.
   * @returns A promise fulfilled once the value has been recorded.
   */
  write(value: string, delayMs: number): Promise<void>;
}

/**
 * Builds a fresh store.
 *
 * @returns A store with nothing written yet.
 */
function createStore(): Store {
  const written: string[] = [];
  return {
    async write(value, delayMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      written.push(value);
    },
    written
  };
}

describe('WriteQueue', () => {
  // The whole reason this class exists. Both arrangements are run so the assertion has something
  // to discriminate against: if the queue were removed, the second half of this test would start
  // producing the same wrong answer as the first.
  it('stops a slow earlier write landing after a fast later one, which is what an unqueued write does', async () => {
    const unqueued = createStore();
    await Promise.all([unqueued.write('first', 50), unqueued.write('second', 0)]);

    // The counter-example: 'first' was submitted first and landed last, so the store now holds a
    // value that was already superseded before it was written.
    expect(unqueued.written).toEqual(['second', 'first']);
    expect(unqueued.written.at(-1)).toBe('first');

    const queued = createStore();
    const queue = new WriteQueue();
    await Promise.all([
      queue.run(async () => queued.write('first', 50)),
      queue.run(async () => queued.write('second', 0))
    ]);

    expect(queued.written).toEqual(['first', 'second']);
    expect(queued.written.at(-1)).toBe('second');
  });

  // A task reads when it runs, not when it was submitted. That is what lets a queued graph write
  // store the newest working graph rather than one captured while it was waiting — the
  // intermediate-freshness property the spike separated from the ordering one.
  it('runs a task when its turn arrives, so it reads state that changed while it waited', async () => {
    const queue = new WriteQueue();
    const seen: string[] = [];
    let current = 'a';

    const first = queue.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      seen.push(current);
    });
    const second = queue.run(async () => {
      seen.push(current);
    });
    current = 'c';

    await Promise.all([first, second]);

    // Both tasks read 'c': the first because it had not finished when the value changed, the
    // second because it had not started. Neither captured 'a' at submission time.
    expect(seen).toEqual(['c', 'c']);
  });

  it('gives each caller its own task’s result', async () => {
    const queue = new WriteQueue();

    const results = await Promise.all([queue.run(async () => 1), queue.run(async () => 2)]);

    expect(results).toEqual([1, 2]);
  });

  // The failure the spike found underneath the ordering one. Chaining onto a rejected promise
  // makes every later link reject with that same earlier failure — so one transient storage error
  // would disable a session's write path entirely until the object was evicted.
  it('keeps running after a task fails, rather than poisoning every write after it', async () => {
    const queue = new WriteQueue();

    await expect(
      queue.run(async () => {
        throw new Error('storage unavailable');
      })
    ).rejects.toThrow('storage unavailable');

    await expect(queue.run(async () => 'recovered')).resolves.toBe('recovered');
  });

  // The failure must reach the caller who caused it and nobody else. Swallowing it to keep the
  // queue alive would be the opposite error: a write that silently did not happen.
  it('reports a failure only to its own caller, while a concurrent task still succeeds', async () => {
    const queue = new WriteQueue();

    const failing = queue.run(async () => {
      throw new Error('storage unavailable');
    });
    const following = queue.run(async () => 'ok');

    await expect(failing).rejects.toThrow('storage unavailable');
    await expect(following).resolves.toBe('ok');
  });

  it('still orders the tasks either side of a failed one', async () => {
    const store = createStore();
    const queue = new WriteQueue();

    const all = [
      queue.run(async () => store.write('first', 30)),
      queue
        .run(async () => {
          throw new Error('storage unavailable');
        })
        .catch(() => undefined),
      queue.run(async () => store.write('third', 0))
    ];
    await Promise.all(all);

    expect(store.written).toEqual(['first', 'third']);
  });
});
