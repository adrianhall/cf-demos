<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { DashboardMetrics } from '../../worker/domain/dashboard';
import { requestJson } from '../api';

const metrics = ref<DashboardMetrics | null>(null);
const error = ref('');
const loading = ref(false);

/**
 * Format a duration as a bounded, readable operational measure.
 */
function duration(value: number | null): string {
  if (value === null) return 'No completed items';
  const minutes = Math.round(value / 60_000);
  return minutes < 60 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`;
}

/**
 * Metrics that are safe to render as a compact definition list.
 */
const cards = computed(() => {
  if (metrics.value === null) return [];
  return [
    ['Open queue', String(metrics.value.openCount)],
    ['Average queue age', duration(metrics.value.averageQueueAgeMs)],
    ['Oldest queue item', duration(metrics.value.oldestQueueAgeMs)],
    ['First-answer time', duration(metrics.value.averageFirstAnswerMs)],
    ['Resolution time', duration(metrics.value.averageResolutionMs)],
    ['Reassignments', String(metrics.value.reassignmentCount)],
    ['Rejections', String(metrics.value.rejectionCount)],
    ['FAQs needing review', String(metrics.value.staleFaqCount)],
    ['Index backlog', String(metrics.value.indexingBacklog)],
    ['Failed index jobs', String(metrics.value.failedIndexJobs)]
  ];
});

/**
 * Load the caller-scoped D1 dashboard without retaining prior data after an authorization failure.
 */
async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    metrics.value = (await requestJson<{ metrics: DashboardMetrics }>('/api/dashboard')).metrics;
  } catch (reason: unknown) {
    metrics.value = null;
    error.value = reason instanceof Error ? reason.message : 'The dashboard could not be loaded.';
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <section aria-labelledby="dashboard-heading">
    <div class="heading-row">
      <div>
        <p class="eyebrow">Operational dashboard</p>
        <h1 id="dashboard-heading">Web workflow health</h1>
      </div>
      <button type="button" :disabled="loading" @click="load">Refresh metrics</button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p class="status" role="status">{{ loading ? 'Loading dashboard…' : '' }}</p>
    <dl v-if="metrics" class="metrics">
      <div v-for="([label, value], index) in cards" :key="index" class="metric">
        <dt>{{ label }}</dt>
        <dd>{{ value }}</dd>
      </div>
    </dl>
    <table v-if="metrics" class="products">
      <caption>
        Open queue by product
      </caption>
      <thead>
        <tr>
          <th scope="col">Product</th>
          <th scope="col">Open escalations</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="product in metrics.byProduct" :key="product.productId">
          <td>{{ product.productId }}</td>
          <td>{{ product.openCount }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.heading-row {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  justify-content: space-between;
}
.eyebrow,
.status {
  margin: 0;
}
.metrics {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
}
.metric {
  border-left: 4px solid #0051c3;
  padding: 0.5rem 0.75rem;
}
.metric dt {
  font-weight: 700;
}
.metric dd {
  font-size: 1.2rem;
  margin: 0.25rem 0 0;
}
.products {
  border-collapse: collapse;
  max-width: 35rem;
  width: 100%;
}
.products th,
.products td {
  border: 1px solid #718096;
  padding: 0.5rem;
  text-align: left;
}
.error {
  color: #b42318;
  font-weight: 600;
}
button {
  min-height: 2.75rem;
}
</style>
