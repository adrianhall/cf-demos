import { describe, expect, it } from 'vitest';
import type { GatewayRequestMetric } from '../../../src/shared/runs';
import {
  aggregateRunMetrics,
  COST_RESOLUTION_BUDGET_MS,
  initialCostStatus
} from '../../../src/worker/domain/metrics';

/**
 * Builds a resolved gateway log record.
 *
 * @param overrides Fields to replace on the default record.
 * @returns A metric ready to aggregate.
 */
function metric(overrides: Partial<GatewayRequestMetric> = {}): GatewayRequestMetric {
  return {
    logId: 'log-1',
    model: '@cf/meta/llama-3.2-3b-instruct',
    provider: 'workers-ai',
    cached: false,
    success: true,
    durationMs: 412,
    costUsd: 0.000_12,
    tokensIn: 11,
    tokensOut: 42,
    ...overrides
  };
}

describe('aggregateRunMetrics', () => {
  it('reports a fully resolved single-call run as available', () => {
    const result = aggregateRunMetrics('run-1', 1, [metric()], 500);
    expect(result.costStatus).toBe('available');
    expect(result.totalCostUsd).toBe(0.000_12);
  });

  // Semantic Search in a later phase makes several calls per run, so summing is not hypothetical.
  it('sums the reported costs of a multi-call run', () => {
    const result = aggregateRunMetrics(
      'run-1',
      2,
      [metric({ logId: 'a', costUsd: 0.001 }), metric({ logId: 'b', costUsd: 0.002 })],
      500
    );
    expect(result.costStatus).toBe('available');
    expect(result.totalCostUsd).toBeCloseTo(0.003, 10);
  });

  // The central honesty rule: a partially resolved run stays pending rather than showing a total
  // that silently omits one of its requests.
  it('keeps a partially resolved multi-call run pending', () => {
    const result = aggregateRunMetrics('run-1', 2, [metric()], 500);
    expect(result.costStatus).toBe('pending');
    expect(result.totalCostUsd).toBeUndefined();
  });

  it('stays pending when a log resolved but carried no cost', () => {
    const result = aggregateRunMetrics('run-1', 1, [metric({ costUsd: undefined })], 500);
    expect(result.costStatus).toBe('pending');
    expect(result.totalCostUsd).toBeUndefined();
  });

  it('offers a retry hint while pending', () => {
    expect(aggregateRunMetrics('run-1', 1, [], 500).retryAfterMs).toBeGreaterThan(0);
  });

  it('reports no retry hint once resolved', () => {
    expect(aggregateRunMetrics('run-1', 1, [metric()], 500).retryAfterMs).toBeUndefined();
  });

  // A missing cost stays missing. Substituting zero would make an unmeasured run indistinguishable
  // from a free one, which is the exact confusion the whole cost story exists to prevent.
  it('reports an expired budget as unavailable rather than zero', () => {
    const result = aggregateRunMetrics('run-1', 1, [], COST_RESOLUTION_BUDGET_MS);
    expect(result.costStatus).toBe('unavailable');
    expect(result.totalCostUsd).toBeUndefined();
  });

  it('still returns what did resolve when the budget expired', () => {
    const resolved = [metric({ costUsd: undefined })];
    const result = aggregateRunMetrics('run-1', 2, resolved, COST_RESOLUTION_BUDGET_MS + 1);
    expect(result.costStatus).toBe('unavailable');
    expect(result.requests).toEqual(resolved);
  });

  // A run with no log can never resolve, so it does not wait out the budget only to say so later.
  it('reports a run with no gateway log as immediately unavailable', () => {
    const result = aggregateRunMetrics('run-1', 0, [], 0);
    expect(result.costStatus).toBe('unavailable');
  });

  it('resolves at the instant the budget expires if the logs did arrive', () => {
    const result = aggregateRunMetrics('run-1', 1, [metric()], COST_RESOLUTION_BUDGET_MS);
    expect(result.costStatus).toBe('available');
  });

  it('echoes the run identifier it was asked about', () => {
    expect(aggregateRunMetrics('run-xyz', 1, [metric()], 0).runId).toBe('run-xyz');
  });

  it('returns every resolved request for display', () => {
    const resolved = [metric({ logId: 'a' }), metric({ logId: 'b' })];
    expect(aggregateRunMetrics('run-1', 2, resolved, 0).requests).toHaveLength(2);
  });
});

describe('initialCostStatus', () => {
  // The receipt is built before any log could have propagated, so it never claims availability.
  it('is pending when a log exists to poll for', () => {
    expect(initialCostStatus(['log-1'])).toBe('pending');
  });

  it('is unavailable when the gateway assigned no log', () => {
    expect(initialCostStatus([])).toBe('unavailable');
  });
});
