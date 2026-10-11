<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
/**
 * One note: rendered Markdown, every linked record (deleted ones shown as tombstones), and history.
 * Editing happens in a dialog; on a version conflict the dialog stays open with the user's draft
 * intact and offers to load the latest version, exactly like the deal and task editors. The Edit
 * action appears for the author and for roles with `note.manage`; the server enforces the same
 * rule.
 */
import { mdiPencil } from '@mdi/js';
import type { Note } from '../../shared/api/notes.ts';
import HistoryList from '../components/HistoryList.vue';
import MarkdownView from '../components/MarkdownView.vue';
import NoteForm from '../components/NoteForm.vue';
import ResourceState from '../components/ResourceState.vue';
import { useFormat } from '../composables/useFormat.ts';
import { useLinkSearch } from '../composables/useLinkSearch.ts';
import { useResource } from '../composables/useResource.ts';
import { useSession } from '../composables/useSession.ts';
import { useSubmission } from '../composables/useSubmission.ts';
import { api } from '../services/api-client.ts';
import { linkRoute } from '../services/link-search.ts';
import { LINK_TYPE_LABELS, type NoteFormValue, toUpdateNoteInput } from '../services/note-draft.ts';

const props = defineProps<{
  /**
   * Note id from the route.
   */
  id: string;
}>();

const { can, session } = useSession();
const { dateTime } = useFormat();
const detail = useResource((signal) => api.note(props.id, signal));
const note = computed(() => detail.data.value?.note ?? null);
const canEdit = computed(
  () =>
    note.value !== null
    && can('note.write')
    && (note.value.author.id === session.value?.user.id || can('note.manage'))
);

watch(
  () => props.id,
  () => void detail.load(),
  { immediate: true }
);

const editing = ref(false);
/**
 * The note as it was when the editor opened: the base edits are measured against.
 */
const baseNote = shallowRef<Note | null>(null);
const editor = useSubmission({ forbidden: 'Only the author or a manager can edit this note.' });
const linkSearch = useLinkSearch();
const noChanges = ref(false);

/**
 * Open the editor.
 */
function openEdit(): void {
  editor.reset();
  noChanges.value = false;
  baseNote.value = note.value;
  editing.value = true;
}

/**
 * Save only what changed since the editor opened, against the newest loaded version.
 *
 * @param value The form draft.
 */
async function save(value: NoteFormValue): Promise<void> {
  const current = note.value;
  const base = baseNote.value ?? current;
  if (current === null || base === null) {
    return;
  }
  const changes = toUpdateNoteInput(base, value);
  if (changes === null) {
    noChanges.value = true;
    editing.value = false;
    return;
  }
  const updated = await editor.run((key) =>
    api.updateNote(current.id, changes, current.version, key)
  );
  if (updated !== undefined) {
    editing.value = false;
    await detail.load();
  }
}

/**
 * Load the latest version underneath the open editor, keeping the user's draft.
 */
async function reloadLatest(): Promise<void> {
  await detail.load();
  editor.conflict.value = false;
  editor.formError.value =
    'The latest version is loaded. Your edits are still in the form; review them and save again.';
}
</script>

<template>
  <ResourceState
    :state="detail.state.value"
    :error="detail.error.value"
    :has-data="detail.data.value !== null"
    skeleton="article"
    @retry="detail.load"
  >
    <section v-if="note" aria-labelledby="note-title">
      <v-breadcrumbs
        :items="[{ title: 'Notes', to: { name: 'notes' } }, { title: note.title }]"
        class="px-0"
      />
      <div class="d-flex align-center justify-space-between flex-wrap ga-2 mb-1">
        <h1 id="note-title" class="text-h4">{{ note.title }}</h1>
        <v-btn v-if="canEdit" variant="tonal" :prepend-icon="mdiPencil" @click="openEdit"
          >Edit note</v-btn
        >
      </div>
      <p class="text-medium-emphasis mb-4">
        By {{ note.author.displayName }} · updated {{ dateTime(note.updatedAt) }}
        <template v-if="note.lastEditedBy.id !== note.author.id">
          by {{ note.lastEditedBy.displayName }}</template
        >
      </p>
      <v-alert
        v-if="noChanges"
        type="info"
        variant="tonal"
        class="mb-4"
        closable
        @click:close="noChanges = false"
        >Nothing changed, so nothing was saved.</v-alert
      >
      <v-row>
        <v-col cols="12" md="8">
          <v-card class="mb-4">
            <v-card-text>
              <MarkdownView :source="note.markdown" :label="`${note.title} (note body)`" />
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" md="4">
          <v-card class="mb-4">
            <v-card-title><h2 class="text-h6">Linked records</h2></v-card-title>
            <v-list density="compact" aria-label="Linked records">
              <v-list-item
                v-for="link in note.links"
                :key="`${link.type}:${link.id}`"
                :to="link.available ? linkRoute(link) : undefined"
                :title="link.label"
                :subtitle="
                  link.available
                    ? LINK_TYPE_LABELS[link.type]
                    : `${LINK_TYPE_LABELS[link.type]} · deleted`
                "
              />
            </v-list>
          </v-card>
          <v-card>
            <v-card-title><h2 class="text-h6">History</h2></v-card-title>
            <HistoryList :entries="detail.data.value?.history ?? []" />
          </v-card>
        </v-col>
      </v-row>

      <v-dialog v-model="editing" max-width="760" aria-labelledby="note-form-title" scrollable>
        <v-card>
          <v-card-title><h2 id="note-form-title" class="text-h6">Edit note</h2></v-card-title>
          <v-card-text>
            <v-alert
              v-if="editor.conflict.value"
              type="warning"
              variant="tonal"
              class="mb-4"
              data-testid="conflict"
            >
              Someone else changed this note after you opened it. Your edits are kept below.
              <template #append>
                <v-btn variant="text" @click="reloadLatest">Load latest version</v-btn>
              </template>
            </v-alert>
            <NoteForm
              v-if="editing"
              :note="baseNote"
              :results="linkSearch.results.value"
              :searching="linkSearch.searching.value"
              :search-error="linkSearch.error.value?.message"
              :submitting="editor.submitting.value"
              :field-errors="editor.fieldErrors.value"
              :form-error="editor.conflict.value ? null : editor.formError.value"
              @search="linkSearch.search"
              @submit="save"
              @cancel="editing = false"
            />
          </v-card-text>
        </v-card>
      </v-dialog>
    </section>
  </ResourceState>
</template>
