<script setup lang="ts">
import { onMounted } from "vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ReviewHistoryList from "../components/ReviewHistoryList.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ReviewTriggerForm from "../components/ReviewTriggerForm.vue";
import { useReviewsStore } from "../stores/reviews";

/**
 * The landing page: the "Review a PR/MR" trigger form and the paginated review history
 * (docs/07-PR-REVIEW-AGENT.md, Implementation Plan Phase 6, item 25). Kept as ONE view rather
 * than two separate routes: the scenario doc itself frames these as one page's two pieces ("A
 * 'Review a PR/MR' form ... A paginated history list"), and splitting them across routes would
 * add navigation with no real benefit for a demo whose whole point is watching a just-triggered
 * run immediately appear at the top of the very same list. This view itself stays a thin
 * composition surface (per `vue-best-practices`'s "entry/root and route view" rule) -- the form
 * and the list are each their own focused component, and this view owns only the one piece of
 * state (the history list itself) that both do not already own individually.
 */
const reviewsStore = useReviewsStore();

onMounted(() => void reviewsStore.loadHistory(1));

function handlePageChange(page: number): void {
  void reviewsStore.loadHistory(page);
}
</script>

<template>
  <v-container class="home-view">
    <section aria-label="Review a PR/MR">
      <h1>Review a PR/MR</h1>
      <ReviewTriggerForm />
    </section>

    <section aria-label="Review history" class="history-section">
      <h2>Review History</h2>
      <ReviewHistoryList
        :error="reviewsStore.error"
        :loading="reviewsStore.loading"
        :page="reviewsStore.page"
        :page-size="reviewsStore.pageSize"
        :runs="reviewsStore.runs"
        :total="reviewsStore.total"
        @update:page="handlePageChange"
      />
    </section>
  </v-container>
</template>

<style scoped>
.home-view {
  display: flex;
  flex-direction: column;
  gap: 2rem;
  max-width: 56rem;
  padding-block: 1.5rem;
}

h1 {
  font-size: 1.5rem;
  margin: 0 0 1rem;
}

.history-section h2 {
  font-size: 1.25rem;
  margin: 0 0 1rem;
}
</style>
