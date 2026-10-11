<script setup lang="ts">
/**
 * Dashboard: headline counts, the signed-in user's most urgent follow-ups, the pipeline summary
 * (for roles with `report.read`), and recently changed contacts. Each section loads independently,
 * so a failing report does not hide the user's worklist. Every pipeline row label links to the
 * Deals table filtered to exactly that row (stage rows to open deals in the stage, Won/Lost to that
 * outcome, the total to every open deal), so a count can always be checked against its deals.
 */
import { computed, onMounted } from 'vue';
import ActionStreamRow from '../components/ActionStreamRow.vue';
import ResourceState from '../components/ResourceState.vue';
import { useFormat } from '../composables/useFormat.ts';
import { useResource } from '../composables/useResource.ts';
import { useSession } from '../composables/useSession.ts';
import { api } from '../services/api-client.ts';

/**
 * Follow-ups shown on the dashboard before "See all".
 */
const DASHBOARD_ACTIONS = 5;

const { session, roleLabel, can } = useSession();
const format = useFormat();
const dashboard = useResource((signal) => api.dashboard(signal));
const actions = useResource((signal) => api.actionStream(signal));
const summary = useResource((signal) => api.pipelineReport({}, signal));
/**
 * The Deals table filtered to one pipeline-panel row.
 *
 * @param filter Outcome and, for a stage row, the stage id.
 * @returns A route location.
 */
function dealsList(filter: { status: 'pending' | 'won' | 'lost'; stage?: string }) {
  return {
    name: 'deals',
    query: { view: 'list', status: filter.status, ...(filter.stage ? { stage: filter.stage } : {}) }
  };
}

const topActions = computed(() => actions.data.value?.items.slice(0, DASHBOARD_ACTIONS) ?? []);

onMounted(() => {
  void dashboard.load();
  void actions.load();
  if (can('report.read')) {
    void summary.load();
  }
});
</script>

<template>
  <section aria-labelledby="dashboard-title">
    <h1 id="dashboard-title" class="text-h4 mb-1">Dashboard</h1>
    <p class="text-medium-emphasis mb-6">
      Signed in as {{ session?.user.displayName }} ({{ roleLabel }})
    </p>
    <ResourceState
      :state="dashboard.state.value"
      :error="dashboard.error.value"
      skeleton="card"
      @retry="dashboard.load"
    >
      <v-row>
        <v-col cols="12" sm="6">
          <v-card :to="{ name: 'contacts' }" variant="tonal" color="primary-strong">
            <v-card-text>
              <div class="text-h3">{{ format.count(dashboard.data.value?.contacts ?? 0) }}</div>
              <div class="text-subtitle-1">Contacts</div>
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" sm="6">
          <v-card :to="{ name: 'companies' }" variant="tonal" color="secondary-strong">
            <v-card-text>
              <div class="text-h3">{{ format.count(dashboard.data.value?.companies ?? 0) }}</div>
              <div class="text-subtitle-1">Companies</div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>
    </ResourceState>

    <v-row class="mt-2">
      <v-col cols="12" md="7">
        <v-card>
          <v-card-title class="d-flex align-center">
            <h2 class="text-h6 flex-grow-1">Your next actions</h2>
            <v-btn variant="text" :to="{ name: 'actions' }">See all</v-btn>
          </v-card-title>
          <ResourceState
            :state="actions.state.value"
            :error="actions.error.value"
            :empty="topActions.length === 0"
            empty-title="Nothing to chase"
            empty-text="Next actions you set on contacts and deals appear here."
            @retry="actions.load"
          >
            <v-list aria-label="Your next actions">
              <ActionStreamRow
                v-for="item in topActions"
                :key="`${item.kind}-${item.id}`"
                :item="item"
              />
            </v-list>
          </ResourceState>
        </v-card>
      </v-col>
      <v-col v-if="can('report.read')" cols="12" md="5">
        <v-card>
          <v-card-title class="d-flex align-center">
            <h2 id="pipeline-summary-title" class="text-h6 flex-grow-1">Pipeline summary</h2>
            <v-btn variant="text" :to="{ name: 'reports' }">Reports</v-btn>
          </v-card-title>
          <ResourceState
            :state="summary.state.value"
            :error="summary.error.value"
            skeleton="table"
            @retry="summary.load"
          >
            <v-table
              v-if="summary.data.value"
              density="compact"
              aria-labelledby="pipeline-summary-title"
              data-testid="pipeline-summary"
            >
              <thead>
                <tr>
                  <th scope="col">Stage</th>
                  <th scope="col" class="text-right">Deals</th>
                  <th scope="col" class="text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in summary.data.value.stages" :key="row.stage.id">
                  <th scope="row" class="font-weight-regular">
                    <router-link
                      :to="dealsList({ status: 'pending', stage: row.stage.id })"
                      :aria-label="`Show open deals in ${row.stage.label}`"
                      >{{ row.stage.label }}</router-link
                    >
                  </th>
                  <td class="text-right">{{ format.count(row.count) }}</td>
                  <td class="text-right">{{ format.money(row.amountMinor) }}</td>
                </tr>
                <tr>
                  <th scope="row">
                    <router-link
                      :to="dealsList({ status: 'pending' })"
                      aria-label="Show all open deals"
                      >Pipeline total</router-link
                    >
                  </th>
                  <td class="text-right font-weight-bold">
                    {{ format.count(summary.data.value.open.count) }}
                  </td>
                  <td class="text-right font-weight-bold">
                    {{ format.money(summary.data.value.open.amountMinor) }}
                  </td>
                </tr>
                <tr>
                  <th scope="row" class="font-weight-regular">
                    <router-link :to="dealsList({ status: 'won' })" aria-label="Show won deals"
                      >Won</router-link
                    >
                  </th>
                  <td class="text-right">{{ format.count(summary.data.value.won.count) }}</td>
                  <td class="text-right">{{ format.money(summary.data.value.won.amountMinor) }}</td>
                </tr>
                <tr>
                  <th scope="row" class="font-weight-regular">
                    <router-link :to="dealsList({ status: 'lost' })" aria-label="Show lost deals"
                      >Lost</router-link
                    >
                  </th>
                  <td class="text-right">{{ format.count(summary.data.value.lost.count) }}</td>
                  <td class="text-right">
                    {{ format.money(summary.data.value.lost.amountMinor) }}
                  </td>
                </tr>
              </tbody>
            </v-table>
          </ResourceState>
        </v-card>
      </v-col>
    </v-row>

    <v-card class="mt-6">
      <v-card-title><h2 class="text-h6">Recently updated contacts</h2></v-card-title>
      <v-list role="group" aria-label="Recently updated contacts">
        <v-list-item
          v-for="contact in dashboard.data.value?.recentContacts ?? []"
          :key="contact.id"
          :to="{ name: 'contact', params: { id: contact.id } }"
          :title="contact.displayName"
          :subtitle="`${contact.companyName ?? 'No company'} · ${format.dateTime(contact.updatedAt)}`"
        />
        <v-list-item
          v-if="(dashboard.data.value?.recentContacts.length ?? 0) === 0"
          title="No contacts yet."
        />
      </v-list>
    </v-card>
  </section>
</template>
