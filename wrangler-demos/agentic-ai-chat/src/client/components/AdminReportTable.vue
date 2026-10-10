<script setup lang="ts">
import type { ChatUsageSummary } from "../composables/useChatAgent";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import UsageBadge from "./UsageBadge.vue";

/** One row of either segment report -- already resolved to a display label by the caller
 * (`AdminView.vue` maps a `null` business/geo to `"Unspecified"` before passing rows here), so
 * this component stays reusable for both `by-business` and `by-geo` (docs/06-AGENTIC-CHAT.md
 * Phase 7, US-6). */
export interface ReportRow {
  /** The segment's display label. */
  label: string;
  /** Summed totals for every chat owned by a user in this segment. */
  usage: ChatUsageSummary;
}

/** Properties supplied to a segment report table. */
interface Props {
  /** The column header naming what {@link ReportRow.label} identifies (`"Business"`/`"Geo"`). */
  labelHeader: string;
  /** Rows to render, already ranked by total cost descending by the caller. */
  rows: readonly ReportRow[];
}

defineProps<Props>();
</script>

<template>
  <p v-if="rows.length === 0" class="empty-state">No usage recorded yet.</p>
  <table v-else class="admin-report-table">
    <thead>
      <tr>
        <th scope="col">{{ labelHeader }}</th>
        <th scope="col">Cost</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in rows" :key="row.label">
        <th scope="row">{{ row.label }}</th>
        <td>
          <UsageBadge compact :usage="row.usage" />
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.admin-report-table {
  border-collapse: collapse;
  width: 100%;
}

th,
td {
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
  padding: 0.5rem 0.75rem;
  text-align: start;
  vertical-align: middle;
}

thead th {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
  text-transform: uppercase;
}

tbody th[scope="row"] {
  color: rgb(var(--v-theme-on-surface));
  font-weight: 600;
}

.empty-state {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
}
</style>
