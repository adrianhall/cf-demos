<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue';
import { useRouter } from 'vue-router';
/**
 * Notes: full-text search over every note, plus the most recently updated notes and a "New note"
 * action.
 *
 * Search runs when the user submits the form (Enter or the Search button), not on every keystroke,
 * because each search is a ranked FTS query. Unlike the other list pages, the search text is
 * deliberately **not** put in the URL: it is note content in all but name, and the API takes it in
 * a POST body for the same reason. Searching shows a result list with highlighted snippets;
 * clearing the search returns to recent notes.
 */
import { mdiMagnify, mdiNotePlusOutline } from '@mdi/js';
import {
  NOTE_SEARCH_MAX,
  NOTE_SEARCH_MIN,
  type NoteSearchResult,
  type NoteSummary
} from '../../shared/api/notes.ts';
import NoteForm from '../components/NoteForm.vue';
import NoteList from '../components/NoteList.vue';
import ResourceState from '../components/ResourceState.vue';
import { useLinkSearch } from '../composables/useLinkSearch.ts';
import { useResource } from '../composables/useResource.ts';
import { useReturnFocus } from '../composables/useReturnFocus.ts';
import { useSession } from '../composables/useSession.ts';
import { useSubmission } from '../composables/useSubmission.ts';
import { api } from '../services/api-client.ts';
import { type NoteFormValue, toCreateNoteInput } from '../services/note-draft.ts';

const router = useRouter();
const { can } = useSession();

const recentItems = shallowRef<NoteSummary[]>([]);
const nextCursor = ref<string | null>(null);
const loadingMore = ref(false);
const recent = useResource(async (signal) => {
  const page = await api.notes({}, signal);
  recentItems.value = [...page.items];
  nextCursor.value = page.nextCursor;
  return page;
});

const text = ref('');
const searchedFor = ref<string | null>(null);
const searchError = ref<string | null>(null);
const results = useResource<NoteSearchResult>((signal) =>
  api.searchNotes(searchedFor.value ?? '', signal)
);
const snippets = computed(() =>
  Object.fromEntries((results.data.value?.items ?? []).map((hit) => [hit.note.id, hit.snippet]))
);

/**
 * Run a search for the current text, after the same length check the server applies.
 */
async function runSearch(): Promise<void> {
  const term = (text.value ?? '').trim();
  if (term.length < NOTE_SEARCH_MIN) {
    searchError.value = `Search for at least ${NOTE_SEARCH_MIN} characters.`;
    return;
  }
  searchError.value = null;
  searchedFor.value = term;
  await results.load();
}

/**
 * Leave search and show recent notes again.
 */
function clearSearch(): void {
  text.value = '';
  searchedFor.value = null;
  searchError.value = null;
}

/**
 * Append the next page of recent notes.
 */
async function loadMore(): Promise<void> {
  if (nextCursor.value === null) {
    return;
  }
  loadingMore.value = true;
  try {
    const page = await api.notes({ cursor: nextCursor.value });
    recentItems.value = [...recentItems.value, ...page.items];
    nextCursor.value = page.nextCursor;
  } finally {
    loadingMore.value = false;
  }
}

const composing = ref(false);
useReturnFocus(composing);
const submission = useSubmission({ forbidden: 'Your role does not allow writing notes.' });
const linkSearch = useLinkSearch();

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

onMounted(() => void recent.load());
</script>

<template>
  <section aria-labelledby="notes-title">
    <div class="d-flex align-center justify-space-between flex-wrap ga-2 mb-1">
      <h1 id="notes-title" class="text-h4">Notes</h1>
      <v-btn
        v-if="can('note.write')"
        color="primary"
        :prepend-icon="mdiNotePlusOutline"
        @click="
          submission.reset();
          composing = true;
        "
        >New note</v-btn
      >
    </div>
    <p class="text-medium-emphasis mb-4">
      Meeting notes and research, each linked to the people, companies, deals, and projects it is
      about.
    </p>

    <v-form role="search" aria-label="Search notes" class="mb-4" @submit.prevent="runSearch">
      <v-row density="compact" align="center">
        <v-col cols="12" sm="9">
          <v-text-field
            v-model="text"
            label="Search notes"
            :prepend-inner-icon="mdiMagnify"
            :counter="NOTE_SEARCH_MAX"
            :maxlength="NOTE_SEARCH_MAX"
            hint="Words in the title or body; every word must match."
            persistent-hint
            clearable
            :error-messages="searchError ? [searchError] : []"
            @click:clear="clearSearch"
          />
        </v-col>
        <v-col cols="12" sm="3" class="d-flex ga-2">
          <v-btn
            type="submit"
            color="primary"
            variant="tonal"
            :loading="results.state.value === 'loading'"
            >Search</v-btn
          >
          <v-btn v-if="searchedFor !== null" variant="text" @click="clearSearch">Clear</v-btn>
        </v-col>
      </v-row>
    </v-form>

    <section v-if="searchedFor !== null" aria-labelledby="results-title">
      <h2 id="results-title" class="text-h6 mb-2" aria-live="polite">
        <template v-if="results.state.value === 'success' && results.data.value">
          {{ results.data.value.items.length }}{{ results.data.value.truncated ? '+' : '' }}
          {{ results.data.value.items.length === 1 ? 'note matches' : 'notes match' }} “{{
            searchedFor
          }}”
        </template>
        <template v-else>Searching for “{{ searchedFor }}”</template>
      </h2>
      <ResourceState
        :state="results.state.value"
        :error="results.error.value"
        :empty="(results.data.value?.items.length ?? 0) === 0"
        :has-data="results.data.value !== null"
        empty-title="No matching notes"
        empty-text="Try fewer or shorter words; each word matches the start of a word in a note."
        @retry="results.load"
      >
        <v-card>
          <NoteList
            :notes="(results.data.value?.items ?? []).map((hit) => hit.note)"
            :snippets="snippets"
          />
        </v-card>
        <p v-if="results.data.value?.truncated" class="text-body-2 text-medium-emphasis mt-2">
          Showing the 50 best matches. Add a word to narrow the search.
        </p>
      </ResourceState>
    </section>

    <section v-else aria-labelledby="recent-title">
      <h2 id="recent-title" class="text-h6 mb-2">Recently updated</h2>
      <ResourceState
        :state="recent.state.value"
        :error="recent.error.value"
        :empty="recentItems.length === 0"
        :has-data="recent.data.value !== null"
        empty-title="No notes yet"
        empty-text="Create a note from here, or from any contact, company, deal, or project."
        @retry="recent.load"
      >
        <v-card>
          <NoteList :notes="recentItems" />
        </v-card>
        <div v-if="nextCursor" class="d-flex justify-center mt-2">
          <v-btn variant="tonal" :loading="loadingMore" @click="loadMore">Load more</v-btn>
        </div>
      </ResourceState>
    </section>

    <v-dialog v-model="composing" max-width="760" aria-labelledby="note-form-title" scrollable>
      <v-card>
        <v-card-title><h2 id="note-form-title" class="text-h6">New note</h2></v-card-title>
        <v-card-text>
          <NoteForm
            v-if="composing"
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
  </section>
</template>
