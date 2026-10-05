import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { useLedgerStore } from '../../../src/client/stores/ledger';
import type { RunMetrics } from '../../../src/shared/runs';

/**
 * Builds a metrics document.
 *
 * @param overrides Fields to replace on an available single-request result.
 * @returns Metrics ready to apply.
 */
function metrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    runId: 'run-1',
    costStatus: 'available',
    totalCostUsd: 0.001,
    requests: [
      {
        logId: 'log-1',
        model: '@cf/meta/llama-3.2-3b-instruct',
        provider: 'workers-ai',
        cached: false,
        success: true,
        durationMs: 300,
        costUsd: 0.001
      }
    ],
    ...overrides
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('useLedgerStore', () => {
  it('starts empty', () => {
    const ledger = useLedgerStore();
    expect(ledger.hasRuns).toBe(false);
    expect(ledger.ledger.runCount).toBe(0);
  });

  // The run count moves as soon as the run finishes rather than when its cost resolves. A run that
  // is invisible until then is one a visitor can start several of without the meter moving.
  it('counts a run immediately, before its cost resolves', () => {
    const ledger = useLedgerStore();
    ledger.recordRun('run-1', 'pending');

    expect(ledger.hasRuns).toBe(true);
    expect(ledger.ledger.runCount).toBe(1);
    expect(ledger.ledger.pendingRuns).toBe(1);
    expect(ledger.ledger.knownCostUsd).toBe(0);
  });

  it('counts a run with no gateway log as unavailable from the start', () => {
    const ledger = useLedgerStore();
    ledger.recordRun('run-1', 'unavailable');

    expect(ledger.ledger.unavailableRuns).toBe(1);
    expect(ledger.ledger.pendingRuns).toBe(0);
  });

  // A re-render or a retried request must not double-count a run.
  it('ignores a run recorded twice', () => {
    const ledger = useLedgerStore();
    ledger.recordRun('run-1', 'pending');
    ledger.recordRun('run-1', 'pending');

    expect(ledger.ledger.runCount).toBe(1);
  });

  it('adds a resolved cost to the total and clears the pending count', () => {
    const ledger = useLedgerStore();
    ledger.recordRun('run-1', 'pending');
    ledger.applyMetrics(metrics());

    expect(ledger.ledger.knownCostUsd).toBe(0.001);
    expect(ledger.ledger.pendingRuns).toBe(0);
    expect(ledger.ledger.billedRequests).toBe(1);
  });

  // The client polls repeatedly, and each poll reports the same figures again. Without reversing
  // the previous contribution the total would grow with every poll — a wrong number that looks
  // entirely plausible.
  it('converges rather than inflating when the same metrics arrive twice', () => {
    const ledger = useLedgerStore();
    ledger.recordRun('run-1', 'pending');
    ledger.applyMetrics(metrics());
    ledger.applyMetrics(metrics());

    expect(ledger.ledger.knownCostUsd).toBe(0.001);
    expect(ledger.ledger.billedRequests).toBe(1);
  });

  it('corrects the total when a pending poll is followed by a resolved one', () => {
    const ledger = useLedgerStore();
    ledger.recordRun('run-1', 'pending');

    ledger.applyMetrics(metrics({ costStatus: 'pending', totalCostUsd: undefined, requests: [] }));
    expect(ledger.ledger.knownCostUsd).toBe(0);
    expect(ledger.ledger.pendingRuns).toBe(1);

    ledger.applyMetrics(metrics());
    expect(ledger.ledger.knownCostUsd).toBe(0.001);
    expect(ledger.ledger.pendingRuns).toBe(0);
  });

  // A pending or unavailable run is counted beside the total, never folded into it.
  it('does not add a cost for a pending run', () => {
    const ledger = useLedgerStore();
    ledger.recordRun('run-1', 'pending');
    ledger.applyMetrics(metrics({ costStatus: 'pending', totalCostUsd: undefined, requests: [] }));

    expect(ledger.ledger.knownCostUsd).toBe(0);
  });

  it('does not add a cost for an unavailable run even if a figure is present', () => {
    const ledger = useLedgerStore();
    ledger.recordRun('run-1', 'pending');
    ledger.applyMetrics(metrics({ costStatus: 'unavailable', totalCostUsd: 0.5 }));

    expect(ledger.ledger.knownCostUsd).toBe(0);
    expect(ledger.ledger.unavailableRuns).toBe(1);
  });

  it('counts a cache hit separately from a billed request', () => {
    const ledger = useLedgerStore();
    ledger.recordRun('run-1', 'pending');
    ledger.applyMetrics(
      metrics({
        requests: [{ ...metrics().requests[0]!, cached: true }]
      })
    );

    expect(ledger.ledger.cachedRequests).toBe(1);
    expect(ledger.ledger.billedRequests).toBe(0);
  });

  it('sums the costs of several runs', () => {
    const ledger = useLedgerStore();
    ledger.recordRun('run-1', 'pending');
    ledger.recordRun('run-2', 'pending');
    ledger.applyMetrics(metrics({ runId: 'run-1', totalCostUsd: 0.001 }));
    ledger.applyMetrics(metrics({ runId: 'run-2', totalCostUsd: 0.002 }));

    expect(ledger.ledger.runCount).toBe(2);
    expect(ledger.ledger.knownCostUsd).toBeCloseTo(0.003, 10);
  });

  // Metrics for a run this session never started would mean inventing a run to attach them to,
  // which would make the count wrong.
  it('ignores metrics for an unknown run', () => {
    const ledger = useLedgerStore();
    ledger.applyMetrics(metrics({ runId: 'never-recorded' }));

    expect(ledger.ledger.runCount).toBe(0);
    expect(ledger.ledger.knownCostUsd).toBe(0);
  });

  it('moves a run from pending to unavailable when polling gives up', () => {
    const ledger = useLedgerStore();
    ledger.recordRun('run-1', 'pending');
    ledger.markUnavailable('run-1');

    expect(ledger.ledger.pendingRuns).toBe(0);
    expect(ledger.ledger.unavailableRuns).toBe(1);
    // The run stays counted: it happened and it cost something. Only the figure is unknown.
    expect(ledger.ledger.runCount).toBe(1);
  });

  it('is idempotent when a run is marked unavailable twice', () => {
    const ledger = useLedgerStore();
    ledger.recordRun('run-1', 'pending');
    ledger.markUnavailable('run-1');
    ledger.markUnavailable('run-1');

    expect(ledger.ledger.unavailableRuns).toBe(1);
  });

  it('ignores an unavailable mark for an unknown run', () => {
    const ledger = useLedgerStore();
    ledger.markUnavailable('never-recorded');
    expect(ledger.ledger.unavailableRuns).toBe(0);
  });

  // Phase 15's test, and the one that justifies the ledger's shape. The three panels in play bill in
  // three different units — Chat per token, ElevenLabs per second of output audio, MiniMax per track
  // — and only the first reports a token count at all. The ledger adds the *costs the gateway
  // reported*, which is the only thing those three runs have in common; it never derives a figure
  // from tokens, and it never needs to know which unit produced one.
  //
  // Written as one session rather than three separate assertions, because the failure this guards
  // against is a total that only works when every run is the same kind of thing.
  it('sums a session mixing token, per-second, and per-track charges', () => {
    const ledger = useLedgerStore();

    ledger.recordRun('chat-run', 'pending');
    ledger.recordRun('music-seconds-run', 'pending');
    ledger.recordRun('music-track-run', 'pending');

    // Chat: per-token, and the only run here that reports a token count.
    ledger.applyMetrics(
      metrics({
        runId: 'chat-run',
        totalCostUsd: 0.000_18,
        requests: [
          {
            logId: 'chat-log',
            model: '@cf/meta/llama-3.2-3b-instruct',
            provider: 'workers-ai',
            cached: false,
            success: true,
            durationMs: 300,
            costUsd: 0.000_18,
            tokensIn: 14,
            tokensOut: 52
          }
        ]
      })
    );

    // ElevenLabs: per second of output audio. The gateway reports a cost and **no tokens at all**,
    // which is the case a ledger that reached for `tokensIn` would get wrong.
    ledger.applyMetrics(
      metrics({
        runId: 'music-seconds-run',
        totalCostUsd: 0.075,
        requests: [
          {
            logId: 'music-seconds-log',
            model: 'elevenlabs/music-v2',
            provider: 'elevenlabs',
            cached: false,
            success: true,
            durationMs: 21_000,
            costUsd: 0.075
          }
        ]
      })
    );

    // MiniMax: a flat price per track, in a third unit again.
    ledger.applyMetrics(
      metrics({
        runId: 'music-track-run',
        totalCostUsd: 0.15,
        requests: [
          {
            logId: 'music-track-log',
            model: 'minimax/music-2.6',
            provider: 'minimax',
            cached: false,
            success: true,
            durationMs: 34_000,
            costUsd: 0.15
          }
        ]
      })
    );

    expect(ledger.ledger.runCount).toBe(3);
    expect(ledger.ledger.billedRequests).toBe(3);
    expect(ledger.ledger.pendingRuns).toBe(0);
    // The sum of three reported costs in three different billing units, which is a legitimate total
    // precisely because each figure came from the gateway rather than from an arithmetic on tokens.
    expect(ledger.ledger.knownCostUsd).toBeCloseTo(0.225_18, 10);
  });

  // The negative half of the same rule, stated as its own test so the intent survives a refactor of
  // the one above. A music run reports a real cost and no tokens; the total must include it.
  it('includes a run that reports a cost but no tokens', () => {
    const ledger = useLedgerStore();
    ledger.recordRun('music-run', 'pending');

    ledger.applyMetrics(
      metrics({
        runId: 'music-run',
        totalCostUsd: 0.15,
        requests: [
          {
            logId: 'music-log',
            model: 'minimax/music-2.6',
            provider: 'minimax',
            cached: false,
            success: true,
            durationMs: 34_000,
            costUsd: 0.15
            // No `tokensIn` and no `tokensOut`: this provider reports neither, and their absence
            // must not be read as "this run was free".
          }
        ]
      })
    );

    expect(ledger.ledger.knownCostUsd).toBeCloseTo(0.15, 10);
    expect(ledger.ledger.unavailableRuns).toBe(0);
  });

  it('counts every gateway request of a multi-call run', () => {
    const ledger = useLedgerStore();
    ledger.recordRun('run-1', 'pending');
    ledger.applyMetrics(
      metrics({
        totalCostUsd: 0.003,
        requests: [
          { ...metrics().requests[0]!, logId: 'a' },
          { ...metrics().requests[0]!, logId: 'b', cached: true }
        ]
      })
    );

    expect(ledger.ledger.billedRequests).toBe(1);
    expect(ledger.ledger.cachedRequests).toBe(1);
  });
});
