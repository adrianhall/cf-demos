<script setup lang="ts">
/**
 * Choosing a picture: a file button, a drop zone, and paste support, over one hidden file input.
 *
 * Shared by every panel that takes an uploaded picture. All three routes converge on a single
 * `selected` event, so a panel has one place that accepts a picture and this component owns none of
 * the validation — the composable validates, and the server validates again on bytes.
 *
 * Three routes rather than one because the likeliest thing a visitor wants to use is a screenshot,
 * and making them save it to disk first would be the slowest path to the thing the panel exists to
 * do.
 *
 * The heading is an `h3` because this always sits inside a panel section that already has an `h2`;
 * a second `h2` would flatten the outline a screen reader navigates by.
 *
 * The `label` is the panel's own word for what it is collecting, which is also what the alt text
 * and the file input's accessible name are built from. Nothing here describes the picture's
 * contents: no panel has looked at it yet when this renders, so the alt text says what the picture
 * _is to the panel_ rather than claiming to know what is in it.
 */
import { computed, shallowRef } from 'vue';
import {
  formatBytes,
  imageFromClipboard,
  UPLOAD_ACCEPT_ATTRIBUTE,
  type PreparedImage
} from './image-input';

const props = defineProps<{
  /**
   * Visible heading, and the basis of every accessible name this component generates.
   */
  label: string;
  /**
   * The currently selected picture, or `undefined` when none has been chosen.
   */
  image: PreparedImage | undefined;
  /**
   * Whether a run is in flight, which locks the picture for its duration.
   */
  busy: boolean;
  /**
   * Whether this picker may be left empty, marked in the heading when so.
   */
  optional?: boolean;
}>();

const emit = defineEmits<{
  /**
   * A picture was chosen by any of the three routes.
   */
  selected: [file: File];
  /**
   * The chosen picture was removed.
   */
  cleared: [];
}>();

const fileInput = shallowRef<HTMLInputElement | null>(null);
const dragging = shallowRef(false);

/**
 * A DOM-id-safe slug derived from the label.
 *
 * The heading's id has to be referenced by `aria-labelledby`, so it cannot contain the spaces a
 * human-readable label does. Deriving it rather than taking a second prop keeps the two from
 * drifting apart, which is the usual way a labelled region quietly loses its name.
 */
const slug = computed(() =>
  props.label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
);

/**
 * Opens the native file chooser.
 *
 * @returns Nothing.
 */
function openPicker(): void {
  fileInput.value?.click();
}

/**
 * Emits the chosen file and resets the native input.
 *
 * @param event The input's change event.
 * @returns Nothing; the file is emitted if one was chosen.
 */
function onChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file !== undefined) {
    emit('selected', file);
  }
  // Reset so choosing the same file twice in a row still fires a change event, which it otherwise
  // would not — a visitor who removed a picture and re-picked it would see nothing happen.
  input.value = '';
}

/**
 * Emits the first dropped file.
 *
 * @param event The drop event.
 * @returns Nothing; the first file is emitted if one was dropped.
 */
function onDrop(event: DragEvent): void {
  dragging.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file !== undefined) {
    emit('selected', file);
  }
}

/**
 * Emits a usable pasted picture without hijacking pasted text elsewhere.
 *
 * @param event The paste event.
 * @returns Nothing; a pasted picture is emitted, and pasted text is ignored.
 */
function onPaste(event: ClipboardEvent): void {
  const file = imageFromClipboard(event.clipboardData?.items);
  if (file !== undefined) {
    event.preventDefault();
    emit('selected', file);
  }
}
</script>

<template>
  <section class="picker" :aria-labelledby="`${slug}-heading`">
    <h3 :id="`${slug}-heading`" class="heading">
      {{ props.label }}
      <span v-if="props.optional" class="optional">(optional)</span>
    </h3>

    <!--
      `@paste` on the region with `tabindex="0"` so a keyboard user can focus it and paste. A paste
      handler on `document` would be less code and would also hijack pasting into any text field
      the panel has, which is the one place a visitor is most likely to paste text.
    -->
    <div
      class="dropzone"
      :class="{ 'dropzone--active': dragging, 'dropzone--filled': props.image !== undefined }"
      tabindex="0"
      role="group"
      :aria-label="`${props.label}: drop, paste, or choose a file`"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
      @paste="onPaste"
    >
      <template v-if="props.image === undefined">
        <p class="drop-text">
          Drop a picture here, paste one, or
          <button type="button" class="link-button" :disabled="props.busy" @click="openPicker">
            choose a file
          </button>
        </p>
        <p class="hint">PNG, JPEG, or WebP.</p>
      </template>

      <template v-else>
        <!--
          The alt text names the picker's purpose rather than describing the contents. Nothing has
          looked at this picture yet, so claiming to describe it would be a fabrication aimed at
          the one user who cannot check.
        -->
        <img :src="props.image.previewUri" class="preview" :alt="`${props.label} preview`" />
        <p class="facts">{{ props.image.fileName }} · {{ formatBytes(props.image.byteLength) }}</p>
        <div class="actions">
          <button type="button" :disabled="props.busy" @click="openPicker">Replace</button>
          <button type="button" :disabled="props.busy" @click="emit('cleared')">Remove</button>
        </div>
      </template>
    </div>

    <!--
      Needs its own `aria-label`. The input is visually hidden and has no visible label of its
      own — the "choose a file" button is what a sighted visitor sees — so without this it reaches
      the accessibility tree as an unnamed file control. It stays focusable rather than
      `display: none`, so a keyboard user can genuinely land on it.
    -->
    <input
      ref="fileInput"
      class="visually-hidden"
      type="file"
      :aria-label="`Choose ${props.label.toLowerCase()}`"
      :accept="UPLOAD_ACCEPT_ATTRIBUTE"
      @change="onChange"
    />
  </section>
</template>

<style scoped>
.heading {
  font-size: 1rem;
  margin: 0 0 0.5rem;
}

.optional,
.hint,
.facts {
  color: rgb(var(--v-theme-on-surface-variant));
  font-weight: normal;
}

/*
  `box-sizing: border-box` so the padding counts inside the declared width rather than being added
  to it, and `min-width: 0` so the zone can shrink below its content's intrinsic width on a phone.
*/
.dropzone {
  align-items: center;
  border: 2px dashed rgb(var(--v-theme-outline));
  border-radius: 0.75rem;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  justify-content: center;
  max-width: 36rem;
  min-height: 8rem;
  min-width: 0;
  padding: 1rem;
  text-align: center;
  width: 100%;
}

.dropzone--active {
  background-color: rgb(var(--v-theme-surface-variant));
  border-color: rgb(var(--v-theme-primary));
}

.dropzone--filled {
  border-style: solid;
}

.dropzone:focus-visible,
.link-button:focus-visible,
.actions button:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.drop-text,
.hint,
.facts {
  margin: 0;
  overflow-wrap: anywhere;
}

.hint {
  font-size: 0.8125rem;
}

.link-button {
  background: none;
  border: 0;
  color: rgb(var(--v-theme-primary));
  cursor: pointer;
  font: inherit;
  padding: 0;
  text-decoration: underline;
}

.link-button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

/*
  Capped by height as well as width: a tall, narrow picture sized only by width would push the
  panel's primary action off the screen entirely.
*/
.preview {
  border-radius: 0.5rem;
  max-height: 16rem;
  max-width: 100%;
  object-fit: contain;
}

.actions {
  display: flex;
  gap: 0.5rem;
}

.actions button {
  background: transparent;
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.35rem;
  color: inherit;
  cursor: pointer;
  min-height: 2.25rem;
  padding: 0.25rem 0.6rem;
}

/*
  Visually hidden but still focusable and still announced. `display: none` would remove the file
  input from the accessibility tree and stop the label being read.
*/
.visually-hidden {
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  height: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
  width: 1px;
}
</style>
