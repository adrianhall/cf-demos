<script setup lang="ts">
/**
 * Reports: sales health (deal counts and value by stage, plus won and lost) and delivery health
 * (task counts by status across projects), each with a few bounded filters.
 *
 * Every role with `report.read` may open this page; the API decides. Filters live in the URL so a
 * filtered report can be bookmarked or shared, and each report loads independently so one failing
 * does not hide the other. Built from Vuetify's `VTable`, `VSelect`, `VTextField` (native date
 * inputs, which give every browser an accessible date picker), `VProgressLinear` for the per-status
 * bars, and `VAlert`. Server field errors for an invalid window appear on the date field.
 */
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { UserRef } from '../../shared/api/crm.ts';
import { TASK_STATUSES } from '../../shared/api/projects.ts';
import { DELIVERY_REPORT_STATUSES } from '../../shared/api/reports.ts';
import ResourceState from '../components/ResourceState.vue';
import { TASK_STATUS_LABELS } from '../components/taskLabels.ts';
import { useFormat } from '../composables/useFormat.ts';
import { useResource } from '../composables/useResource.ts';
import { api } from '../services/api-client.ts';

const route = useRoute();
const router = useRouter();
const format = useFormat();

/**
 * A string query parameter, or `null`.
 *
 * @param name Parameter name.
 * @returns Its value when it is a non-empty string.
 */
function query(name: string): string | null {
  const value = route.query[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

const ownerId = ref<string | null>(query('ownerId'));
const closedFrom = ref<string | null>(query('closedFrom'));
const closedTo = ref<string | null>(query('closedTo'));
const projectStatus = ref<(typeof DELIVERY_REPORT_STATUSES)[number]>(
  (DELIVERY_REPORT_STATUSES as readonly string[]).includes(query('projectStatus') ?? '')
    ? (query('projectStatus') as (typeof DELIVERY_REPORT_STATUSES)[number])
    : 'active'
);
const leadId = ref<string | null>(query('leadId'));
const people = shallowRef<UserRef[]>([]);

/**
 * The defined filters, for the URL and the API.
 *
 * @param values Candidate values.
 * @returns Non-empty values only.
 */
function defined(values: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => !!entry[1])
  );
}

const pipelineFilter = computed(() =>
  defined({ ownerId: ownerId.value, closedFrom: closedFrom.value, closedTo: closedTo.value })
);
const deliveryFilter = computed(() => ({
  projectStatus: projectStatus.value,
  ...defined({ leadId: leadId.value })
}));

const pipeline = useResource((signal) => api.pipelineReport(pipelineFilter.value, signal));
const delivery = useResource((signal) => api.deliveryReport(deliveryFilter.value, signal));

const dateError = computed(() => {
  const fields = pipeline.error.value?.problem?.fields;
  return fields?.closedTo ?? fields?.closedFrom ?? null;
});

const peopleItems = computed(() =>
  people.value.map((person) => ({ title: person.displayName, value: person.id }))
);
const statusItems = [
  { title: 'Active', value: 'active' },
  { title: 'On hold', value: 'on_hold' },
  { title: 'Completed', value: 'completed' }
];

/**
 * Share of a total, for a progress bar.
 *
 * @param part The part.
 * @param whole The total.
 * @returns A percentage from 0 to 100.
 */
function share(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

const totalTasks = computed(() => {
  const counts = delivery.data.value?.taskCounts;
  return counts === undefined ? 0 : TASK_STATUSES.reduce((sum, status) => sum + counts[status], 0);
});

watch(pipelineFilter, async () => {
  await router.replace({ query: { ...pipelineFilter.value, ...defined(deliveryFilter.value) } });
  await pipeline.load();
});
watch(deliveryFilter, async () => {
  await router.replace({ query: { ...pipelineFilter.value, ...defined(deliveryFilter.value) } });
  await delivery.load();
});

onMounted(() => {
  void pipeline.load();
  void delivery.load();
  // Owner and lead filters choose from active teammates; anyone with report.read may list them.
  void api
    .assignees()
    .then((loaded) => {
      people.value = loaded;
    })
    .catch(() => {
      people.value = [];
    });
});
</script>

<template>
  <section aria-labelledby="reports-title">
    <h1 id="reports-title" class="text-h4 mb-1">Reports</h1>
    <p class="text-medium-emphasis mb-4">
      Sales and delivery health at a glance. Amounts are in the installation currency.
    </p>

    <v-card class="mb-6">
      <v-card-title><h2 class="text-h6">Sales pipeline</h2></v-card-title>
      <v-card-text>
        <v-row density="compact" role="group" aria-label="Pipeline filters">
          <v-col cols="12" sm="4">
            <v-select
              v-model="ownerId"
              :items="peopleItems"
              label="Deal owner"
              clearable
              hide-details
            />
          </v-col>
          <v-col cols="12" sm="4">
            <v-text-field
              v-model="closedFrom"
              type="date"
              label="Closed from"
              clearable
              hint="Narrows won and lost only"
              persistent-hint
            />
          </v-col>
          <v-col cols="12" sm="4">
            <v-text-field
              v-model="closedTo"
              type="date"
              label="Closed to"
              clearable
              :error-messages="dateError ? [dateError] : []"
            />
          </v-col>
        </v-row>
      </v-card-text>
      <ResourceState
        :state="dateError ? 'success' : pipeline.state.value"
        :error="pipeline.error.value"
        :has-data="pipeline.data.value !== null"
        skeleton="table"
        @retry="pipeline.load"
      >
        <v-table
          v-if="pipeline.data.value"
          density="comfortable"
          aria-label="Pipeline by stage"
          :aria-busy="pipeline.state.value === 'loading'"
        >
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col" class="text-right">Deals</th>
              <th scope="col" class="text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in pipeline.data.value.stages" :key="row.stage.id">
              <th scope="row" class="font-weight-regular">{{ row.stage.label }}</th>
              <td class="text-right">{{ format.count(row.count) }}</td>
              <td class="text-right">{{ format.money(row.amountMinor) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Open pipeline</th>
              <td class="text-right font-weight-bold">
                {{ format.count(pipeline.data.value.open.count) }}
              </td>
              <td class="text-right font-weight-bold">
                {{ format.money(pipeline.data.value.open.amountMinor) }}
              </td>
            </tr>
            <tr>
              <th scope="row" class="font-weight-regular">Won</th>
              <td class="text-right">{{ format.count(pipeline.data.value.won.count) }}</td>
              <td class="text-right">{{ format.money(pipeline.data.value.won.amountMinor) }}</td>
            </tr>
            <tr>
              <th scope="row" class="font-weight-regular">Lost</th>
              <td class="text-right">{{ format.count(pipeline.data.value.lost.count) }}</td>
              <td class="text-right">{{ format.money(pipeline.data.value.lost.amountMinor) }}</td>
            </tr>
          </tfoot>
        </v-table>
      </ResourceState>
    </v-card>

    <v-card>
      <v-card-title><h2 class="text-h6">Delivery</h2></v-card-title>
      <v-card-text>
        <v-row density="compact" role="group" aria-label="Delivery filters">
          <v-col cols="12" sm="6">
            <v-select v-model="projectStatus" :items="statusItems" label="Projects" hide-details />
          </v-col>
          <v-col cols="12" sm="6">
            <v-select
              v-model="leadId"
              :items="peopleItems"
              label="Project lead"
              clearable
              hide-details
            />
          </v-col>
        </v-row>
      </v-card-text>
      <ResourceState
        :state="delivery.state.value"
        :error="delivery.error.value"
        :has-data="delivery.data.value !== null"
        :empty="delivery.data.value?.projectCount === 0"
        empty-title="No matching projects"
        empty-text="Projects are created by converting a won deal."
        skeleton="table"
        @retry="delivery.load"
      >
        <template v-if="delivery.data.value">
          <v-card-text class="pt-0">
            <p class="text-body-1 mb-3">
              {{ format.count(delivery.data.value.projectCount) }}
              {{ delivery.data.value.projectCount === 1 ? 'project' : 'projects' }},
              {{ format.count(totalTasks) }} tasks,
              <strong>{{ format.count(delivery.data.value.overdue) }} overdue</strong>
            </p>
            <div
              v-for="status in TASK_STATUSES"
              :key="status"
              class="d-flex align-center ga-3 mb-2"
            >
              <span class="status-label text-body-2">{{ TASK_STATUS_LABELS[status] }}</span>
              <v-progress-linear
                :model-value="share(delivery.data.value.taskCounts[status], totalTasks)"
                height="10"
                rounded
                color="primary-strong"
                :aria-label="`${TASK_STATUS_LABELS[status]}: ${delivery.data.value.taskCounts[status]} of ${totalTasks} tasks`"
              />
              <span class="text-body-2 text-right status-count">{{
                format.count(delivery.data.value.taskCounts[status])
              }}</span>
            </div>
          </v-card-text>
          <v-table density="comfortable" aria-label="Delivery by project">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Lead</th>
                <th v-for="status in TASK_STATUSES" :key="status" scope="col" class="text-right">
                  {{ TASK_STATUS_LABELS[status] }}
                </th>
                <th scope="col" class="text-right">Overdue</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in delivery.data.value.projects" :key="row.project.id">
                <th scope="row" class="font-weight-regular">
                  <router-link :to="{ name: 'project', params: { id: row.project.id } }">{{
                    row.project.name
                  }}</router-link>
                </th>
                <td>{{ row.lead.displayName }}</td>
                <td v-for="status in TASK_STATUSES" :key="status" class="text-right">
                  {{ format.count(row.taskCounts[status]) }}
                </td>
                <td class="text-right" :class="{ 'text-error font-weight-bold': row.overdue > 0 }">
                  {{ format.count(row.overdue) }}
                </td>
              </tr>
            </tbody>
          </v-table>
          <v-card-text v-if="delivery.data.value.truncated" class="text-body-2">
            Showing the {{ delivery.data.value.projects.length }} projects with the most open work;
            the totals above include every matching project.
          </v-card-text>
        </template>
      </ResourceState>
    </v-card>
  </section>
</template>

<style scoped>
.status-label {
  min-width: 6.5rem;
}

.status-count {
  min-width: 2.5rem;
}
</style>
