/**
 * @file Metrics polling for a completed run, shared by every inference panel. Chat is the first
 *   caller; Create Image and the rest reuse it unchanged, which is why it lives in `composables/`
 *   rather than inside the Chat feature.
 */

import { ref, type Ref } from 'vue';
import type { RunMetrics, RunReceipt } from '../../shared/runs';
import { ApiError, fetchRunMetrics } from '../services/playground-api';
import { useLedgerStore } from '../stores/ledger';

/**
 * Longest a run's cost is polled for before being declared unavailable.
 *
 * Matches the server's own resolution budget. The client gives up slightly later so the server gets
 * the chance to answer `unavailable` itself, which is a more informative outcome than the client
 * timing out on its own.
 */
export const METRICS_POLL_BUDGET_MS = 25_000;

/**
 * Fallback wait between polls, used when the server sends no hint.
 */
export const METRICS_POLL_INTERVAL_MS = 1_200;

/**
 * Options for {@link useRun}.
 */
export interface UseRunOptions {
  /**
   * Sleep function, injected so tests resolve polls immediately instead of waiting seconds.
   *
   * @param ms Milliseconds to wait.
   * @returns A promise fulfilled after the delay.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Clock reading epoch milliseconds, injected so a test can exhaust the polling budget without
   * real time passing.
   */
  now?: () => number;
}

/**
 * What {@link useRun} exposes to a panel.
 */
export interface UseRunResult {
  /**
   * Resolved metrics for the most recent run, or `undefined` before the first poll returns.
   */
  metrics: Ref<RunMetrics | undefined>;
  /**
   * Whether a cost is still being polled for, so the panel can show "Cost pending" rather than an
   * empty space.
   */
  costPending: Ref<boolean>;
  /**
   * Begins polling for a receipt's cost and keeps the session ledger in step.
   *
   * @param receipt The receipt from a completed run.
   * @returns A promise fulfilled once the cost resolved, was declared unavailable, or the budget
   *   expired.
   */
  trackRun: (receipt: RunReceipt) => Promise<void>;
}

/**
 * Tracks a run's cost from its receipt to its resolved gateway metrics.
 *
 * The run is added to the session ledger immediately and its cost is filled in later. That ordering
 * is deliberate: a run that is invisible until its cost resolves is a run a visitor can start
 * several of without the meter moving, which is precisely the blindness the meter exists to
 * prevent.
 *
 * @param options Injectable clock and sleep; see {@link UseRunOptions}.
 * @returns Reactive metrics state and the tracking action; see {@link UseRunResult}.
 */
export function useRun(options: UseRunOptions = {}): UseRunResult {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const ledger = useLedgerStore();

  const metrics = ref<RunMetrics | undefined>(undefined);
  const costPending = ref(false);

  /**
   * Sequence number of the most recent tracked run.
   *
   * A visitor can send a second prompt while the first run's cost is still being polled for.
   * Without this guard the older poll could resolve last and overwrite the newer run's metrics with
   * the previous run's figures — a wrong number that looks entirely plausible.
   */
  let latest = 0;

  return {
    metrics,
    costPending,
    trackRun: async (receipt: RunReceipt): Promise<void> => {
      const sequence = ++latest;

      ledger.recordRun(receipt.runId, receipt.costStatus === 'pending' ? 'pending' : 'unavailable');
      metrics.value = undefined;

      // A run with no gateway log will never resolve, so it is not polled for at all. Polling it
      // would spend the full budget to learn what the receipt already said.
      if (receipt.costStatus !== 'pending') {
        costPending.value = false;
        return;
      }

      costPending.value = true;
      const deadline = now() + METRICS_POLL_BUDGET_MS;

      try {
        while (now() < deadline) {
          let result: RunMetrics;
          try {
            result = await fetchRunMetrics(receipt.runId);
          } catch (cause) {
            // A forgotten run means its isolate was recycled, and a forbidden one is not ours to
            // read. Neither will become available by asking again, so both stop the loop rather
            // than burning the budget.
            if (cause instanceof ApiError && (cause.status === 404 || cause.status === 403)) {
              break;
            }
            throw cause;
          }

          if (sequence !== latest) {
            return;
          }

          metrics.value = result;
          ledger.applyMetrics(result);

          if (result.costStatus !== 'pending') {
            costPending.value = false;
            return;
          }

          await sleep(result.retryAfterMs ?? METRICS_POLL_INTERVAL_MS);
        }

        if (sequence !== latest) {
          return;
        }

        // The budget expired or the run became unreadable. The cost is reported as unavailable
        // rather than left pending forever or shown as zero.
        ledger.markUnavailable(receipt.runId);
        costPending.value = false;
      } catch {
        if (sequence !== latest) {
          return;
        }
        ledger.markUnavailable(receipt.runId);
        costPending.value = false;
      }
    }
  };
}
