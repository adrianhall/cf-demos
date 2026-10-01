<script setup lang="ts">
import { useLedgerStore } from '../../stores/ledger';

const ledger = useLedgerStore();

/**
 * Formats a dollar amount at a precision that suits inference pricing.
 *
 * Individual model calls routinely cost a small fraction of a cent, so the usual two decimal places
 * would render almost every real figure as `$0.00` — indistinguishable from free, and the exact
 * confusion this meter exists to prevent.
 *
 * @param amount Cost in US dollars, as reported by AI Gateway.
 * @returns The amount formatted to four decimal places with a leading currency symbol.
 */
function formatUsd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}
</script>

<template>
  <section class="cost-meter" aria-labelledby="cost-meter-heading">
    <h2 id="cost-meter-heading" class="cost-meter-heading">Session cost</h2>

    <!--
      The empty state is explicit rather than a blank space or a zero. "No inference runs yet" and
      "$0.0000" mean different things, and showing the second when the first is true would start
      the visitor off with a number that is technically accurate and completely misleading.
    -->
    <p v-if="!ledger.hasRuns" class="cost-empty">No inference runs yet</p>

    <template v-else>
      <p class="cost-total">{{ formatUsd(ledger.ledger.knownCostUsd) }}</p>
      <dl class="cost-detail">
        <div class="cost-row">
          <dt>Runs</dt>
          <dd>{{ ledger.ledger.runCount }}</dd>
        </div>
        <!--
          Pending and unavailable are counted beside the total, never folded into it. A total that
          silently omits an unresolved run is a wrong number presented as a right one.
        -->
        <div v-if="ledger.ledger.pendingRuns > 0" class="cost-row">
          <dt>Cost pending</dt>
          <dd>{{ ledger.ledger.pendingRuns }}</dd>
        </div>
        <div v-if="ledger.ledger.unavailableRuns > 0" class="cost-row">
          <dt>Cost unavailable</dt>
          <dd>{{ ledger.ledger.unavailableRuns }}</dd>
        </div>
        <div v-if="ledger.ledger.cachedRequests > 0" class="cost-row">
          <dt>Served from cache</dt>
          <dd>{{ ledger.ledger.cachedRequests }}</dd>
        </div>
      </dl>
    </template>

    <router-link to="/activity" class="cost-link">Activity and gateway</router-link>
  </section>
</template>

<style scoped>
.cost-meter {
  border-top: 1px solid rgb(var(--v-theme-outline-variant));
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 1rem 1.25rem;
}

.cost-meter-heading {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  margin: 0;
  text-transform: uppercase;
}

.cost-empty {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0;
}

.cost-total {
  font-size: 1.5rem;
  font-weight: 700;
  margin: 0;
}

.cost-detail {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  margin: 0;
}

.cost-row {
  display: flex;
  gap: 0.5rem;
  justify-content: space-between;
}

.cost-row dt,
.cost-row dd {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0;
}

.cost-link {
  color: rgb(var(--v-theme-primary));
  margin-top: 0.25rem;
  /* Keeps the link's hit area at a comfortable target size without a button-sized control. */
  padding: 0.375rem 0;
}
</style>
