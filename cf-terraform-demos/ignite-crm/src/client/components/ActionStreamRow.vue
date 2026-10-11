<script setup lang="ts">
/**
 * One action-stream row: what to do, for whom, about which deal, and how urgent it is.
 *
 * A reusable component in Vuetify's style (README "Vuetify component library"): Vuetify has no
 * worklist row that combines an urgency chip, a due date, and links to two records. It is a
 * `VListItem` with a `VChip`, consumes only theme colours, and is fully keyboard operable — every
 * interactive part is a real link or button. It renders an `<li>`-equivalent list item, so place it
 * inside a `VList`.
 *
 * Urgency is conveyed by text as well as colour (WCAG 1.4.1).
 *
 * @fires complete With the row when the user marks a contact action done (only when `completable`).
 */
import { computed } from 'vue';
import { mdiAccount, mdiBriefcase, mdiCheck } from '@mdi/js';
import type { ActionItem } from '../../shared/api/sales.ts';
import { useFormat } from '../composables/useFormat.ts';

const props = defineProps<{
  /**
   * The row to show.
   */
  item: ActionItem;
  /**
   * Whether to offer a "Done" button for contact actions.
   */
  completable?: boolean;
  /**
   * Whether a completion for this row is in flight.
   */
  busy?: boolean;
}>();

const emit = defineEmits<{
  /**
   * The user marked the contact action done.
   */
  complete: [item: ActionItem];
}>();

const format = useFormat();

/**
 * Label and theme colour for each urgency.
 */
const URGENCY = {
  asap: { label: 'ASAP', color: 'error' },
  overdue: { label: 'Overdue', color: 'error' },
  today: { label: 'Today', color: 'warning' },
  upcoming: { label: 'Upcoming', color: 'info' }
} as const;

const urgency = computed(() => URGENCY[props.item.urgency]);
const when = computed(() =>
  props.item.dueDate === null ? 'As soon as possible' : format.date(props.item.dueDate)
);
</script>

<template>
  <v-list-item :prepend-icon="item.kind === 'deal' ? mdiBriefcase : mdiAccount" lines="two">
    <v-list-item-title class="text-wrap">
      <v-chip
        :color="urgency.color"
        size="small"
        variant="tonal"
        label
        class="mr-2"
        data-testid="urgency"
        >{{ urgency.label }}</v-chip
      >{{ item.text }}
    </v-list-item-title>
    <v-list-item-subtitle class="text-wrap">
      <span>{{ when }}</span>
      ·
      <router-link :to="{ name: 'contact', params: { id: item.contact.id } }">{{
        item.contact.displayName
      }}</router-link>
      <template v-if="item.deal">
        ·
        <router-link :to="{ name: 'deal', params: { id: item.deal.id } }">{{
          item.deal.title
        }}</router-link>
      </template>
      <template v-if="item.company"> · {{ item.company.name }}</template>
    </v-list-item-subtitle>
    <template v-if="completable && item.kind === 'contact'" #append>
      <v-btn
        variant="text"
        :prepend-icon="mdiCheck"
        :loading="busy"
        :aria-label="`Mark done: ${item.text} for ${item.contact.displayName}`"
        @click="emit('complete', item)"
        >Done</v-btn
      >
    </template>
  </v-list-item>
</template>
