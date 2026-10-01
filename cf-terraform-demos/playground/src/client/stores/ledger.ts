import { defineStore } from 'pinia';
import { emptySessionCostLedger, type SessionCostLedger } from '../../runs';

/**
 * Running cost totals for the current browser session.
 *
 * The ledger is held in the browser and never persisted server-side. A run's cost is only
 * interesting while the person who caused it is still looking at the screen, and keeping a per-user
 * spending history on the server would be a retention decision this demo has no reason to make.
 *
 * It starts empty in Phase 1 and Phase 2: View Tokens runs entirely in the browser, so there is
 * nothing to count yet. The meter is nonetheless mounted from the first phase, showing an explicit
 * "No inference runs yet" state. A cost indicator that appears only once spending starts is one a
 * visitor never notices; one that is visible from the first screen is a standing reminder that
 * these panels cost money.
 *
 * Phase 3 adds the mutations that record runs as Chat produces them.
 */
export const useLedgerStore = defineStore('ledger', {
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
  state: (): { ledger: SessionCostLedger } => ({
    /**
     * Totals across every run in this browser session.
     */
    ledger: emptySessionCostLedger()
  })
});
