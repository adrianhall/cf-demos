import { beforeEach, describe, expect, it } from 'vitest';
import { problemDetailsErrorHandler } from '@adrianhall/cloudflare-toolkit/hono';
import type { RunMetrics } from '../../../src/runs';
import { MetricsService } from '../../../src/worker/application/metrics/metrics-service';
import type { RunRecord } from '../../../src/worker/application/ports/run-repository-port';
import { COST_RESOLUTION_BUDGET_MS } from '../../../src/worker/domain/metrics';
import {
  clearRunRecords,
  createMemoryRunRepository
} from '../../../src/worker/infrastructure/runs/memory-run-repository';
import { runsRouter } from '../../../src/worker/routes/runs';
import { FakeInference } from '../support/fake-inference';
import { mountRoute } from '../support/mount';

/**
 * Run identifier used by the tests.
 */
const RUN_ID = 'dddddddd-1111-4222-8333-444455556666';

/**
 * A stored run owned by Alice.
 *
 * @param overrides Fields to replace.
 * @returns A record ready to save.
 */
function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: RUN_ID,
    task: 'chat',
    model: '@cf/meta/llama-3.2-3b-instruct',
    ownerEmail: 'alice@example.com',
    logIds: ['log-1'],
    status: 'completed',
    startedAtMs: 1_000,
    ...overrides
  };
}

/**
 * A resolved gateway log.
 */
const METRIC = {
  logId: 'log-1',
  model: '@cf/meta/llama-3.2-3b-instruct',
  provider: 'workers-ai',
  cached: false,
  success: true,
  durationMs: 310,
  costUsd: 0.000_31,
  tokensIn: 12,
  tokensOut: 48
};

/**
 * Mounts the runs router over a stored run.
 *
 * @param options Stored record, resolvable metrics, identity, and the clock reading.
 * @returns The mounted app.
 */
async function mountRuns(
  options: {
    stored?: RunRecord | undefined;
    metrics?: Record<string, typeof METRIC>;
    identity?: { email: string; sub: string };
    nowMs?: number;
  } = {}
) {
  const runs = createMemoryRunRepository(() => 1_000);
  if (options.stored !== undefined) {
    await runs.save(options.stored);
  }

  const metricsService = new MetricsService({
    inference: new FakeInference(options.metrics === undefined ? {} : { metrics: options.metrics }),
    runs,
    now: () => options.nowMs ?? 1_500
  });

  const { app } = mountRoute('/api/runs', runsRouter, {
    identity: options.identity ?? { email: 'alice@example.com', sub: 'sub-alice' },
    metricsService
  });
  app.onError(problemDetailsErrorHandler({ includeStack: false }));
  return app;
}

beforeEach(() => {
  clearRunRecords();
});

describe('GET /api/runs/:runId/metrics', () => {
  it('returns an available cost once the gateway log has resolved', async () => {
    const app = await mountRuns({ stored: record(), metrics: { 'log-1': METRIC } });
    const response = await app.request(`/api/runs/${RUN_ID}/metrics`);

    expect(response.status).toBe(200);
    const metrics = (await response.json()) as RunMetrics;
    expect(metrics.costStatus).toBe('available');
    expect(metrics.totalCostUsd).toBe(0.000_31);
  });

  it('returns the individual gateway requests for display', async () => {
    const app = await mountRuns({ stored: record(), metrics: { 'log-1': METRIC } });
    const metrics = (await (await app.request(`/api/runs/${RUN_ID}/metrics`)).json()) as RunMetrics;

    expect(metrics.requests).toHaveLength(1);
    expect(metrics.requests[0]).toMatchObject({ logId: 'log-1', tokensIn: 12, tokensOut: 48 });
  });

  it('returns pending with a retry hint while the log has not propagated', async () => {
    const app = await mountRuns({ stored: record() });
    const response = await app.request(`/api/runs/${RUN_ID}/metrics`);

    const metrics = (await response.json()) as RunMetrics;
    expect(metrics.costStatus).toBe('pending');
    expect(metrics.retryAfterMs).toBeGreaterThan(0);
  });

  // A generic HTTP client reads `Retry-After`; this demo's client reads the body hint. Both are
  // sent so neither has to guess.
  it('sets a Retry-After header while pending', async () => {
    const app = await mountRuns({ stored: record() });
    const response = await app.request(`/api/runs/${RUN_ID}/metrics`);

    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
  });

  it('sets no Retry-After header once resolved', async () => {
    const app = await mountRuns({ stored: record(), metrics: { 'log-1': METRIC } });
    const response = await app.request(`/api/runs/${RUN_ID}/metrics`);

    expect(response.headers.get('Retry-After')).toBeNull();
  });

  it('returns unavailable once the resolution budget has expired', async () => {
    const app = await mountRuns({
      stored: record(),
      nowMs: 1_000 + COST_RESOLUTION_BUDGET_MS
    });
    const metrics = (await (await app.request(`/api/runs/${RUN_ID}/metrics`)).json()) as RunMetrics;

    expect(metrics.costStatus).toBe('unavailable');
    expect(metrics.totalCostUsd).toBeUndefined();
  });

  // The ownership rule at the HTTP boundary. A run identifier is guessable, so possession of one
  // must not be enough to read its cost.
  it('refuses to return another identity\u2019s run', async () => {
    const app = await mountRuns({
      stored: record(),
      metrics: { 'log-1': METRIC },
      identity: { email: 'bob@example.com', sub: 'sub-bob' }
    });
    const response = await app.request(`/api/runs/${RUN_ID}/metrics`);

    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });

  // A denial, not an empty result: an empty metrics document would be indistinguishable from a run
  // with no logs, which would hide the probe entirely.
  it('denies rather than returning empty metrics for another identity', async () => {
    const app = await mountRuns({
      stored: record(),
      identity: { email: 'bob@example.com', sub: 'sub-bob' }
    });
    const body = (await (await app.request(`/api/runs/${RUN_ID}/metrics`)).json()) as {
      status: number;
    };

    expect(body.status).toBe(403);
  });

  it('answers an unknown run with problem details', async () => {
    const app = await mountRuns({});
    const response = await app.request(`/api/runs/${RUN_ID}/metrics`);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });

  // A malformed identifier and a well-formed one for a run that does not exist are different
  // situations, and shape-checking first keeps an arbitrary string out of the repository entirely.
  it.each(['short', 'has%20space', 'a'.repeat(65), 'has%2Eexe'])(
    'rejects the malformed identifier %j',
    async (runId) => {
      const app = await mountRuns({ stored: record() });
      const response = await app.request(`/api/runs/${runId}/metrics`);

      expect(response.status).toBe(400);
    }
  );

  it('reports a run with no gateway log as unavailable', async () => {
    const app = await mountRuns({ stored: record({ logIds: [] }), nowMs: 1_100 });
    const metrics = (await (await app.request(`/api/runs/${RUN_ID}/metrics`)).json()) as RunMetrics;

    expect(metrics.costStatus).toBe('unavailable');
  });

  it('never reports a cost of zero for an unresolved run', async () => {
    const app = await mountRuns({
      stored: record(),
      nowMs: 1_000 + COST_RESOLUTION_BUDGET_MS
    });
    const text = await (await app.request(`/api/runs/${RUN_ID}/metrics`)).text();

    expect(text).not.toContain('"totalCostUsd":0');
  });

  it('reports a cache hit in the resolved request', async () => {
    const app = await mountRuns({
      stored: record(),
      metrics: { 'log-1': { ...METRIC, cached: true } }
    });
    const metrics = (await (await app.request(`/api/runs/${RUN_ID}/metrics`)).json()) as RunMetrics;

    expect(metrics.requests[0]?.cached).toBe(true);
  });
});
