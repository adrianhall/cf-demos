<script setup lang="ts">
import { computed, ref } from 'vue';
/**
 * A Markdown body field with Write and Preview tabs, in Vuetify's form style: the reusable composer
 * for note bodies.
 *
 * Vuetify has `VTextarea` but no Markdown editor. This component is a `VTextarea` (so labels,
 * counters, hints, error messages, density, and focus are Vuetify's own) plus a `VBtnToggle` that
 * switches to a {@link MarkdownView} preview. The counter shows UTF-8 bytes against the 64 KiB
 * limit, because that is the limit the server enforces. It is a plain `v-model` field: it owns no
 * draft and calls no API.
 *
 * Keyboard: Tab reaches the toggle and the field; the toggle buttons are native buttons, so Enter
 * and Space switch modes. The preview region is focusable so its content can be read by scrolling
 * with the keyboard.
 */
import { mdiEyeOutline, mdiPencilOutline } from '@mdi/js';
import { NOTE_MARKDOWN_MAX_BYTES, utf8Length } from '../../shared/api/notes.ts';
import MarkdownView from './MarkdownView.vue';

const props = defineProps<{
  /**
   * Field label.
   */
  label: string;
  /**
   * Validation messages.
   */
  errorMessages?: readonly string[];
  /**
   * Disable editing (for example, while saving).
   */
  disabled?: boolean;
  /**
   * Mark the field required (announced, and shown with an asterisk); validation stays in the form.
   */
  required?: boolean;
}>();

/**
 * The Markdown text.
 */
const model = defineModel<string>({ required: true });

const mode = ref<'write' | 'preview'>('write');
const bytes = computed(() => utf8Length(model.value));
const kib = computed(() => (bytes.value / 1024).toFixed(1));
const tooLong = computed(() => bytes.value > NOTE_MARKDOWN_MAX_BYTES);
const messages = computed(() => [
  ...(props.errorMessages ?? []),
  ...(tooLong.value ? [`Body must be at most ${NOTE_MARKDOWN_MAX_BYTES / 1024} KiB.`] : [])
]);
</script>

<template>
  <div class="markdown-composer">
    <div class="d-flex align-center justify-space-between flex-wrap ga-2 mb-2">
      <span class="text-body-2 text-medium-emphasis">
        Markdown: headings, **bold**, *italic*, lists, - [ ] tasks, `code`, and links. HTML is shown
        as text.
      </span>
      <v-btn-toggle
        v-model="mode"
        mandatory
        density="comfortable"
        variant="outlined"
        divided
        :aria-label="`${props.label} mode`"
      >
        <v-btn
          value="write"
          :prepend-icon="mdiPencilOutline"
          :aria-pressed="mode === 'write' ? 'true' : 'false'"
          >Write</v-btn
        >
        <v-btn
          value="preview"
          :prepend-icon="mdiEyeOutline"
          :aria-pressed="mode === 'preview' ? 'true' : 'false'"
          >Preview</v-btn
        >
      </v-btn-toggle>
    </div>
    <v-textarea
      v-show="mode === 'write'"
      v-model="model"
      :label="props.label"
      :required="props.required"
      :disabled="props.disabled"
      :error-messages="messages"
      rows="8"
      auto-grow
      persistent-counter
      :counter-value="() => `${kib} of 64 KiB`"
      data-testid="markdown-input"
    />
    <v-card
      v-if="mode === 'preview'"
      variant="outlined"
      class="pa-4"
      data-testid="markdown-preview"
    >
      <p v-if="model.trim() === ''" class="text-medium-emphasis mb-0">Nothing to preview yet.</p>
      <MarkdownView v-else :source="model" :label="`${props.label} preview`" focusable />
      <div v-if="messages.length > 0" class="text-error text-body-2 mt-2" role="alert">
        {{ messages[0] }}
      </div>
    </v-card>
  </div>
</template>
