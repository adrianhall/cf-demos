<script setup lang="ts">
import { ref, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';
/**
 * The "Notes" card on a contact, company, deal, or project page: the notes linked to that record,
 * newest first, with "Show more" paging and a "New note" action that starts a note already linked
 * to the record.
 *
 * It loads its own feed (the record pages each own one resource already, and the feed is
 * independently pageable), and opens a {@link NoteForm} dialog. A failed feed load is shown inside
 * the card only, so the record itself stays usable — the partial-failure behaviour the plan asks
 * for when one part of a page is unavailable.
 */
import { mdiNotePlusOutline } from '@mdi/js';
import type { NoteLinkType, NoteSummary } from '../../shared/api/notes.ts';
import { useLinkSearch } from '../composables/useLinkSearch.ts';
import { useSession } from '../composables/useSession.ts';
import { useSubmission } from '../composables/useSubmission.ts';
import { api, type ApiError } from '../services/api-client.ts';
import { type NoteFormValue, toCreateNoteInput } from '../services/note-draft.ts';
import NoteForm from './NoteForm.vue';
import NoteList from './NoteList.vue';

const props = defineProps<{
  /**
   * The record whose notes are shown.
   */
  record: { readonly type: NoteLinkType; readonly id: string; readonly label: string };
}>();

const router = useRouter();
const { can } = useSession();
const notes = shallowRef<NoteSummary[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const loadError = shallowRef<ApiError | null>(null);
const composing = ref(false);
const submission = useSubmission({ forbidden: 'Your role does not allow writing notes.' });
const linkSearch = useLinkSearch();
let generation = 0;

/**
 * Load the first page, or append the next one.
 *
 * @param more Append the next page instead of replacing.
 */
async function load(more = false): Promise<void> {
  const current = ++generation;
  loading.value = true;
  loadError.value = null;
  try {
    const page = await api.notes({
      linkType: props.record.type,
      linkId: props.record.id,
      ...(more && nextCursor.value !== null ? { cursor: nextCursor.value } : {})
    });
    if (current === generation) {
      notes.value = more ? [...notes.value, ...page.items] : page.items;
      nextCursor.value = page.nextCursor;
    }
  } catch (caught) {
    if (current === generation) {
      loadError.value = caught as ApiError;
    }
  } finally {
    if (current === generation) {
      loading.value = false;
    }
  }
}

/**
 * Open the composer with this record already linked.
 */
function compose(): void {
  submission.reset();
  composing.value = true;
}

/**
 * Create the note, then open it.
 *
 * @param value The form draft.
 */
async function create(value: NoteFormValue): Promise<void> {
  const note = await submission.run((key) => api.createNote(toCreateNoteInput(value), key));
  if (note !== undefined) {
    composing.value = false;
    await router.push({ name: 'note', params: { id: note.id } });
  }
}

watch(
  () => `${props.record.type}:${props.record.id}`,
  () => void load(),
  { immediate: true }
);
</script>

<template>
  <v-card class="mb-4" data-testid="notes-card">
    <v-card-title class="d-flex align-center justify-space-between flex-wrap ga-2">
      <h2 class="text-h6">Notes</h2>
      <v-btn
        v-if="can('note.write')"
        size="small"
        variant="tonal"
        color="primary-strong"
        :prepend-icon="mdiNotePlusOutline"
        @click="compose"
        >New note</v-btn
      >
    </v-card-title>
    <v-alert
      v-if="loadError"
      type="warning"
      variant="tonal"
      class="mx-4 mb-4"
      data-testid="notes-error"
    >
      Notes could not be loaded. {{ loadError.message }}
      <template #append>
        <v-btn variant="text" @click="load()">Retry</v-btn>
      </template>
    </v-alert>
    <v-progress-linear v-else-if="loading && notes.length === 0" indeterminate />
    <NoteList
      v-else
      :notes="notes"
      :hide-link="props.record"
      empty-text="No notes about this record yet."
    />
    <v-card-actions v-if="nextCursor !== null && !loadError">
      <v-btn variant="text" :loading="loading" @click="load(true)">Show more notes</v-btn>
    </v-card-actions>

    <v-dialog v-model="composing" max-width="760" aria-labelledby="note-form-title" scrollable>
      <v-card>
        <v-card-title><h2 id="note-form-title" class="text-h6">New note</h2></v-card-title>
        <v-card-text>
          <NoteForm
            v-if="composing"
            :initial-links="[{ ...props.record }]"
            :results="linkSearch.results.value"
            :searching="linkSearch.searching.value"
            :search-error="linkSearch.error.value?.message"
            :submitting="submission.submitting.value"
            :field-errors="submission.fieldErrors.value"
            :form-error="submission.formError.value"
            @search="linkSearch.search"
            @submit="create"
            @cancel="composing = false"
          />
        </v-card-text>
      </v-card>
    </v-dialog>
  </v-card>
</template>
