import { defineStore } from 'pinia';
import { emptySessionCostLedger, type RunMetrics, type SessionCostLedger } from '../../shared/runs';

/**
 * Per-run state the ledger needs in order to correct its own totals.
 *
 * A run's cost resolves after it is recorded, and it can resolve more than once if the client polls
 * repeatedly. Remembering what each run last contributed is what lets the ledger apply an update by
 * reversing the previous contribution instead of adding to it — the difference between a total that
 * converges and one that inflates with every poll.
 */
interface LedgerEntry {
  /**
   * Cost this run has already added to `knownCostUsd`, or zero.
   */
  appliedCostUsd: number;
  /**
   * Whether this run is currently counted in `pendingRuns`.
   */
  countedPending: boolean;
  /**
   * Whether this run is currently counted in `unavailableRuns`.
   */
  countedUnavailable: boolean;
  /**
   * Cache hits this run has already contributed to `cachedRequests`.
   */
  appliedCachedRequests: number;
  /**
   * Provider-billed requests this run has already contributed to `billedRequests`.
   */
  appliedBilledRequests: number;
}

/**
 * Running cost totals for the current browser session.
 *
 * The ledger is held in the browser and never persisted server-side. A run's cost is only
 * interesting while the person who caused it is still looking at the screen, and keeping a per-user
 * spending history on the server would be a retention decision this demo has no reason to make.
 *
 * The meter is mounted from the first screen, showing an explicit "No inference runs yet" state. A
 * cost indicator that appears only once spending starts is one a visitor never notices; one that is
 * visible from the first screen is a standing reminder that these panels cost money.
 *
 * Chat is the first panel to put a figure in it. View Tokens never does: it tokenizes in the
 * browser, so there is no run and nothing to charge.
 */
export const useLedgerStore = defineStore('ledger', {
  actions: {
    /**
     * Records a newly completed run whose cost has not resolved yet.
     *
     * Called as soon as a run finishes, so the meter's run count moves immediately rather than
     * waiting for a cost that takes a second or more to appear — and so a run whose cost never
     * resolves is still visibly counted.
     *
     * @param runId The run to record. Recording the same run twice is a no-op, which matters
     *   because a re-render or a retried poll must not double-count it.
     * @param costStatus Whether the run has a gateway log to poll for (`pending`) or will never
     *   have one (`unavailable`).
     * @returns Nothing; the ledger totals have been updated.
     */
    recordRun(runId: string, costStatus: 'pending' | 'unavailable'): void {
      if (Object.hasOwn(this.entries, runId)) {
        return;
      }

      this.ledger.runCount += 1;
      if (costStatus === 'pending') {
        this.ledger.pendingRuns += 1;
      } else {
        this.ledger.unavailableRuns += 1;
      }

      this.entries[runId] = {
        appliedCostUsd: 0,
        countedPending: costStatus === 'pending',
        countedUnavailable: costStatus === 'unavailable',
        appliedCachedRequests: 0,
        appliedBilledRequests: 0
      };
    },

    /**
     * Applies resolved metrics to the totals.
     *
     * The previous contribution is reversed before the new one is applied, so polling a run several
     * times converges on one correct total rather than accumulating a multiple of it. A run not
     * previously recorded is ignored: that would mean metrics arriving for a run this session never
     * started, and inventing a run to attach them to would make the count wrong.
     *
     * @param metrics Metrics as returned by `GET /api/runs/:runId/metrics`.
     * @returns Nothing; the ledger totals reflect the new state of this run.
     */
    applyMetrics(metrics: RunMetrics): void {
      const entry = this.entries[metrics.runId];
      if (entry === undefined) {
        return;
      }

      this.ledger.knownCostUsd -= entry.appliedCostUsd;
      if (entry.countedPending) {
        this.ledger.pendingRuns -= 1;
      }
      if (entry.countedUnavailable) {
        this.ledger.unavailableRuns -= 1;
      }

      // Request counters are recomputed from scratch for this run rather than incremented, for the
      // same reason as the cost: a second poll reports the same requests again, and adding them
      // would count one gateway call several times.
      this.ledger.cachedRequests -= entry.appliedCachedRequests;
      this.ledger.billedRequests -= entry.appliedBilledRequests;

      const cached = metrics.requests.filter((request) => request.cached).length;
      const billed = metrics.requests.length - cached;
      this.ledger.cachedRequests += cached;
      this.ledger.billedRequests += billed;

      // Only an `available` run contributes to the total. A `pending` or `unavailable` run is
      // counted beside it, never folded into it: a total that silently omits an unresolved run is
      // a wrong number wearing the appearance of a right one.
      const cost = metrics.costStatus === 'available' ? (metrics.totalCostUsd ?? 0) : 0;
      this.ledger.knownCostUsd += cost;

      entry.appliedCostUsd = cost;
      entry.countedPending = metrics.costStatus === 'pending';
      entry.countedUnavailable = metrics.costStatus === 'unavailable';
      entry.appliedCachedRequests = cached;
      entry.appliedBilledRequests = billed;

      if (entry.countedPending) {
        this.ledger.pendingRuns += 1;
      }
      if (entry.countedUnavailable) {
        this.ledger.unavailableRuns += 1;
      }
    },

    /**
     * Marks a run's cost as never going to resolve.
     *
     * Used when metrics polling gives up or the server no longer remembers the run. The run stays
     * counted, because it happened and it cost something; only the figure is unknown.
     *
     * @param runId The run whose cost cannot be resolved.
     * @returns Nothing; the run has moved from pending to unavailable.
     */
    markUnavailable(runId: string): void {
      const entry = this.entries[runId];
      if (entry === undefined || entry.countedUnavailable) {
        return;
      }

      if (entry.countedPending) {
        this.ledger.pendingRuns -= 1;
        entry.countedPending = false;
      }
      this.ledger.unavailableRuns += 1;
      entry.countedUnavailable = true;
    }
  },
  getters: {
    /**
     * Whether any inference run has been started in this session.
     *
     * @param state Current ledger state.
     * @returns `true` once at least one run exists, so the shell can swap the empty state for the
     *   totals.
     */
    hasRuns: (state): boolean => state.ledger.runCount > 0
  },
  state: (): { ledger: SessionCostLedger; entries: Record<string, LedgerEntry> } => ({
    /**
     * Totals across every run in this browser session.
     */
    ledger: emptySessionCostLedger(),
    /**
     * Per-run bookkeeping, so a repeated metrics update corrects the totals rather than inflating
     * them; see {@link LedgerEntry}.
     */
    entries: {}
  })
});
