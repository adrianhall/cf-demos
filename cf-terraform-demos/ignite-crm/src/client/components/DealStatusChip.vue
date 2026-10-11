<script setup lang="ts">
/**
 * A deal's fixed outcome, plus its stage while open, as a Vuetify chip. Outcome is conveyed by
 * text, never by colour alone.
 */
import { computed } from 'vue';
import type { Deal } from '../../shared/api/sales.ts';

const props = defineProps<{
  /**
   * The deal.
   */
  deal: Pick<Deal, 'status' | 'stage'>;
}>();

const view = computed(() => {
  switch (props.deal.status) {
    case 'won':
      return { label: 'Won', color: 'success' };
    case 'lost':
      return { label: 'Lost', color: 'error' };
    default:
      return { label: `Open · ${props.deal.stage.label}`, color: 'secondary-strong' };
  }
});
</script>

<template>
  <v-chip :color="view.color" size="small" variant="tonal" label class="mr-2">{{
    view.label
  }}</v-chip>
</template>
