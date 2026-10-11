<script setup lang="ts">
/**
 * Calls and meetings, newest first, each with every linked person, company, and deal. A composition
 * of Vuetify list primitives. Contacts deleted since the activity was logged are shown struck
 * through and unlinked, so history stays complete without linking to a missing record.
 */
import { mdiAccountVoice, mdiPhone } from '@mdi/js';
import type { Activity } from '../../shared/api/sales.ts';
import { useFormat } from '../composables/useFormat.ts';

defineProps<{
  /**
   * Activities, newest first.
   */
  activities: readonly Activity[];
}>();

const format = useFormat();
</script>

<template>
  <v-list lines="three" aria-label="Calls and meetings">
    <v-list-item
      v-for="activity in activities"
      :key="activity.id"
      :prepend-icon="activity.type === 'call' ? mdiPhone : mdiAccountVoice"
    >
      <v-list-item-title class="text-wrap">
        {{ activity.type === 'call' ? 'Call' : 'Meeting' }}: {{ activity.subject }}
      </v-list-item-title>
      <v-list-item-subtitle class="text-wrap">
        {{ format.dateTime(activity.occurredAt) }}
        <template v-if="activity.durationMinutes"> · {{ activity.durationMinutes }} min</template>
        · logged by {{ activity.author.displayName }}
      </v-list-item-subtitle>
      <div class="text-body-2 mt-1">
        With
        <template v-for="(contact, index) in activity.contacts" :key="contact.id">
          <span v-if="index > 0">, </span>
          <s v-if="contact.deleted">{{ contact.displayName }} (deleted)</s>
          <router-link v-else :to="{ name: 'contact', params: { id: contact.id } }">{{
            contact.displayName
          }}</router-link>
        </template>
        <template v-if="activity.company">
          · at
          <router-link :to="{ name: 'company', params: { id: activity.company.id } }">{{
            activity.company.name
          }}</router-link>
        </template>
        <template v-if="activity.deal">
          · about
          <router-link :to="{ name: 'deal', params: { id: activity.deal.id } }">{{
            activity.deal.title
          }}</router-link>
        </template>
      </div>
      <p v-if="activity.summary" class="text-body-2 mt-1 summary">{{ activity.summary }}</p>
    </v-list-item>
    <v-list-item v-if="activities.length === 0" title="No calls or meetings logged yet." />
  </v-list>
</template>

<style scoped>
.summary {
  white-space: pre-line;
}
</style>
