<script setup lang="ts">
/**
 * One company's customer timeline: details, primary contact, contacts, deals, delivery projects,
 * every call and meeting involving the company or its people, and history.
 */
import { watch } from 'vue';
import ActivityList from '../components/ActivityList.vue';
import DealList from '../components/DealList.vue';
import HistoryList from '../components/HistoryList.vue';
import ProjectList from '../components/ProjectList.vue';
import ResourceState from '../components/ResourceState.vue';
import { useResource } from '../composables/useResource.ts';
import { api } from '../services/api-client.ts';

const props = defineProps<{
  /**
   * Company id from the route.
   */
  id: string;
}>();

const detail = useResource((signal) => api.company(props.id, signal));

watch(
  () => props.id,
  () => void detail.load(),
  { immediate: true }
);
</script>

<template>
  <ResourceState
    :state="detail.state.value"
    :error="detail.error.value"
    skeleton="article"
    @retry="detail.load"
  >
    <section v-if="detail.data.value" aria-labelledby="company-title">
      <v-breadcrumbs
        :items="[
          { title: 'Companies', to: { name: 'companies' } },
          { title: detail.data.value.company.name }
        ]"
        class="px-0"
      />
      <h1 id="company-title" class="text-h4 mb-4">{{ detail.data.value.company.name }}</h1>
      <v-row>
        <v-col cols="12" md="7">
          <v-card class="mb-4">
            <v-card-title><h2 class="text-h6">Details</h2></v-card-title>
            <v-list density="compact">
              <v-list-item title="Address" :subtitle="detail.data.value.company.address ?? '—'" />
              <v-list-item
                title="Stock symbol"
                :subtitle="detail.data.value.company.stockSymbol ?? '—'"
              />
              <v-list-item title="Companies House">
                <template #subtitle>
                  <a
                    v-if="detail.data.value.company.companiesHouseUrl"
                    :href="detail.data.value.company.companiesHouseUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    >View registration</a
                  >
                  <span v-else>—</span>
                </template>
              </v-list-item>
              <v-list-item
                title="Primary contact"
                :subtitle="detail.data.value.company.primaryContact?.displayName ?? 'Not set'"
              />
            </v-list>
          </v-card>
          <v-card>
            <v-card-title><h2 class="text-h6">Contacts</h2></v-card-title>
            <v-list aria-label="Company contacts">
              <v-list-item
                v-for="contact in detail.data.value.contacts"
                :key="contact.id"
                :to="{ name: 'contact', params: { id: contact.id } }"
                :title="contact.displayName"
                :subtitle="contact.jobTitle ?? ''"
              />
              <v-list-item
                v-if="detail.data.value.contacts.length === 0"
                title="No contacts at this company."
              />
            </v-list>
          </v-card>
          <v-card class="mt-4">
            <v-card-title><h2 class="text-h6">Calls and meetings</h2></v-card-title>
            <ActivityList :activities="detail.data.value.activities" />
          </v-card>
        </v-col>
        <v-col cols="12" md="5">
          <v-card class="mb-4">
            <v-card-title><h2 class="text-h6">Deals</h2></v-card-title>
            <DealList
              :deals="detail.data.value.deals"
              empty-text="No deals with this company yet."
            />
          </v-card>
          <v-card class="mb-4">
            <v-card-title><h2 class="text-h6">Projects</h2></v-card-title>
            <ProjectList
              :projects="detail.data.value.projects"
              empty-text="No delivery projects for this company yet."
            />
          </v-card>
          <v-card>
            <v-card-title><h2 class="text-h6">History</h2></v-card-title>
            <HistoryList :entries="detail.data.value.history" />
          </v-card>
        </v-col>
      </v-row>
    </section>
  </ResourceState>
</template>
