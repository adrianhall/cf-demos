<script setup lang="ts">
/**
 * Selects a source or mask image without coupling Remix Image to Describe Image presentation.
 */
import { shallowRef } from 'vue';
import {
  formatBytes,
  imageFromClipboard,
  UPLOAD_ACCEPT_ATTRIBUTE,
  type PreparedImage
} from '../describe-image/image-input';

const props = defineProps<{
  /**
   * Visible control label.
   */
  label: string;
  /**
   * Currently selected image.
   */
  image: PreparedImage | undefined;
  /**
   * Disables mutation while a run is in flight.
   */
  busy: boolean;
  /**
   * Whether this picker is optional.
   */
  optional?: boolean;
}>();

const emit = defineEmits<{
  /**
   * Visitor selected, dropped, or pasted a file.
   */
  selected: [file: File];
  /**
   * Visitor cleared the selected image.
   */
  cleared: [];
}>();

const fileInput = shallowRef<HTMLInputElement | null>(null);
const dragging = shallowRef(false);

/**
 * Opens the native file chooser.
 */
function openPicker(): void {
  fileInput.value?.click();
}

/**
 * Emits the chosen file and resets the native input.
 */
function onChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file !== undefined) emit('selected', file);
  input.value = '';
}

/**
 * Emits the first dropped file.
 */
function onDrop(event: DragEvent): void {
  dragging.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file !== undefined) emit('selected', file);
}

/**
 * Emits a usable pasted image without hijacking pasted text elsewhere.
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
  <section class="picker" :aria-labelledby="`${label}-heading`">
    <h3 :id="`${label}-heading`" class="heading">
      {{ label }} <span v-if="optional" class="optional">(optional)</span>
    </h3>
    <div
      class="dropzone"
      :class="{ 'dropzone--active': dragging, 'dropzone--filled': props.image !== undefined }"
      tabindex="0"
      role="group"
      :aria-label="`${label}: drop, paste, or choose a file`"
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
        <img :src="props.image.previewUri" class="preview" :alt="`${label} preview`" />
        <p class="facts">{{ props.image.fileName }} · {{ formatBytes(props.image.byteLength) }}</p>
        <div class="actions">
          <button type="button" :disabled="props.busy" @click="openPicker">Replace</button>
          <button type="button" :disabled="props.busy" @click="emit('cleared')">Remove</button>
        </div>
      </template>
    </div>
    <input
      ref="fileInput"
      class="visually-hidden"
      type="file"
      :aria-label="`Choose ${label.toLowerCase()}`"
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
.dropzone {
  align-items: center;
  border: 2px dashed rgb(var(--v-theme-outline));
  border-radius: 0.75rem;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  justify-content: center;
  min-height: 8rem;
  padding: 1rem;
  text-align: center;
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
