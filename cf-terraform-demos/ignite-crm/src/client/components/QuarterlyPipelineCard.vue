<script setup lang="ts">
/**
 * The quarterly pipeline report: open deals expected to close in one calendar quarter, totalled by
 * stage, with the deals listed by expected close date. The quarter is chosen from the previous,
 * current, and next two quarters around today and kept in the URL (`?quarter=2026-Q4`), so a
 * quarter can be bookmarked; the owner filter is shared with the Sales pipeline card. Loads on its
 * own, so a failure here never hides the other reports.
 */
import { computed, onMounted, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useFormat } from '../composables/useFormat.ts';
import { useResource } from '../composables/useResource.ts';
import { api } from '../services/api-client.ts';
import ResourceState from './ResourceState.vue';

const props = defineProps<{
  /**
   * Deal owner filter shared with the pipeline card, or `null` for everyone.
   */
  ownerId: string | null;
}>();

const route = useRoute();
const router = useRouter();
const format = useFormat();

/**
 * The selected quarter from the URL, or `null` for "the current quarter" (decided by the server in
 * the installation's time zone).
 */
const quarter = computed(() =>
  typeof route.query.quarter === 'string' && /^\d{4}-Q[1-4]$/u.test(route.query.quarter)
    ? route.query.quarter
    : null
);

const report = useResource((signal) =>
  api.quarterlyPipeline(
    {
      ...(quarter.value === null ? {} : { quarter: quarter.value }),
      ...(props.ownerId === null ? {} : { ownerId: props.ownerId })
    },
    signal
  )
);

/**
 * Shift a `YYYY-Qn` quarter id by a number of quarters.
 *
 * @param id The quarter.
 * @param by Quarters to move (negative for earlier).
 * @returns The shifted quarter id.
 */
function shiftQuarter(id: string, by: number): string {
  const index = Number(id.slice(0, 4)) * 4 + Number(id.slice(6)) - 1 + by;
  return `${Math.floor(index / 4)}-Q${(index % 4) + 1}`;
}

/**
 * The current quarter as the server reports it (in the installation's time zone), remembered from
 * the first load without an explicit quarter, so the choices stay anchored on "now" rather than
 * sliding with each selection.
 */
const current = shallowRef<string | null>(null);
watch(
  () => report.data.value,
  (data) => {
    if (data !== null && quarter.value === null) {
      current.value = data.quarter.id;
    }
  }
);

/**
 * Quarter choices: the previous, current, and next two quarters, plus a bookmarked quarter outside
 * that range when one is selected.
 */
const quarterItems = computed(() => {
  const anchor = current.value ?? report.data.value?.quarter.id;
  if (anchor === undefined) {
    return [];
  }
  const ids = [-1, 0, 1, 2].map((by) => shiftQuarter(anchor, by));
  const selected = report.data.value?.quarter.id;
  if (selected !== undefined && !ids.includes(selected)) {
    ids.push(selected);
    ids.sort();
  }
  return ids.map((id) => ({ title: `Q${id.slice(6)} ${id.slice(0, 4)}`, value: id }));
});

/**
 * Select a quarter, keeping the other report filters in the URL.
 *
 * @param id The quarter id.
 */
async function choose(id: string): Promise<void> {
  await router.replace({ query: { ...route.query, quarter: id } });
}

watch([quarter, () => props.ownerId], () => void report.load());
onMounted(() => void report.load());
</script>

<template>
  <v-card class="mb-6">
    <v-card-title><h2 id="quarterly-title" class="text-h6">Quarterly pipeline</h2></v-card-title>
    <v-card-text>
      <p class="text-body-2 text-medium-emphasis mb-3">
        Open deals with an expected close date in the quarter, by stage. Deals without an expected
        close date are not counted.
      </p>
      <v-row density="compact" role="group" aria-label="Quarterly pipeline filters">
        <v-col cols="12" sm="4">
          <v-select
            :model-value="report.data.value?.quarter.id ?? null"
            :items="quarterItems"
            label="Quarter"
            hide-details
            @update:model-value="(value: string) => choose(value)"
          />
        </v-col>
      </v-row>
    </v-card-text>
    <ResourceState
      :state="report.state.value"
      :error="report.error.value"
      :has-data="report.data.value !== null"
      skeleton="table"
      @retry="report.load"
    >
      <template v-if="report.data.value">
        <v-table
          density="comfortable"
          aria-labelledby="quarterly-title"
          data-testid="quarterly-stages"
          :aria-busy="report.state.value === 'loading'"
        >
          <caption class="text-left px-4 text-body-2">
            {{
              report.data.value.quarter.label
            }}:
            {{
              format.date(report.data.value.quarter.from)
            }}
            –
            {{
              format.date(report.data.value.quarter.to)
            }}
          </caption>
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col" class="text-right">Deals</th>
              <th scope="col" class="text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in report.data.value.stages" :key="row.stage.id">
              <th scope="row" class="font-weight-regular">{{ row.stage.label }}</th>
              <td class="text-right">{{ format.count(row.count) }}</td>
              <td class="text-right">{{ format.money(row.amountMinor) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Quarter total</th>
              <td class="text-right font-weight-bold">
                {{ format.count(report.data.value.total.count) }}
              </td>
              <td class="text-right font-weight-bold">
                {{ format.money(report.data.value.total.amountMinor) }}
              </td>
            </tr>
          </tfoot>
        </v-table>
        <v-table density="compact" aria-label="Deals expected to close" class="mt-4">
          <thead>
            <tr>
              <th scope="col">Deal</th>
              <th scope="col">Stage</th>
              <th scope="col">Expected close</th>
              <th scope="col">Owner</th>
              <th scope="col" class="text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="deal in report.data.value.deals" :key="deal.id">
              <td>
                <router-link :to="{ name: 'deal', params: { id: deal.id } }">{{
                  deal.title
                }}</router-link>
              </td>
              <td>{{ deal.stage.label }}</td>
              <td>{{ format.date(deal.expectedCloseDate ?? '') }}</td>
              <td>{{ deal.owner.displayName }}</td>
              <td class="text-right">{{ format.money(deal.amountMinor) }}</td>
            </tr>
            <tr v-if="report.data.value.deals.length === 0">
              <td colspan="5" class="text-medium-emphasis">
                No open deals are expected to close in this quarter.
              </td>
            </tr>
          </tbody>
        </v-table>
        <v-card-text v-if="report.data.value.truncated" class="text-body-2">
          Showing the first {{ report.data.value.deals.length }} deals by expected close date; the
          totals above include every matching deal.
        </v-card-text>
      </template>
    </ResourceState>
  </v-card>
</template>
