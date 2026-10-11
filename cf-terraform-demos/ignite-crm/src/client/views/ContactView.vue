<script setup lang="ts">
/**
 * One contact: details, company link, owner, and history.
 */
import { watch } from 'vue';
import HistoryList from '../components/HistoryList.vue';
import ResourceState from '../components/ResourceState.vue';
import { useFormat } from '../composables/useFormat.ts';
import { useResource } from '../composables/useResource.ts';
import { api } from '../services/api-client.ts';

const props = defineProps<{
  /**
   * Contact id from the route.
   */
  id: string;
}>();

const format = useFormat();
const detail = useResource((signal) => api.contact(props.id, signal));

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
    <section v-if="detail.data.value" aria-labelledby="contact-title">
      <v-breadcrumbs
        :items="[
          { title: 'Contacts', to: { name: 'contacts' } },
          { title: detail.data.value.contact.displayName }
        ]"
        class="px-0"
      />
      <h1 id="contact-title" class="text-h4 mb-1">{{ detail.data.value.contact.displayName }}</h1>
      <p class="text-medium-emphasis mb-4">
        {{ detail.data.value.contact.jobTitle ?? 'No job title' }}
      </p>
      <v-row>
        <v-col cols="12" md="7">
          <v-card>
            <v-card-title><h2 class="text-h6">Details</h2></v-card-title>
            <v-list density="compact">
              <v-list-item title="Company">
                <template #subtitle>
                  <router-link
                    v-if="detail.data.value.contact.company"
                    :to="{ name: 'company', params: { id: detail.data.value.contact.company.id } }"
                  >
                    {{ detail.data.value.contact.company.name }}
                  </router-link>
                  <span v-else>None</span>
                </template>
              </v-list-item>
              <v-list-item title="E-mail" :subtitle="detail.data.value.contact.email ?? '—'" />
              <v-list-item title="Phone" :subtitle="detail.data.value.contact.phone ?? '—'" />
              <v-list-item title="Owner" :subtitle="detail.data.value.contact.owner.displayName" />
              <v-list-item
                title="Created"
                :subtitle="format.dateTime(detail.data.value.contact.createdAt)"
              />
            </v-list>
          </v-card>
        </v-col>
        <v-col cols="12" md="5">
          <v-card>
            <v-card-title><h2 class="text-h6">History</h2></v-card-title>
            <HistoryList :entries="detail.data.value.history" />
          </v-card>
        </v-col>
      </v-row>
    </section>
  </ResourceState>
</template>
