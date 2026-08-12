<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { useRoute } from "vue-router";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ReviewerStatusBadge from "../components/ReviewerStatusBadge.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ReviewReport from "../components/ReviewReport.vue";
import { type ReviewRunEvent, useReviewRun } from "../composables/useReviewRun";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import { formatTimestamp } from "../lib/format";
import {
  ROLE_LABELS,
  RUN_STATUS_COLORS,
  RUN_STATUS_LABELS,
} from "../lib/format";
import {
  type ReviewerCostSource,
  type ReviewerRole,
  type ReviewerStatus,
  useReviewsStore,
} from "../stores/reviews";

/**
 * One run's detail page (docs/07-PR-REVIEW-AGENT.md, Implementation Plan Phase 6, item 25):
 * live reviewer badges while a run is in progress, and the full report once it completes.
 * Combines two data sources with different lifetimes, per Implementation Plan Phase 6, item
 * 27's own "state/broadcast in the composable, static REST data in the store" division:
 * `useReviewRun` (this run's live `state`/broadcast `events`, consumed directly here -- never
 * funneled through Pinia) and `useReviewsStore.detail` (the REST-fetched static snapshot,
 * including data the live `state` never carries at all -- `skippedReason`/`errorDetail`/the full
 * Markdown report; see {@link reviewerViewModels}'s own doc comment).
 */
const route = useRoute();
const reviewsStore = useReviewsStore();

const runId = computed(() => route.params.id as string);

const { state, connectionStatus, events } = useReviewRun(runId);

onMounted(() => void reviewsStore.loadDetail(runId.value));
watch(runId, (id) => void reviewsStore.loadDetail(id));

/** `true` once `GET /api/reviews/:id` has confirmed there is no such run -- gates the entire
 * live/report section off, so a made-up id never renders empty badges or a blank report next to
 * its own "not found" message. */
const notFound = computed(() => reviewsStore.detailError !== null);

const REVIEWER_ROLE_ORDER: readonly ReviewerRole[] = [
  "code-quality",
  "accessibility",
  "architecture",
  "security",
];

/** One reviewer's badge-ready view model, merging whichever of live/REST data is available for
 * it. */
interface ReviewerViewModel {
  readonly role: ReviewerRole;
  readonly status: ReviewerStatus;
  readonly costUsd: number | null;
  readonly costSource: ReviewerCostSource;
  readonly findingCount: number;
  readonly skippedReason: string | null;
  readonly errorDetail: string | null;
}

/**
 * Merge this run's live `state.reviewers` (`ReviewerState` -- role/status/costUsd/costSource/
 * findingCount only) with its REST `detail.reviewers` (`ReviewerDetail` -- also
 * skippedReason/errorDetail/model/tokensIn/tokensOut) into one view model per role, preferring
 * the live value for every field the live shape actually carries (freshest during an in-progress
 * run) and falling back to REST for the two fields the live shape structurally never carries at
 * all: `skippedReason`/`errorDetail` are broadcast only transiently (`reviewer_skipped`/
 * `reviewer_failed` events -- see `../composables/useReviewRun.ts`'s own `ReviewerLifecycleEvent`
 * doc comment) and are never written into `ReviewRunState` itself
 * (`../../worker/review/progress.ts`'s `applyReviewerProgress()` confirms this: its
 * `"reviewer_skipped"`/`"reviewer_failed"` cases only ever set `status`), so a client that opens
 * this page *after* either transition already happened would see neither field at all without
 * this REST fallback.
 */
const reviewerViewModels = computed<ReviewerViewModel[]>(() => {
  const liveByRole = new Map(
    (state.value?.reviewers ?? []).map((reviewer) => [reviewer.role, reviewer]),
  );
  const restByRole = new Map(
    (reviewsStore.detail?.reviewers ?? []).map((reviewer) => [
      reviewer.role,
      reviewer,
    ]),
  );
  const knownRoles = REVIEWER_ROLE_ORDER.filter(
    (role) => liveByRole.has(role) || restByRole.has(role),
  );
  return knownRoles.map((role) => {
    const live = liveByRole.get(role);
    const rest = restByRole.get(role);
    return {
      role,
      status: live?.status ?? rest?.status ?? "queued",
      costUsd: live?.costUsd ?? rest?.costUsd ?? null,
      costSource: live?.costSource ?? rest?.costSource ?? "pending",
      findingCount: live?.findingCount ?? rest?.findingCount ?? 0,
      skippedReason: rest?.skippedReason ?? null,
      errorDetail: rest?.errorDetail ?? null,
    };
  });
});

/** The run's overall status -- prefers the live connection's own `state.status` (current the
 * moment it changes), falling back to the REST snapshot while the connection is still opening. */
const runStatus = computed(
  () => state.value?.status ?? reviewsStore.detail?.run.status ?? null,
);
const runStatusLabel = computed(() =>
  runStatus.value ? RUN_STATUS_LABELS[runStatus.value] : null,
);
const runStatusColor = computed(() =>
  runStatus.value ? RUN_STATUS_COLORS[runStatus.value] : null,
);

/** A single short sentence describing one broadcast event, for the shared live-region announcer
 * below -- deliberately one sentence per transition, never a restatement of the whole page's
 * current state (docs/07-PR-REVIEW-AGENT.md, Implementation Plan Phase 6, item 25:
 * "live-region announcements for reviewer status transitions without re-announcing the whole
 * page on every update"). */
function describeEvent(event: ReviewRunEvent): string {
  const label = "role" in event ? ROLE_LABELS[event.role] : "";
  switch (event.type) {
    case "reviewer_started":
      return `${label} review started.`;
    case "reviewer_completed":
      return `${label} review completed with ${event.findingCount ?? 0} finding${event.findingCount === 1 ? "" : "s"}.`;
    case "reviewer_skipped":
      return `${label} review skipped${event.skippedReason ? `: ${event.skippedReason}` : "."}`;
    case "reviewer_failed":
      return `${label} review failed${event.errorDetail ? `: ${event.errorDetail}` : "."}`;
    case "cost_reconciled":
      return `${label} cost confirmed by AI Gateway.`;
    case "review_completed":
      return "Review completed.";
    case "review_failed":
      return `Review failed: ${event.detail}`;
  }
}

/** The most recent event's own announcement sentence -- the single visually-hidden live region
 * below only ever holds this one sentence at a time, so assistive technology announces exactly
 * one transition per update. */
const announcement = computed(() => {
  const latest = events.value.at(-1);
  return latest ? describeEvent(latest) : "";
});
</script>

<template>
  <v-container class="review-detail-view">
    <p class="sr-only" aria-live="polite" role="status">{{ announcement }}</p>

    <p v-if="reviewsStore.detailLoading">Loading this run…</p>
    <template v-else-if="notFound">
      <h1>Run not found</h1>
      <p>{{ reviewsStore.detailError }}</p>
      <router-link to="/">Back to review history</router-link>
    </template>
    <template v-else-if="reviewsStore.detail">
      <header class="run-header">
        <div>
          <h1>{{ reviewsStore.detail.run.repoFullName }} #{{ reviewsStore.detail.run.prNumber }}</h1>
          <p class="pr-title">{{ reviewsStore.detail.run.prTitle }}</p>
        </div>
        <v-chip v-if="runStatusLabel" :color="runStatusColor" size="large">
          {{ runStatusLabel }}
        </v-chip>
      </header>

      <p v-if="connectionStatus === 'connecting'" class="connection-notice">
        Connecting to live updates…
      </p>
      <p v-else-if="connectionStatus === 'error'" class="connection-notice notice-error" role="alert">
        Live updates are unavailable right now. This run's status will still refresh if you reload the page.
      </p>

      <p v-if="runStatus === 'failed'" class="notice-error" role="alert">
        {{ reviewsStore.detail.run.errorDetail ?? "This review run failed." }}
      </p>

      <p v-if="reviewsStore.detail.run.commentUrl">
        <a :href="reviewsStore.detail.run.commentUrl" rel="noopener noreferrer" target="_blank">
          View the posted comment
        </a>
      </p>

      <section aria-label="Reviewer status" class="reviewer-badges">
        <ReviewerStatusBadge
          v-for="reviewer in reviewerViewModels"
          :key="reviewer.role"
          :cost-source="reviewer.costSource"
          :cost-usd="reviewer.costUsd"
          :error-detail="reviewer.errorDetail"
          :events="events"
          :finding-count="reviewer.findingCount"
          :role="reviewer.role"
          :skipped-reason="reviewer.skippedReason"
          :status="reviewer.status"
        />
      </section>

      <p class="timestamps">
        Started {{ formatTimestamp(reviewsStore.detail.run.createdAt) }}
        <template v-if="reviewsStore.detail.run.completedAt">
          · Completed {{ formatTimestamp(reviewsStore.detail.run.completedAt) }}
        </template>
      </p>

      <ReviewReport
        v-if="runStatus === 'completed'"
        :findings="reviewsStore.detail.findings"
        :full-report="reviewsStore.detail.run.fullReport"
      />
    </template>
  </v-container>
</template>

<style scoped>
.review-detail-view {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  max-width: 56rem;
  padding-block: 1.5rem;
}

.run-header {
  align-items: flex-start;
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  justify-content: space-between;
}

.run-header h1 {
  font-size: 1.375rem;
  margin: 0;
}

.pr-title {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0.25rem 0 0;
}

.reviewer-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
}

.timestamps {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
}

.connection-notice {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
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
