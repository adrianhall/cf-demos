<script setup lang="ts">
/**
 * Choosing audio: a file button, a drop zone, and an optional microphone recorder.
 *
 * The microphone is a **progressive enhancement and nothing more**. The upload path is complete on
 * its own, the record button is absent entirely on a browser without `MediaRecorder` or a secure
 * context, and a denied permission leaves every other route working. That ordering is deliberate: a
 * panel that led with recording would be unusable for anyone who declines, and declining is a
 * reasonable thing to do when a page asks to listen to you.
 *
 * Permission states are rendered distinctly rather than collapsed into "not recording", because
 * they need opposite advice. A denial is a decision the visitor can revisit in their browser's
 * settings; a device failure is something retrying might genuinely fix.
 *
 * The heading is an `h3` because this always sits inside a panel section that already has an `h2`.
 */
import { computed, shallowRef } from 'vue';
import {
  AUDIO_UPLOAD_ACCEPT_ATTRIBUTE,
  formatAudioBytes,
  type PreparedAudio,
  type RecordingState
} from './audio-input';

const props = defineProps<{
  /**
   * The currently selected audio, or `undefined` when none has been chosen.
   */
  audio: PreparedAudio | undefined;
  /**
   * Whether a run is in flight, which locks the selection for its duration.
   */
  busy: boolean;
  /**
   * Where the microphone flow stands; see {@link RecordingState}.
   */
  recordingState: RecordingState;
  /**
   * How many seconds the current recording has been running.
   */
  recordingSeconds: number;
  /**
   * Largest file the selected model accepts, in bytes, so the hint can name the real limit.
   */
  maxBytes: number;
}>();

const emit = defineEmits<{
  /**
   * A file was chosen or dropped.
   */
  selected: [file: File];
  /**
   * The chosen audio was removed.
   */
  cleared: [];
  /**
   * Recording should start.
   */
  record: [];
  /**
   * Recording should stop.
   */
  stop: [];
}>();

const fileInput = shallowRef<HTMLInputElement | null>(null);
const dragging = shallowRef(false);

/**
 * Whether the browser can record at all.
 *
 * @returns `true` when the microphone route should be offered.
 */
const canRecord = computed(() => props.recordingState !== 'unsupported');

/**
 * Whether a recording is currently running.
 *
 * @returns `true` while capturing.
 */
const recording = computed(() => props.recordingState === 'recording');

/**
 * The elapsed recording time as `m:ss`.
 *
 * @returns The formatted duration.
 */
const elapsed = computed(() => {
  const minutes = Math.floor(props.recordingSeconds / 60);
  const seconds = props.recordingSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
});

/**
 * Advice matching the current permission state, or an empty string when none is needed.
 *
 * Each message says what to do next rather than only what happened, because "permission denied" on
 * its own leaves a visitor with no route back to a working panel.
 *
 * @returns The message to show.
 */
const recordingMessage = computed(() => {
  switch (props.recordingState) {
    case 'requesting': {
      return 'Waiting for microphone permission. Your browser should be asking now.';
    }
    case 'denied': {
      return (
        'Microphone access was denied, so recording is unavailable. You can still upload a file, '
        + 'or allow the microphone for this site in your browser settings and try again.'
      );
    }
    case 'failed': {
      return (
        'The microphone could not be started. Check that another application is not using it, '
        + 'then try again — or upload a file instead.'
      );
    }
    default: {
      return '';
    }
  }
});

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
  // would not — a visitor who removed a file and re-picked it would see nothing happen.
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
</script>

<template>
  <section class="picker" aria-labelledby="audio-picker-heading">
    <h3 id="audio-picker-heading" class="heading">Audio to transcribe</h3>

    <div
      class="dropzone"
      :class="{ 'dropzone--active': dragging, 'dropzone--filled': props.audio !== undefined }"
      role="group"
      aria-label="Audio to transcribe: drop or choose a file"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <template v-if="props.audio === undefined">
        <p class="drop-text">
          Drop an audio file here, or
          <button type="button" class="link-button" :disabled="props.busy" @click="openPicker">
            choose a file
          </button>
        </p>
        <p class="hint">
          MP3, WAV, Ogg, WebM, or MP4, up to {{ formatAudioBytes(props.maxBytes) }} for the selected
          model.
        </p>
      </template>

      <template v-else>
        <!--
          A playable preview, so a visitor can confirm they loaded the right recording before
          spending credit on it. Native controls for the same reasons the Read Text player uses
          them: keyboard-operable and correctly announced without reimplementation.
        -->
        <audio class="preview" controls preload="metadata" :src="props.audio.previewUri"></audio>
        <p class="facts">
          {{ props.audio.fileName }} · {{ formatAudioBytes(props.audio.byteLength) }}
          <span v-if="props.audio.recorded" class="badge">Recorded here</span>
        </p>
        <div class="actions">
          <button type="button" :disabled="props.busy" @click="openPicker">Replace</button>
          <button type="button" :disabled="props.busy" @click="emit('cleared')">Remove</button>
        </div>
      </template>
    </div>

    <!--
      Rendered only when the browser can actually record. A disabled button would imply the feature
      exists and is temporarily unavailable, when the truth is that this browser cannot do it.
    -->
    <div v-if="canRecord" class="recorder">
      <button
        type="button"
        class="record-button"
        :class="{ 'record-button--active': recording }"
        :disabled="props.busy || props.recordingState === 'requesting'"
        @click="recording ? emit('stop') : emit('record')"
      >
        {{ recording ? `Stop recording (${elapsed})` : 'Record from microphone' }}
      </button>

      <!--
        A live region so the state change is announced. Recording is the one flow here where a
        visitor may not be looking at the screen — they are, after all, talking.
      -->
      <p v-if="recording" class="recording-status" role="status">
        Recording. {{ elapsed }} elapsed.
      </p>
    </div>

    <p v-if="recordingMessage" class="recording-message" role="status">{{ recordingMessage }}</p>

    <!--
      Needs its own `aria-label`. The input is visually hidden and has no visible label of its own,
      so without this it reaches the accessibility tree as an unnamed file control. It stays
      focusable rather than `display: none`, so a keyboard user can genuinely land on it.
    -->
    <input
      ref="fileInput"
      class="visually-hidden"
      type="file"
      aria-label="Choose an audio file"
      :accept="AUDIO_UPLOAD_ACCEPT_ATTRIBUTE"
      @change="onChange"
    />
  </section>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
}

.heading {
  font-size: 1rem;
  margin: 0;
}

.hint,
.facts,
.recording-message {
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

.link-button:focus-visible,
.actions button:focus-visible,
.record-button:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.drop-text,
.hint,
.facts,
.recording-message,
.recording-status {
  margin: 0;
  overflow-wrap: anywhere;
}

.hint,
.recording-message,
.recording-status {
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

.preview {
  max-width: 100%;
  width: 100%;
}

.badge {
  background-color: rgb(var(--v-theme-surface-variant));
  border-radius: 999px;
  font-size: 0.75rem;
  margin-left: 0.4rem;
  padding: 0.1rem 0.5rem;
}

.actions {
  display: flex;
  gap: 0.5rem;
}

.actions button,
.record-button {
  background: transparent;
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.35rem;
  color: inherit;
  cursor: pointer;
  font: inherit;
  min-height: 2.25rem;
  padding: 0.25rem 0.75rem;
}

.record-button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

/*
  A colour change alone would not distinguish the active state for a visitor who cannot perceive
  it, so the button's own text changes to "Stop recording" as well.
*/
.record-button--active {
  border-color: rgb(var(--v-theme-error));
  color: rgb(var(--v-theme-error));
}

.recorder {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
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
