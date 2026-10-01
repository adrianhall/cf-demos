/**
 * @file In-memory implementation of {@link RunRepositoryPort}. In-memory is a deliberate design
 *   choice here, not a stopgap. A run record exists only to authorise and resolve a metrics lookup
 *   in the few seconds between an answer and its gateway log propagating; a Worker isolate
 *   comfortably outlives that. Introducing KV or D1 for it would add a storage product, a Terraform
 *   resource, a teardown step, and a retention policy — all to hold data that is worthless within a
 *   minute. The trade-off is real and the UI already handles it: when an isolate is recycled
 *   between the answer and the poll, the metrics request answers `404` and the browser shows the
 *   cost as unavailable rather than inventing a figure. That is the same truthful outcome as a
 *   gateway log that never arrived. The map is module-scoped rather than per-instance so a record
 *   survives being written by one request and read by the next within the same isolate — which is
 *   the entire point of storing it.
 */

import type { RunRecord, RunRepositoryPort } from '../../application/ports/run-repository-port';

/**
 * How long a run record is retained.
 *
 * Comfortably longer than the cost-resolution budget, so a record is never evicted while the UI is
 * still legitimately polling for it, and short enough that the map cannot grow without bound in a
 * long-lived isolate.
 */
export const RUN_RETENTION_MS = 300_000;

/**
 * Most records kept at once.
 *
 * A second bound alongside the time-based one, because an isolate serving a busy demo could
 * accumulate records faster than they expire. Eviction is oldest-first.
 */
export const MAX_RETAINED_RUNS = 500;

/**
 * Run records for the current isolate, keyed by run identifier.
 *
 * A `Map` preserves insertion order, which is what makes oldest-first eviction a single `keys()`
 * walk rather than a sort by timestamp.
 */
const records = new Map<string, RunRecord>();

/**
 * Removes expired and excess records.
 *
 * Called on write rather than on a timer: a Worker has no reliable background scheduler, and a run
 * repository with no writes is one whose size cannot be growing.
 *
 * @param nowMs Current epoch milliseconds.
 * @returns Nothing; expired and excess entries have been deleted.
 */
function evict(nowMs: number): void {
  for (const [runId, record] of records) {
    if (nowMs - record.startedAtMs > RUN_RETENTION_MS) {
      records.delete(runId);
    }
  }

  while (records.size > MAX_RETAINED_RUNS) {
    const oldest = records.keys().next();
    if (oldest.done === true) {
      break;
    }
    records.delete(oldest.value);
  }
}

/**
 * Discards every stored run record.
 *
 * Exported for tests: the store is module-scoped so it would otherwise leak between test cases, and
 * a suite that depended on the leak would pass for the wrong reason.
 *
 * @returns Nothing; the store is empty.
 */
export function clearRunRecords(): void {
  records.clear();
}

/**
 * Creates a run repository backed by the isolate's memory.
 *
 * @param now Clock reading epoch milliseconds, injected so retention and eviction can be tested
 *   without waiting. Defaults to `Date.now`.
 * @returns A {@link RunRepositoryPort} over the module-scoped store.
 */
export function createMemoryRunRepository(now: () => number = Date.now): RunRepositoryPort {
  return {
    /**
     * Stores a run record, evicting expired and excess entries first.
     *
     * @param record The run to remember.
     * @returns A promise fulfilled once the record is retrievable.
     */
    async save(record: RunRecord): Promise<void> {
      records.set(record.runId, record);
      // Evicted after insertion rather than before, so the size bound holds for the store as it
      // now stands. Evicting first would let the store settle one record above its own limit.
      evict(now());
    },

    /**
     * Retrieves a run record without applying any ownership check.
     *
     * Ownership is the caller's responsibility by design; see {@link RunRepositoryPort.find}.
     *
     * @param runId Run identifier from an untrusted request.
     * @returns The record, or `undefined` when it is unknown or has expired.
     */
    async find(runId: string): Promise<RunRecord | undefined> {
      const record = records.get(runId);
      if (record === undefined) {
        return undefined;
      }

      // An expired record is reported as absent rather than returned, so a lookup cannot resolve a
      // record that `save` would already have evicted.
      if (now() - record.startedAtMs > RUN_RETENTION_MS) {
        records.delete(runId);
        return undefined;
      }

      return record;
    }
  };
}
