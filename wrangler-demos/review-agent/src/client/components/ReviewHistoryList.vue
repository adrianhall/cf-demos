<script setup lang="ts">
import { computed } from "vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import {
  formatCost,
  formatTimestamp,
  RUN_STATUS_COLORS,
  RUN_STATUS_LABELS,
} from "../lib/format";
import type { ReviewRunSummary } from "../stores/reviews";

/**
 * The paginated review history list (docs/07-PR-REVIEW-AGENT.md, "API And Routing": `GET
 * /api/reviews`; Implementation Plan Phase 6, item 25) -- a plain, semantic `<table>` rather
 * than Vuetify's `VDataTable`: this list needs no sorting/filtering/selection, and hand-rolled
 * `<th scope="col">` headers plus a real `<caption>` keep every cell's column association
 * explicit for assistive technology with no extra configuration to get wrong.
 */
interface Props {
  /** This page's runs, newest first. */
  runs: readonly ReviewRunSummary[];
  /** `true` while the very first page load (or an explicit refresh) is in flight. */
  loading: boolean;
  /** A load failure's message, or `null`. */
  error: string | null;
  /** The currently loaded 1-indexed page. */
  page: number;
  pageSize: number;
  /** Total run count across every page -- used to compute the pagination control's length. */
  total: number;
}

/** Events emitted by the history list. */
interface Emits {
  /** Request a different page. */
  "update:page": [page: number];
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const pageCount = computed(() =>
  Math.max(1, Math.ceil(props.total / props.pageSize)),
);

/** A run's PR/MR label, distinguishing GitHub's "PR" from GitLab's "MR" terminology. */
function prLabel(run: ReviewRunSummary): string {
  const kind = run.provider === "github" ? "PR" : "MR";
  return `${kind} #${run.prNumber}`;
}
</script>

<template>
  <section aria-label="Review history">
    <p v-if="error" class="notice-error" role="alert">{{ error }}</p>
    <p v-else-if="loading && runs.length === 0">Loading review history…</p>
    <p v-else-if="runs.length === 0">
      No reviews yet. Paste a PR/MR URL above to start one.
    </p>
    <template v-else>
      <table class="history-table">
        <caption class="sr-only">Review history</caption>
        <thead>
          <tr>
            <th scope="col">Repository</th>
            <th scope="col">Pull/Merge Request</th>
            <th scope="col">Status</th>
            <th scope="col">Total cost</th>
            <th scope="col">Started</th>
            <th scope="col">Completed</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="run in runs" :key="run.id">
            <td>{{ run.repoFullName }}</td>
            <td>
              <router-link :to="`/reviews/${run.id}`">
                {{ prLabel(run) }}: {{ run.prTitle }}
              </router-link>
            </td>
            <td>
              <v-chip :color="RUN_STATUS_COLORS[run.status]" size="small">
                {{ RUN_STATUS_LABELS[run.status] }}
              </v-chip>
            </td>
            <td>{{ formatCost(run.totalCostUsd) }}</td>
            <td>{{ formatTimestamp(run.createdAt) }}</td>
            <td>{{ formatTimestamp(run.completedAt) }}</td>
          </tr>
        </tbody>
      </table>
      <v-pagination
        v-if="total > pageSize"
        aria-label="Review history pages"
        :length="pageCount"
        :model-value="page"
        @update:model-value="emit('update:page', $event)"
      />
    </template>
  </section>
</template>

<style scoped>
.history-table {
  border-collapse: collapse;
  width: 100%;
}

.history-table th,
.history-table td {
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
  padding: 0.5rem 0.75rem;
  text-align: left;
}

.notice-error {
  color: rgb(var(--v-theme-error));
  font-weight: 600;
}

.sr-only {
  border: 0;
  clip: rect(0, 0, 0, 0);
  height: 1px;
  margin: -1px;
  overflow: hidden;
  padding: 0;
  position: absolute;
  width: 1px;
}
</style>
