<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ReviewRunEvent } from "../composables/useReviewRun";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import {
  formatCost,
  REVIEWER_STATUS_COLORS,
  REVIEWER_STATUS_LABELS,
  ROLE_LABELS,
} from "../lib/format";
import type {
  ReviewerCostSource,
  ReviewerRole,
  ReviewerStatus,
} from "../stores/reviews";

/**
 * One reviewer's status badge (docs/07-PR-REVIEW-AGENT.md, Implementation Plan Phase 6, item 25:
 * "four reviewer status badges ... each showing its live status and cost"). Renders from
 * whichever of live (`useReviewRun`) or REST (`useReviewsStore.detail`) data
 * `ReviewDetailView.vue` currently has for this reviewer -- this component itself is agnostic
 * to which source a given prop value came from.
 */
interface Props {
  role: ReviewerRole;
  status: ReviewerStatus;
  costUsd: number | null;
  costSource: ReviewerCostSource;
  /** Populated only when `status` is `"skipped"` -- shown verbatim so a skipped Accessibility
   * pass reads as "skipped because no changed file was UI-relevant," not merely absent
   * (docs/07-PR-REVIEW-AGENT.md, Implementation Plan Phase 6, item 25: "show why, not just its
   * absence"). */
  skippedReason: string | null;
  /** Populated only when `status` is `"error"`. */
  errorDetail: string | null;
  findingCount: number;
  /**
   * The full live event stream for this run (`useReviewRun`'s `events`), filtered internally to
   * just this reviewer's own transitions to drive a brief flash animation. Omit for a badge
   * rendered from REST-only history data with no live connection to animate against.
   */
  events?: readonly ReviewRunEvent[];
}

const props = withDefaults(defineProps<Props>(), { events: () => [] });

/** This reviewer's own most recent broadcast event, or `null` if none has arrived on this
 * connection (either because nothing has happened yet, or because {@link Props.events} was
 * never supplied at all). */
const lastOwnEvent = computed(() => {
  const matching = props.events.filter(
    (event): event is ReviewRunEvent & { role: ReviewerRole } =>
      "role" in event && event.role === props.role,
  );
  return matching.at(-1) ?? null;
});

/** Briefly `true` right after a fresh event for this reviewer arrives, to play a subtle flash
 * animation -- the badge transition animation docs/07-PR-REVIEW-AGENT.md, Implementation Plan
 * Phase 6, item 25 and item 26 both call for. Disabled entirely under `prefers-reduced-motion`
 * (this component's own `<style>`), so the animation itself never becomes the accessibility
 * concern it exists to avoid being. */
const flashing = ref(false);
let flashTimeout: ReturnType<typeof setTimeout> | undefined;

watch(lastOwnEvent, (event, previous) => {
  if (event === null || event.receivedAt === previous?.receivedAt) {
    return;
  }
  clearTimeout(flashTimeout);
  flashing.value = true;
  flashTimeout = setTimeout(() => {
    flashing.value = false;
  }, 1200);
});

/** Pluralize "finding"/"findings" for the done-state detail line. */
function findingsLabel(count: number): string {
  return `${count} finding${count === 1 ? "" : "s"}`;
}
</script>

<template>
  <v-card
    class="reviewer-badge"
    :class="{ flashing }"
    :title="ROLE_LABELS[role]"
    variant="outlined"
  >
    <v-card-text>
      <div class="badge-header">
        <span class="role-label">{{ ROLE_LABELS[role] }}</span>
        <v-chip :color="REVIEWER_STATUS_COLORS[status]" size="small">
          {{ REVIEWER_STATUS_LABELS[status] }}
        </v-chip>
      </div>
      <p v-if="status === 'skipped'" class="detail-text">
        {{ skippedReason ?? "Skipped." }}
      </p>
      <p v-else-if="status === 'error'" class="detail-text">
        {{ errorDetail ?? "This reviewer failed." }}
      </p>
      <p v-else-if="status === 'done'" class="detail-text">
        {{ findingsLabel(findingCount) }}
      </p>
      <p v-if="status === 'done' || status === 'running'" class="cost-text">
        {{ formatCost(costUsd, costSource) }}
      </p>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.reviewer-badge {
  min-width: 12rem;
}

.badge-header {
  align-items: center;
  display: flex;
  gap: 0.5rem;
  justify-content: space-between;
}

.role-label {
  font-weight: 600;
}

.detail-text {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin-top: 0.375rem;
}

.cost-text {
  font-size: 0.8125rem;
  margin-top: 0.25rem;
}

.reviewer-badge.flashing {
  animation: reviewer-badge-flash 1.2s ease-out;
}

@keyframes reviewer-badge-flash {
  0% {
    background-color: rgb(var(--v-theme-primary), 0.15);
  }
  100% {
    background-color: transparent;
  }
}

@media (prefers-reduced-motion: reduce) {
  .reviewer-badge.flashing {
    animation: none;
  }
}
</style>
