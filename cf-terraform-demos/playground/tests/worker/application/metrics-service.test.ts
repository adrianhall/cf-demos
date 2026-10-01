import { beforeEach, describe, expect, it } from 'vitest';
import { MetricsService } from '../../../src/worker/application/metrics/metrics-service';
import type { RunRecord } from '../../../src/worker/application/ports/run-repository-port';
import { COST_RESOLUTION_BUDGET_MS } from '../../../src/worker/domain/metrics';
import {
  clearRunRecords,
  createMemoryRunRepository
} from '../../../src/worker/infrastructure/runs/memory-run-repository';
import { FakeInference } from '../support/fake-inference';
import { problemWithStatus } from '../support/problem-details';

/**
 * Alice's verified identity.
 */
const ALICE = { email: 'alice@example.com', sub: 'sub-alice' };

/**
 * Bob's verified identity, used to prove one user cannot read another's run.
 */
const BOB = { email: 'bob@example.com', sub: 'sub-bob' };

/**
 * Run identifier used throughout.
 */
const RUN_ID = 'aaaaaaaa-1111-4222-8333-444455556666';

/**
 * Builds a stored run record.
 *
 * @param overrides Fields to replace on the default record.
 * @returns A record ready to save.
 */
function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: RUN_ID,
    task: 'chat',
    model: '@cf/meta/llama-3.2-3b-instruct',
    ownerEmail: ALICE.email,
    logIds: ['log-1'],
    status: 'completed',
    startedAtMs: 1_000,
    ...overrides
  };
}

/**
 * A resolved gateway log.
 *
 * @param logId Identifier the log reports.
 * @param costUsd Cost the gateway reported, or `undefined` for a log carrying none.
 * @returns A metric for the fake's metrics map.
 */
function metric(logId: string, costUsd: number | undefined = 0.000_25) {
  return {
    logId,
    model: '@cf/meta/llama-3.2-3b-instruct',
    provider: 'workers-ai',
    cached: false,
    success: true,
    durationMs: 300,
    ...(costUsd === undefined ? {} : { costUsd }),
    tokensIn: 10,
    tokensOut: 20
  };
}

beforeEach(() => {
  clearRunRecords();
});

describe('MetricsService.readRunMetrics', () => {
  it('returns an available cost once the log has resolved', async () => {
    const runs = createMemoryRunRepository(() => 1_000);
    await runs.save(record());
    const service = new MetricsService({
      inference: new FakeInference({ metrics: { 'log-1': metric('log-1') } }),
      runs,
      now: () => 1_500
    });

    const metrics = await service.readRunMetrics(RUN_ID, ALICE);
    expect(metrics.costStatus).toBe('available');
    expect(metrics.totalCostUsd).toBe(0.000_25);
  });

  it('returns pending with a retry hint while the log has not propagated', async () => {
    const runs = createMemoryRunRepository(() => 1_000);
    await runs.save(record());
    const service = new MetricsService({
      inference: new FakeInference(),
      runs,
      now: () => 1_500
    });

    const metrics = await service.readRunMetrics(RUN_ID, ALICE);
    expect(metrics.costStatus).toBe('pending');
    expect(metrics.retryAfterMs).toBeGreaterThan(0);
  });

  it('returns unavailable once the resolution budget has expired', async () => {
    const runs = createMemoryRunRepository(() => 1_000);
    await runs.save(record());
    const service = new MetricsService({
      inference: new FakeInference(),
      runs,
      now: () => 1_000 + COST_RESOLUTION_BUDGET_MS
    });

    expect((await service.readRunMetrics(RUN_ID, ALICE)).costStatus).toBe('unavailable');
  });

  it('resolves every log of a multi-call run', async () => {
    const runs = createMemoryRunRepository(() => 1_000);
    await runs.save(record({ logIds: ['log-1', 'log-2'] }));
    const inference = new FakeInference({
      metrics: { 'log-1': metric('log-1', 0.001), 'log-2': metric('log-2', 0.002) }
    });
    const service = new MetricsService({ inference, runs, now: () => 1_500 });

    const metrics = await service.readRunMetrics(RUN_ID, ALICE);
    expect(inference.metricLookups).toEqual(['log-1', 'log-2']);
    expect(metrics.totalCostUsd).toBeCloseTo(0.003, 10);
  });

  // The ownership rule, which is the one that matters: a run identifier is guessable, so the check
  // is against the verified identity rather than against possession of the identifier.
  it('refuses to return another identity\u2019s run', async () => {
    const runs = createMemoryRunRepository(() => 1_000);
    await runs.save(record());
    const service = new MetricsService({
      inference: new FakeInference({ metrics: { 'log-1': metric('log-1') } }),
      runs,
      now: () => 1_500
    });

    await expect(service.readRunMetrics(RUN_ID, BOB)).rejects.toMatchObject(problemWithStatus(403));
  });

  // A denial rather than an empty result. An empty document would be indistinguishable from a run
  // with no logs, hiding the fact that one identity asked for another's data.
  it('denies rather than returning an empty result for another identity', async () => {
    const runs = createMemoryRunRepository(() => 1_000);
    await runs.save(record());
    const service = new MetricsService({ inference: new FakeInference(), runs, now: () => 1_500 });

    const error = await service.readRunMetrics(RUN_ID, BOB).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
  });

  it('does not read any gateway log when the caller does not own the run', async () => {
    const runs = createMemoryRunRepository(() => 1_000);
    await runs.save(record());
    const inference = new FakeInference({ metrics: { 'log-1': metric('log-1') } });
    const service = new MetricsService({ inference, runs, now: () => 1_500 });

    await service.readRunMetrics(RUN_ID, BOB).catch(() => undefined);
    expect(inference.metricLookups).toEqual([]);
  });

  it('reports an unknown run as not found', async () => {
    const service = new MetricsService({
      inference: new FakeInference(),
      runs: createMemoryRunRepository(),
      now: () => 1_500
    });

    await expect(service.readRunMetrics(RUN_ID, ALICE)).rejects.toMatchObject(
      problemWithStatus(404)
    );
  });

  it('reports a run with no gateway log as unavailable', async () => {
    const runs = createMemoryRunRepository(() => 1_000);
    await runs.save(record({ logIds: [] }));
    const service = new MetricsService({ inference: new FakeInference(), runs, now: () => 1_100 });

    expect((await service.readRunMetrics(RUN_ID, ALICE)).costStatus).toBe('unavailable');
  });

  it('stays pending when only some of a run\u2019s logs have resolved', async () => {
    const runs = createMemoryRunRepository(() => 1_000);
    await runs.save(record({ logIds: ['log-1', 'log-2'] }));
    const service = new MetricsService({
      inference: new FakeInference({ metrics: { 'log-1': metric('log-1') } }),
      runs,
      now: () => 1_500
    });

    const metrics = await service.readRunMetrics(RUN_ID, ALICE);
    expect(metrics.costStatus).toBe('pending');
    expect(metrics.requests).toHaveLength(1);
  });

  it('reports a cache hit in the resolved requests', async () => {
    const runs = createMemoryRunRepository(() => 1_000);
    await runs.save(record());
    const service = new MetricsService({
      inference: new FakeInference({
        metrics: { 'log-1': { ...metric('log-1'), cached: true } }
      }),
      runs,
      now: () => 1_500
    });

    expect((await service.readRunMetrics(RUN_ID, ALICE)).requests[0]?.cached).toBe(true);
  });
});
