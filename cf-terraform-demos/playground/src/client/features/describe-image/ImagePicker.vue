<script setup lang="ts">
/**
 * Choosing a picture: a file button, a drop zone, and paste support, over one hidden file input.
 *
 * All three routes converge on a single `selected` event, so the panel has one place that accepts a
 * picture and the component owns none of the validation. Three routes rather than one because the
 * likeliest thing a visitor wants described is a screenshot, and making them save it to disk first
 * would be the slowest path to the thing the panel exists to do.
 */
import { ref } from 'vue';
import { formatBytes, imageFromClipboard, UPLOAD_ACCEPT_ATTRIBUTE } from './image-input';
import type { PreparedImage } from './image-input';

const props = defineProps<{
  /**
   * The currently chosen picture, or `undefined` when none has been selected.
   */
  image: PreparedImage | undefined;
  /**
   * Whether a run is in flight, which locks the picture for its duration.
   */
  busy: boolean;
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

const fileInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);

/**
 * Opens the file picker.
 *
 * @returns Nothing.
 */
function openPicker(): void {
  fileInput.value?.click();
}

/**
 * Handles a file chosen through the picker.
 *
 * @param event The input's change event.
 * @returns Nothing; the file is emitted if one was chosen.
 */
function onFileChange(event: Event): void {
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
 * Handles a dropped file.
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
 * Handles a pasted picture.
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
  <section class="picker" aria-labelledby="picker-heading">
    <h2 id="picker-heading" class="section-heading">Choose a picture</h2>

    <!--
      `@paste` on the region with `tabindex="0"` so a keyboard user can focus it and paste. A paste
      handler on `document` would be less code and would also hijack pasting into the question
      field, which is the one place a visitor is most likely to paste text.
    -->
    <div
      class="dropzone"
      :class="{ 'dropzone--active': dragging, 'dropzone--filled': props.image !== undefined }"
      tabindex="0"
      role="group"
      aria-labelledby="dropzone-label"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
      @paste="onPaste"
    >
      <template v-if="props.image === undefined">
        <p id="dropzone-label" class="dropzone-text">
          Drop a picture here, paste one, or
          <button type="button" class="link-button" :disabled="props.busy" @click="openPicker">
            choose a file
          </button>
        </p>
        <p class="dropzone-hint">PNG, JPEG, or WebP.</p>
      </template>

      <template v-else>
        <span id="dropzone-label" class="visually-hidden">Chosen picture</span>
        <!--
          The alt text says what this is rather than describing the contents. Nothing here has
          looked at the picture yet — that is the whole point of the panel — so claiming to
          describe it would be a fabrication, and the real description appears below once the
          model has produced one.
        -->
        <img
          :src="props.image.previewUri"
          class="preview"
          alt="The picture you chose to describe"
        />
        <div class="file-facts">
          <p class="file-name">{{ props.image.fileName }}</p>
          <p class="file-size">{{ formatBytes(props.image.byteLength) }}</p>
        </div>
        <div class="picker-actions">
          <v-btn
            class="replace-button"
            variant="outlined"
            size="small"
            :disabled="props.busy"
            @click="openPicker"
          >
            Replace
          </v-btn>
          <v-btn
            class="remove-button"
            variant="text"
            size="small"
            :disabled="props.busy"
            @click="emit('cleared')"
          >
            Remove
          </v-btn>
        </div>
      </template>
    </div>

    <!--
      Needs its own `aria-label`. The input is visually hidden and has no visible label of its
      own — the "choose a file" button is what a sighted visitor sees — so without this it reaches
      the accessibility tree as an unnamed file control. It is still focusable rather than
      `display: none`, so a keyboard user can genuinely land on it.
    -->
    <input
      ref="fileInput"
      class="visually-hidden"
      type="file"
      aria-label="Choose a picture to describe"
      :accept="UPLOAD_ACCEPT_ATTRIBUTE"
      @change="onFileChange"
    />
  </section>
</template>

<style scoped>
.section-heading {
  font-size: 1.125rem;
  margin: 0 0 0.75rem;
}

/*
  `box-sizing: border-box` so the padding counts inside the width rather than being added to it,
  and `min-width: 0` so the zone can shrink below its content's intrinsic width on a phone.
*/
.dropzone {
  align-items: center;
  border: 2px dashed rgb(var(--v-theme-outline));
  border-radius: 0.75rem;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  justify-content: center;
  max-width: 36rem;
  min-height: 10rem;
  min-width: 0;
  padding: 1.25rem;
  text-align: center;
  width: 100%;
}

.dropzone:focus-visible {
  border-color: rgb(var(--v-theme-primary));
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.dropzone--active {
  background-color: rgb(var(--v-theme-surface-variant));
  border-color: rgb(var(--v-theme-primary));
}

.dropzone--filled {
  border-style: solid;
}

.dropzone-text {
  margin: 0;
}

.dropzone-hint {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
  margin: 0;
}

.link-button {
  background: none;
  border: none;
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
  Capped by viewport height as well as width: a tall, narrow picture sized only by width would
  push the question field and the Describe button off the screen entirely.
*/
.preview {
  border-radius: 0.5rem;
  max-height: 20rem;
  max-width: 100%;
  object-fit: contain;
}

.file-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: center;
}

.file-name {
  margin: 0;
  overflow-wrap: anywhere;
}

.file-size {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0;
}

.picker-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: center;
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
