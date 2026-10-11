<script setup lang="ts">
/**
 * Create or edit a note: title, Markdown body, and linked records.
 *
 * A composition of Vuetify form primitives with the two reviewed exceptions —
 * {@link MarkdownComposer} and {@link RecordLinkChooser}. Like the deal and task forms it owns its
 * draft and never resets it after a failed save, so a version conflict or a link that has just been
 * deleted keeps the user's text while the parent explains what happened. Server messages for an
 * individual link (`links.2`) are shown on that link's chip, because the form submits links in the
 * order they are shown.
 *
 * @fires submit With the draft.
 * @fires cancel When the user cancels.
 * @fires search When the link chooser needs results.
 */
import { computed, nextTick, reactive, ref, watch } from 'vue';
import {
  CreateNoteInputSchema,
  NOTE_MARKDOWN_MAX_BYTES,
  type Note,
  type NoteLinkType,
  utf8Length
} from '../../shared/api/notes.ts';
import { useFieldValidation } from '../composables/useFieldValidation.ts';
import type { LinkOption, NoteFormValue } from '../services/note-draft.ts';
import MarkdownComposer from './MarkdownComposer.vue';
import RecordLinkChooser from './RecordLinkChooser.vue';

const props = defineProps<{
  /**
   * The note being edited; absent when creating.
   */
  note?: Note | null;
  /**
   * Links to start a new note with (for example, the record the user came from).
   */
  initialLinks?: readonly LinkOption[];
  /**
   * Link search results for the chooser.
   */
  results: readonly LinkOption[];
  /**
   * Whether a link search is in flight.
   */
  searching?: boolean;
  /**
   * A link search failure, or `null`.
   */
  searchError?: string | null;
  /**
   * Whether a submission is in flight.
   */
  submitting?: boolean;
  /**
   * Server field messages.
   */
  fieldErrors?: Readonly<Record<string, string>>;
  /**
   * Server form message.
   */
  formError?: string | null;
}>();

const emit = defineEmits<{
  /**
   * The user submitted a valid draft.
   */
  submit: [value: NoteFormValue];
  /**
   * The user cancelled.
   */
  cancel: [];
  /**
   * The link chooser needs results.
   */
  search: [type: NoteLinkType, text: string];
}>();

const draft = reactive<NoteFormValue>({
  title: props.note?.title ?? '',
  markdown: props.note?.markdown ?? '',
  links: props.note
    ? props.note.links.map((link) => ({ ...link }))
    : [...(props.initialLinks ?? [])]
});
const localErrors = ref<Record<string, string>>({});
const validation = useFieldValidation(CreateNoteInputSchema, () => ({
  title: draft.title,
  markdown: draft.markdown,
  links: draft.links.map(({ type, id }) => ({ type, id }))
}));
const summary = ref<HTMLElement | null>(null);

/**
 * Messages for one field, local first.
 *
 * @param field Field name.
 * @returns Messages for Vuetify's `error-messages`.
 */
function errorsFor(field: string): string[] {
  const message =
    validation.errors.value[field] ?? localErrors.value[field] ?? props.fieldErrors?.[field];
  return message === undefined ? [] : [message];
}

/**
 * Server messages for individual links, keyed by position.
 */
const linkErrors = computed(() => {
  const errors: Record<number, string> = {};
  for (const [field, message] of Object.entries(props.fieldErrors ?? {})) {
    const match = /^links\.(\d+)/u.exec(field);
    if (match?.[1] !== undefined) {
      errors[Number(match[1])] = message;
    }
  }
  return errors;
});

/**
 * Validate locally, then emit.
 */
function onSubmit(): void {
  const errors: Record<string, string> = {};
  if (draft.title.trim() === '') {
    errors.title = 'Title is required.';
  }
  if (draft.markdown.trim() === '') {
    errors.markdown = 'Body is required.';
  } else if (utf8Length(draft.markdown) > NOTE_MARKDOWN_MAX_BYTES) {
    errors.markdown = `Body must be at most ${NOTE_MARKDOWN_MAX_BYTES / 1024} KiB.`;
  }
  if (draft.links.length === 0) {
    errors.links = 'Link the note to at least one record.';
  }
  localErrors.value = errors;
  if (!validation.submit() || Object.keys(errors).length > 0) {
    void nextTick(() => summary.value?.focus());
    return;
  }
  emit('submit', { title: draft.title, markdown: draft.markdown, links: [...draft.links] });
}

watch(
  () => [props.fieldErrors, props.formError],
  async () => {
    if (props.formError || Object.keys(props.fieldErrors ?? {}).length > 0) {
      await nextTick();
      summary.value?.focus();
    }
  }
);

watch(
  () => draft.links.length,
  () => {
    if (draft.links.length > 0 && localErrors.value.links !== undefined) {
      const { links: _links, ...rest } = localErrors.value;
      localErrors.value = rest;
    }
  }
);
</script>

<template>
  <v-form novalidate aria-labelledby="note-form-title" @submit.prevent="onSubmit">
    <div
      v-if="
        formError
        || Object.keys(localErrors).length > 0
        || Object.keys(validation.errors.value).length > 0
        || Object.keys(fieldErrors ?? {}).length > 0
      "
      ref="summary"
      tabindex="-1"
      class="mb-4"
      data-testid="form-summary"
    >
      <v-alert type="error" variant="tonal" role="alert">{{
        formError ?? 'Please correct the highlighted fields.'
      }}</v-alert>
    </div>
    <v-text-field
      v-model="draft.title"
      @blur="validation.blur('title')"
      label="Title"
      required
      counter="200"
      :disabled="submitting"
      :error-messages="errorsFor('title')"
      class="mb-2"
    />
    <MarkdownComposer
      v-model="draft.markdown"
      @blur="validation.blur('markdown')"
      label="Body"
      required
      :disabled="submitting"
      :error-messages="errorsFor('markdown')"
    />
    <RecordLinkChooser
      v-model="draft.links"
      class="mt-4"
      label="Linked records"
      :results="results"
      :loading="searching"
      :search-error="searchError"
      :disabled="submitting"
      :error-messages="errorsFor('links')"
      :item-errors="linkErrors"
      @search="(type, text) => emit('search', type, text)"
    />
    <div class="d-flex justify-end ga-2 mt-4">
      <v-btn variant="text" :disabled="submitting" @click="emit('cancel')">Cancel</v-btn>
      <v-btn type="submit" color="primary" :loading="submitting">{{
        note ? 'Save note' : 'Create note'
      }}</v-btn>
    </div>
  </v-form>
</template>
