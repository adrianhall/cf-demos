<script setup lang="ts">
/**
 * Dashboard: headline counts and the most recently changed contacts.
 */
import { onMounted } from 'vue';
import ResourceState from '../components/ResourceState.vue';
import { useFormat } from '../composables/useFormat.ts';
import { useResource } from '../composables/useResource.ts';
import { useSession } from '../composables/useSession.ts';
import { api } from '../services/api-client.ts';

const { session, roleLabel } = useSession();
const format = useFormat();
const dashboard = useResource((signal) => api.dashboard(signal));

onMounted(() => void dashboard.load());
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
          <v-card :to="{ name: 'contacts' }" variant="tonal" color="primary">
            <v-card-text>
              <div class="text-h3">{{ format.count(dashboard.data.value?.contacts ?? 0) }}</div>
              <div class="text-subtitle-1">Contacts</div>
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" sm="6">
          <v-card :to="{ name: 'companies' }" variant="tonal" color="secondary">
            <v-card-text>
              <div class="text-h3">{{ format.count(dashboard.data.value?.companies ?? 0) }}</div>
              <div class="text-subtitle-1">Companies</div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>
      <v-card class="mt-6">
        <v-card-title><h2 class="text-h6">Recently updated contacts</h2></v-card-title>
        <v-list>
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
    </ResourceState>
  </section>
</template>
