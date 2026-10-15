<script setup lang="ts">
import type { DocumentationSource } from '../../worker/domain/documentation';
import type { FaqIndexJob } from '../../worker/domain/index-job';
import type { FreshnessCounts } from '../stores';

const props = defineProps<{
  /**
   * Approved documentation pages and their indexing state.
   */
  sources: DocumentationSource[];
  /**
   * Recent index jobs.
   */
  jobs: FaqIndexJob[];
  /**
   * Job counts by state.
   */
  counts: FreshnessCounts;
  /**
   * Whether a request is in flight, which disables the actions.
   */
  busy: boolean;
}>();

const emit = defineEmits<{
  /**
   * Import the committed documentation manifest.
   */
  importDocumentation: [];
  /**
   * Run the pending index jobs once.
   */
  runIndexJobs: [];
}>();
</script>

<template>
  <section aria-labelledby="freshness-heading">
    <h2 id="freshness-heading">Index freshness</h2>
    <!--
      The counts answer the question this view exists for: is anything published but not yet
      searchable? Both the number and the word are given, so the state is never carried by colour
      alone.
    -->
    <dl class="counts">
      <div>
        <dt>Pending</dt>
        <dd>{{ props.counts.pending }}</dd>
      </div>
      <div>
        <dt>Indexed</dt>
        <dd>{{ props.counts.indexed }}</dd>
      </div>
      <div>
        <dt>Failed</dt>
        <dd>{{ props.counts.failed }}</dd>
      </div>
    </dl>
    <div class="actions">
      <button type="button" :disabled="props.busy" @click="emit('importDocumentation')">
        Import approved documentation
      </button>
      <button type="button" :disabled="props.busy" @click="emit('runIndexJobs')">
        Run pending index jobs
      </button>
    </div>

    <h3>Approved documentation</h3>
    <p v-if="props.sources.length === 0" class="empty">
      No documentation imported yet. Import the committed manifest to begin.
    </p>
    <div v-else class="scroller">
      <table>
        <caption class="visually-hidden">
          Approved documentation pages and their indexing state
        </caption>
        <thead>
          <tr>
            <th scope="col">Page</th>
            <th scope="col">Product</th>
            <th scope="col">Status</th>
            <th scope="col">Attempts</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="source in props.sources" :key="source.path">
            <th scope="row">{{ source.title }}</th>
            <td>{{ source.productId ?? '—' }}</td>
            <td>{{ source.indexStatus }}</td>
            <td>{{ source.attempts }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <h3>FAQ index jobs</h3>
    <p v-if="props.jobs.length === 0" class="empty">No index jobs yet.</p>
    <div v-else class="scroller">
      <table>
        <caption class="visually-hidden">
          FAQ index jobs and their state
        </caption>
        <thead>
          <tr>
            <th scope="col">FAQ</th>
            <th scope="col">Revision</th>
            <th scope="col">Operation</th>
            <th scope="col">Status</th>
            <th scope="col">Attempts</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="job in props.jobs" :key="job.id">
            <th scope="row" class="identifier">{{ job.faqId }}</th>
            <td>{{ job.faqRevision }}</td>
            <td>{{ job.operation }}</td>
            <td>{{ job.status }}</td>
            <td>{{ job.attempts }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.counts {
  display: flex;
  flex-wrap: wrap;
  gap: 1.5rem;
  margin: 0 0 1rem;
}
.counts div {
  border: 1px solid #d0d7de;
  border-radius: 0.5rem;
  min-width: 7rem;
  padding: 0.75rem 1rem;
}
dt {
  color: #4b5563;
  font-weight: 600;
}
dd {
  font-size: 1.5rem;
  font-weight: 700;
  margin: 0;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 1.5rem;
}
button {
  background: #fff;
  border: 1px solid #0051c3;
  border-radius: 0.25rem;
  color: #0051c3;
  cursor: pointer;
  font: inherit;
  font-weight: 600;
  min-height: 2.75rem;
  padding: 0.5rem 1rem;
}
button:disabled {
  border-color: #6b7280;
  color: #6b7280;
  cursor: not-allowed;
}
/* The table is given its own horizontal scroll rather than letting the page scroll sideways. */
.scroller {
  overflow-x: auto;
}
table {
  border-collapse: collapse;
  width: 100%;
}
th,
td {
  border-bottom: 1px solid #d0d7de;
  padding: 0.5rem 0.75rem;
  text-align: left;
}
thead th {
  border-bottom-width: 2px;
}
.identifier {
  font-family: ui-monospace, monospace;
  font-weight: 400;
}
.empty {
  color: #4b5563;
}
.visually-hidden {
  clip-path: inset(50%);
  height: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
  width: 1px;
}
</style>
