import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { METRICS_POLL_BUDGET_MS, useRun } from '../../../src/client/composables/useRun';
import { useLedgerStore } from '../../../src/client/stores/ledger';
import type { RunMetrics, RunReceipt } from '../../../src/shared/runs';

/**
 * Builds a run receipt.
 *
 * @param overrides Fields to replace on a pending single-log receipt.
 * @returns A receipt ready to track.
 */
function receipt(overrides: Partial<RunReceipt> = {}): RunReceipt {
  return {
    runId: 'run-1',
    task: 'chat',
    model: '@cf/meta/llama-3.2-3b-instruct',
    gatewayRouted: true,
    logIds: ['log-1'],
    status: 'completed',
    costStatus: 'pending',
    elapsedMs: 420,
    startedAt: '2026-04-01T09:15:00.000Z',
    ...overrides
  };
}

/**
 * Builds a metrics document.
 *
 * @param overrides Fields to replace on an available result.
 * @returns Metrics the fake endpoint can return.
 */
function metrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    runId: 'run-1',
    costStatus: 'available',
    totalCostUsd: 0.002,
    requests: [
      {
        logId: 'log-1',
        model: '@cf/meta/llama-3.2-3b-instruct',
        provider: 'workers-ai',
        cached: false,
        success: true,
        durationMs: 300,
        costUsd: 0.002
      }
    ],
    ...overrides
  };
}

/**
 * Replaces `fetch` with a queue of canned metrics responses.
 *
 * @param responses Responses to return in order; the last is repeated once exhausted.
 * @returns The spy, so a test can assert how many polls happened.
 */
function stubFetch(responses: (RunMetrics | { status: number })[]) {
  let index = 0;
  const spy = vi.fn(() => {
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;

    if ('status' in next) {
      return Promise.resolve(
        new Response(JSON.stringify({ status: next.status, detail: 'nope' }), {
          status: next.status,
          headers: { 'content-type': 'application/problem+json' }
        })
      );
    }

    return Promise.resolve(
      new Response(JSON.stringify(next), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
  });

  vi.stubGlobal('fetch', spy);
  return spy;
}

/**
 * A sleep that resolves immediately, so polling tests do not wait seconds of real time.
 *
 * @returns An already-fulfilled promise.
 */
const instantSleep = (): Promise<void> => Promise.resolve();

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useRun.trackRun', () => {
  it('records the run in the session ledger before any cost resolves', async () => {
    stubFetch([metrics()]);
    const ledger = useLedgerStore();
    const run = useRun({ sleep: instantSleep });

    await run.trackRun(receipt());
    expect(ledger.ledger.runCount).toBe(1);
  });

  it('resolves an available cost and clears the pending flag', async () => {
    stubFetch([metrics()]);
    const run = useRun({ sleep: instantSleep });

    await run.trackRun(receipt());

    expect(run.metrics.value?.costStatus).toBe('available');
    expect(run.metrics.value?.totalCostUsd).toBe(0.002);
    expect(run.costPending.value).toBe(false);
  });

  it('applies the resolved cost to the session total', async () => {
    stubFetch([metrics()]);
    const ledger = useLedgerStore();
    const run = useRun({ sleep: instantSleep });

    await run.trackRun(receipt());
    expect(ledger.ledger.knownCostUsd).toBe(0.002);
  });

  // The gateway log is written asynchronously, so the first poll routinely misses. Polling until it
  // lands is the whole point of this composable.
  it('polls until the cost resolves', async () => {
    const spy = stubFetch([
      metrics({ costStatus: 'pending', totalCostUsd: undefined, requests: [], retryAfterMs: 10 }),
      metrics({ costStatus: 'pending', totalCostUsd: undefined, requests: [], retryAfterMs: 10 }),
      metrics()
    ]);
    const run = useRun({ sleep: instantSleep });

    await run.trackRun(receipt());

    expect(spy).toHaveBeenCalledTimes(3);
    expect(run.metrics.value?.costStatus).toBe('available');
  });

  // A run with no gateway log can never resolve, so polling it would spend the whole budget to
  // learn what the receipt already said.
  it('does not poll a run that has no gateway log', async () => {
    const spy = stubFetch([metrics()]);
    const run = useRun({ sleep: instantSleep });

    await run.trackRun(receipt({ costStatus: 'unavailable', logIds: [] }));

    expect(spy).not.toHaveBeenCalled();
    expect(run.costPending.value).toBe(false);
  });

  it('counts a run with no gateway log as unavailable in the ledger', async () => {
    stubFetch([metrics()]);
    const ledger = useLedgerStore();
    const run = useRun({ sleep: instantSleep });

    await run.trackRun(receipt({ costStatus: 'unavailable', logIds: [] }));
    expect(ledger.ledger.unavailableRuns).toBe(1);
  });

  // A forgotten run means its isolate was recycled. That will not change by asking again, so the
  // loop stops rather than burning the budget.
  it('stops polling when the server no longer remembers the run', async () => {
    const spy = stubFetch([{ status: 404 }]);
    const ledger = useLedgerStore();
    const run = useRun({ sleep: instantSleep });

    await run.trackRun(receipt());

    expect(spy).toHaveBeenCalledTimes(1);
    expect(ledger.ledger.unavailableRuns).toBe(1);
    expect(run.costPending.value).toBe(false);
  });

  it('stops polling when the run belongs to another identity', async () => {
    const spy = stubFetch([{ status: 403 }]);
    const run = useRun({ sleep: instantSleep });

    await run.trackRun(receipt());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // The budget is finite, so a cost that never arrives ends as "unavailable" rather than as a
  // spinner that runs forever.
  it('gives up once the polling budget expires', async () => {
    let clock = 0;
    stubFetch([
      metrics({ costStatus: 'pending', totalCostUsd: undefined, requests: [], retryAfterMs: 10 })
    ]);
    const ledger = useLedgerStore();
    const run = useRun({
      sleep: () => {
        clock += 5_000;
        return Promise.resolve();
      },
      now: () => clock
    });

    await run.trackRun(receipt());

    expect(clock).toBeGreaterThanOrEqual(METRICS_POLL_BUDGET_MS);
    expect(ledger.ledger.unavailableRuns).toBe(1);
    expect(run.costPending.value).toBe(false);
  });

  it('records the run as unavailable when the network fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline')))
    );
    const ledger = useLedgerStore();
    const run = useRun({ sleep: instantSleep });

    await run.trackRun(receipt());

    expect(ledger.ledger.unavailableRuns).toBe(1);
    expect(run.costPending.value).toBe(false);
  });

  // A visitor can send a second prompt while the first run's cost is still resolving. Without the
  // sequence guard the older poll could land last and overwrite the newer run's figures.
  it('discards a stale poll that resolves after a newer run started', async () => {
    const run = useRun({ sleep: instantSleep });

    let resolveFirst: ((value: Response) => void) | undefined;
    const spy = vi.fn((input: unknown) => {
      const url = String(input);
      if (url.includes('run-old')) {
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify(metrics({ runId: 'run-new', totalCostUsd: 0.009 })), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );
    });
    vi.stubGlobal('fetch', spy);

    const stale = run.trackRun(receipt({ runId: 'run-old' }));
    await run.trackRun(receipt({ runId: 'run-new' }));

    resolveFirst?.(
      new Response(JSON.stringify(metrics({ runId: 'run-old', totalCostUsd: 0.111 })), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    await stale;

    expect(run.metrics.value?.runId).toBe('run-new');
    expect(run.metrics.value?.totalCostUsd).toBe(0.009);
  });

  it('clears the previous run\u2019s metrics when a new run starts', async () => {
    stubFetch([metrics()]);
    const run = useRun({ sleep: instantSleep });

    await run.trackRun(receipt({ runId: 'run-1' }));
    expect(run.metrics.value).toBeDefined();

    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined))
    );
    void run.trackRun(receipt({ runId: 'run-2' }));

    expect(run.metrics.value).toBeUndefined();
  });

  it('requests the metrics endpoint for the run it was given', async () => {
    const spy = stubFetch([metrics()]);
    const run = useRun({ sleep: instantSleep });

    await run.trackRun(receipt({ runId: 'run-abc12345' }));
    expect(String(spy.mock.calls.at(0)?.at(0))).toBe('/api/runs/run-abc12345/metrics');
  });
});
