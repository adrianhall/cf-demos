<script setup lang="ts">
/**
 * A list of note summaries: title (a link to the note), author and last update, and the linked
 * records as chips. Optional snippet runs (from search) show matched words with `<mark>` through
 * ordinary text interpolation, so note text is never parsed as HTML.
 *
 * A thin composition of Vuetify's `VList` and `VChip`.
 */
import type { NoteSummary, SnippetSegment } from '../../shared/api/notes.ts';
import { useFormat } from '../composables/useFormat.ts';
import { linkRoute } from '../services/link-search.ts';
import { LINK_TYPE_LABELS } from '../services/note-draft.ts';

const props = defineProps<{
  /**
   * Notes to show.
   */
  notes: readonly NoteSummary[];
  /**
   * Snippets by note id (search results only).
   */
  snippets?: Readonly<Record<string, readonly SnippetSegment[]>>;
  /**
   * Text shown when there are no notes.
   */
  emptyText?: string;
  /**
   * Hide the chip for this record (the page the list is shown on).
   */
  hideLink?: { readonly type: string; readonly id: string };
}>();

const { dateTime } = useFormat();
</script>

<template>
  <p v-if="props.notes.length === 0" class="text-body-2 text-medium-emphasis px-4 pb-4 mb-0">
    {{ props.emptyText ?? 'No notes yet.' }}
  </p>
  <v-list v-else lines="three" aria-label="Notes">
    <v-list-item v-for="note in props.notes" :key="note.id">
      <v-list-item-title>
        <router-link :to="{ name: 'note', params: { id: note.id } }" class="text-primary-strong">{{
          note.title
        }}</router-link>
      </v-list-item-title>
      <v-list-item-subtitle>
        {{ note.author.displayName }} · updated {{ dateTime(note.updatedAt) }}
      </v-list-item-subtitle>
      <p v-if="props.snippets?.[note.id]" class="text-body-2 mt-1 mb-0" data-testid="snippet">
        <template v-for="(segment, index) in props.snippets[note.id]" :key="index">
          <mark v-if="segment.match" class="bg-secondary-container">{{ segment.text }}</mark>
          <template v-else>{{ segment.text }}</template>
        </template>
      </p>
      <div class="d-flex flex-wrap ga-1 mt-2">
        <template v-for="link in note.links" :key="`${link.type}:${link.id}`">
          <v-chip
            v-if="!(props.hideLink?.type === link.type && props.hideLink.id === link.id)"
            size="small"
            :variant="link.available ? 'tonal' : 'outlined'"
            :to="link.available ? linkRoute(link) : undefined"
            :disabled="!link.available"
          >
            {{ LINK_TYPE_LABELS[link.type] }}: {{ link.label
            }}<span v-if="!link.available">&nbsp;(deleted)</span>
          </v-chip>
        </template>
      </div>
    </v-list-item>
  </v-list>
</template>
