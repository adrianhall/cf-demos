<script setup lang="ts">
/**
 * The audit-visible change history of one record: who did what, and when.
 */
import type { HistoryEntry } from '../../shared/api/crm.ts';
import { useFormat } from '../composables/useFormat.ts';

defineProps<{
  /**
   * Entries, newest first.
   */
  entries: readonly HistoryEntry[];
}>();

const format = useFormat();
</script>

<template>
  <v-list density="compact" aria-label="History">
    <v-list-item v-for="entry in entries" :key="entry.id">
      <v-list-item-title>{{ entry.action }} by {{ entry.actor.displayName }}</v-list-item-title>
      <v-list-item-subtitle>{{ format.dateTime(entry.occurredAt) }}</v-list-item-subtitle>
    </v-list-item>
    <v-list-item v-if="entries.length === 0">
      <v-list-item-title>No history recorded.</v-list-item-title>
    </v-list-item>
  </v-list>
</template>
