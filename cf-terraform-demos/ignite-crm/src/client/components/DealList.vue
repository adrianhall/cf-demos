<script setup lang="ts">
/**
 * A compact list of deals with outcome, stage, value, and next action. A composition of Vuetify
 * list and chip primitives, used on contact and company timelines.
 */
import type { Deal } from '../../shared/api/sales.ts';
import { useFormat } from '../composables/useFormat.ts';
import DealStatusChip from './DealStatusChip.vue';

defineProps<{
  /**
   * Deals to list.
   */
  deals: readonly Deal[];
  /**
   * Text shown when there are none.
   */
  emptyText?: string;
}>();

const format = useFormat();
</script>

<template>
  <v-list lines="two" aria-label="Deals">
    <v-list-item
      v-for="deal in deals"
      :key="deal.id"
      :to="{ name: 'deal', params: { id: deal.id } }"
    >
      <v-list-item-title class="text-wrap">
        {{ deal.title }} · {{ format.money(deal.amountMinor) }}
      </v-list-item-title>
      <v-list-item-subtitle class="text-wrap">
        <DealStatusChip :deal="deal" />
        <template v-if="deal.project">Converted to {{ deal.project.name }} · </template>
        <template v-if="deal.nextActionText">
          Next: {{ deal.nextActionText }} ({{ format.date(deal.nextActionDate ?? '') }})
        </template>
      </v-list-item-subtitle>
    </v-list-item>
    <v-list-item v-if="deals.length === 0" :title="emptyText ?? 'No deals yet.'" />
  </v-list>
</template>
