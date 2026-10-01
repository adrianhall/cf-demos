import { beforeEach, describe, expect, it } from 'vitest';
import type { RunRecord } from '../../../src/worker/application/ports/run-repository-port';
import {
  clearRunRecords,
  createMemoryRunRepository,
  MAX_RETAINED_RUNS,
  RUN_RETENTION_MS
} from '../../../src/worker/infrastructure/runs/memory-run-repository';

/**
 * Builds a run record.
 *
 * @param runId Identifier for the record.
 * @param startedAtMs When the run started, in epoch milliseconds.
 * @returns A record ready to save.
 */
function record(runId: string, startedAtMs = 1_000): RunRecord {
  return {
    runId,
    task: 'chat',
    model: '@cf/meta/llama-3.2-3b-instruct',
    ownerEmail: 'alice@example.com',
    logIds: ['log-1'],
    status: 'completed',
    startedAtMs
  };
}

beforeEach(() => {
  clearRunRecords();
});

describe('createMemoryRunRepository', () => {
  it('stores and retrieves a run', async () => {
    const runs = createMemoryRunRepository(() => 1_000);
    await runs.save(record('run-1'));
    expect((await runs.find('run-1'))?.ownerEmail).toBe('alice@example.com');
  });

  it('reports an unknown run as undefined', async () => {
    const runs = createMemoryRunRepository(() => 1_000);
    expect(await runs.find('never-stored')).toBeUndefined();
  });

  // The store is module-scoped on purpose: a record written while serving one request has to be
  // readable while serving the next, which is the entire reason it exists.
  it('shares records between repository instances in the same isolate', async () => {
    await createMemoryRunRepository(() => 1_000).save(record('run-1'));
    expect(await createMemoryRunRepository(() => 1_000).find('run-1')).toBeDefined();
  });

  // Ownership is deliberately not applied here. A route that forgot to check would otherwise get a
  // silent empty result that looks like "no such run", hiding the bug.
  it('returns a record regardless of who owns it', async () => {
    const runs = createMemoryRunRepository(() => 1_000);
    await runs.save(record('run-1'));
    expect((await runs.find('run-1'))?.ownerEmail).toBe('alice@example.com');
  });

  it('treats an expired record as absent', async () => {
    let clock = 1_000;
    const runs = createMemoryRunRepository(() => clock);
    await runs.save(record('run-1', 1_000));

    clock = 1_000 + RUN_RETENTION_MS + 1;
    expect(await runs.find('run-1')).toBeUndefined();
  });

  it('retains a record right up to its expiry', async () => {
    let clock = 1_000;
    const runs = createMemoryRunRepository(() => clock);
    await runs.save(record('run-1', 1_000));

    clock = 1_000 + RUN_RETENTION_MS;
    expect(await runs.find('run-1')).toBeDefined();
  });

  it('evicts expired records when a new one is saved', async () => {
    let clock = 1_000;
    const runs = createMemoryRunRepository(() => clock);
    await runs.save(record('old', 1_000));

    clock = 1_000 + RUN_RETENTION_MS + 1;
    await runs.save(record('new', clock));

    expect(await runs.find('old')).toBeUndefined();
    expect(await runs.find('new')).toBeDefined();
  });

  // A second bound alongside the time-based one, because a busy isolate could accumulate records
  // faster than they expire.
  it('bounds the store and evicts the oldest records first', async () => {
    const runs = createMemoryRunRepository(() => 1_000);
    for (let index = 0; index <= MAX_RETAINED_RUNS; index += 1) {
      await runs.save(record(`run-${index}`, 1_000));
    }

    expect(await runs.find('run-0')).toBeUndefined();
    expect(await runs.find(`run-${MAX_RETAINED_RUNS}`)).toBeDefined();
  });

  it('overwrites a record saved twice under the same identifier', async () => {
    const runs = createMemoryRunRepository(() => 1_000);
    await runs.save(record('run-1'));
    await runs.save({ ...record('run-1'), ownerEmail: 'bob@example.com' });

    expect((await runs.find('run-1'))?.ownerEmail).toBe('bob@example.com');
  });

  it('stores the gateway log identifiers needed for a metrics lookup', async () => {
    const runs = createMemoryRunRepository(() => 1_000);
    await runs.save({ ...record('run-1'), logIds: ['a', 'b'] });
    expect((await runs.find('run-1'))?.logIds).toEqual(['a', 'b']);
  });
});
