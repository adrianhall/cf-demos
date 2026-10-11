<script setup lang="ts">
/**
 * A customer's story, newest first: calls and meetings, deals opened, won, and lost, projects
 * started, and notes written — the customer overview's merged timeline.
 *
 * Built directly on Vuetify's `VTimeline` in its dense, single-sided layout, with theme colours per
 * kind, so it adapts to light and dark themes and to narrow screens without custom CSS. Entries
 * that have a page of their own link to it; activities have none, so their entry is plain text.
 * Only titles appear: no summary, status line, or note body is part of the overview contract.
 */
import {
  mdiAccountVoice,
  mdiBriefcaseCheck,
  mdiBriefcaseOutline,
  mdiBriefcaseRemove,
  mdiNoteTextOutline,
  mdiPhone,
  mdiViewColumn
} from '@mdi/js';
import type { TimelineEntry } from '../../shared/api/overview.ts';
import { useFormat } from '../composables/useFormat.ts';

defineProps<{
  /**
   * Entries, newest first.
   */
  entries: readonly TimelineEntry[];
}>();

const format = useFormat();

/**
 * Presentation for each kind: verb, icon, and theme colour.
 */
const KIND: Readonly<Record<TimelineEntry['kind'], { verb: string; icon: string; color: string }>> =
  {
    'call': { verb: 'Call', icon: mdiPhone, color: 'secondary' },
    'meeting': { verb: 'Meeting', icon: mdiAccountVoice, color: 'secondary' },
    'deal-opened': { verb: 'Deal opened', icon: mdiBriefcaseOutline, color: 'primary' },
    'deal-won': { verb: 'Deal won', icon: mdiBriefcaseCheck, color: 'success' },
    'deal-lost': { verb: 'Deal lost', icon: mdiBriefcaseRemove, color: 'error' },
    'project-started': { verb: 'Project started', icon: mdiViewColumn, color: 'primary-strong' },
    'note': { verb: 'Note', icon: mdiNoteTextOutline, color: 'info' }
  };
</script>

<template>
  <v-timeline
    v-if="entries.length > 0"
    side="end"
    density="compact"
    truncate-line="both"
    aria-label="Customer timeline"
    role="list"
  >
    <v-timeline-item
      v-for="entry in entries"
      :key="entry.key"
      :dot-color="KIND[entry.kind].color"
      :icon="KIND[entry.kind].icon"
      size="small"
      role="listitem"
    >
      <div class="text-body-2">
        <span class="font-weight-medium">{{ KIND[entry.kind].verb }}:</span>
        <router-link
          v-if="entry.target"
          :to="{ name: entry.target.type, params: { id: entry.target.id } }"
          class="ms-1"
          >{{ entry.title }}</router-link
        >
        <span v-else class="ms-1">{{ entry.title }}</span>
      </div>
      <div class="text-caption text-medium-emphasis">
        {{ format.dateTime(entry.at) }}
        <template v-if="entry.actor"> · {{ entry.actor.displayName }}</template>
      </div>
    </v-timeline-item>
  </v-timeline>
  <p v-else class="text-body-2 text-medium-emphasis px-4 pb-4">Nothing has happened yet.</p>
</template>
