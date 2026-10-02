<script setup lang="ts">
/**
 * An accessible player for generated speech, with a download and the source text beside it.
 *
 * Built on a native `<audio controls>` rather than custom transport buttons. The native element
 * already provides play, pause, seeking, volume, and a time display; it is keyboard-operable, it is
 * announced correctly by screen readers, and it honours the operating system's media keys. A
 * hand-rolled player has to add all of that back and usually adds most of it.
 *
 * The **text alternative is the substance of this component**, not a decoration on it. Audio is the
 * one output format in this demo that some visitors cannot perceive at all, and a panel whose only
 * result is a waveform is a panel they cannot use. The passage that was spoken is therefore
 * rendered beside the player as a peer of it — not behind a disclosure, and not as a caption — so
 * the result is available in both forms at once. It is also the honest presentation: the text _is_
 * what the model was given, so showing it costs nothing and removes any doubt about what was read.
 */
import { computed, ref, watch } from 'vue';
import {
  AUDIO_FILE_EXTENSIONS,
  type AudioMediaType,
  type GeneratedSpeech
} from '../../../shared/read-text';
import { formatBytes } from './image-input';

const props = defineProps<{
  /**
   * The generated audio to play.
   */
  speech: GeneratedSpeech;
  /**
   * Playable URL for the audio, built by the panel.
   */
  src: string;
  /**
   * The passage that was spoken, rendered as the accessible equivalent of the audio.
   */
  text: string;
  /**
   * Run identifier, used to build a stable download file name.
   */
  runId: string;
  /**
   * Duration in seconds when the server could read it from the container, otherwise `undefined`.
   *
   * Only a hint. The player's own reported duration replaces it the moment the element has loaded
   * its metadata, because that figure is authoritative and the server's is an estimate from a
   * header.
   */
  durationSeconds?: number | undefined;
}>();

/**
 * Duration the player itself reported, or `undefined` before its metadata has loaded.
 */
const playerDuration = ref<number | undefined>(undefined);

// Reset when the audio changes. A duration left over from the previous run would otherwise be shown
// beside new audio for the moment before the element loads — a wrong number, briefly, which is
// worse than no number.
watch(
  () => props.src,
  () => {
    playerDuration.value = undefined;
  }
);

/**
 * The duration to display, preferring the player's own measurement.
 *
 * @returns The duration in seconds, or `undefined` when neither source has one yet.
 */
const duration = computed(() => playerDuration.value ?? props.durationSeconds);

/**
 * The duration as a short `m:ss` string.
 *
 * @returns The formatted duration, or an empty string when it is not known.
 */
const durationLabel = computed(() => {
  const seconds = duration.value;
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return '';
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  // Carries a 60-second rounding up into the minute, so 119.7 seconds reads as 2:00 rather than
  // the nonsensical 1:60.
  const [displayMinutes, displaySeconds] =
    remainder === 60 ? [minutes + 1, 0] : [minutes, remainder];

  return `${displayMinutes}:${String(displaySeconds).padStart(2, '0')}`;
});

/**
 * File name offered when the audio is downloaded.
 *
 * Built from the run identifier and the sniffed media type, never from the spoken text: a file name
 * derived from user content is a path-traversal and header-injection surface for no real benefit.
 *
 * @returns The download file name.
 */
const downloadName = computed(
  () =>
    `playground-${props.runId}.${AUDIO_FILE_EXTENSIONS[props.speech.mediaType as AudioMediaType]}`
);

/**
 * Records the duration once the element knows it.
 *
 * @param event The element's `loadedmetadata` event.
 * @returns Nothing; the reported duration is stored.
 */
function captureDuration(event: Event): void {
  const element = event.target as HTMLAudioElement;
  // `Infinity` for a stream whose length is unknown, and `NaN` before metadata is parsed. Neither
  // is a duration, and both would render as nonsense.
  if (Number.isFinite(element.duration)) {
    playerDuration.value = element.duration;
  }
}
</script>

<template>
  <div class="player">
    <!--
      `preload="metadata"` so the duration is available without fetching the whole payload. Here
      the payload is already in the page as a `data:` URI, so this costs nothing — but stating the
      intent keeps the element correct if the source ever becomes a URL.
    -->
    <audio
      class="audio"
      controls
      preload="metadata"
      :src="props.src"
      @loadedmetadata="captureDuration"
    >
      <!--
        Fallback for a browser that cannot play the element at all. It names the format rather than
        apologising generically, and the download link beside it still works.
      -->
      Your browser cannot play {{ props.speech.mediaType }} audio. Use the download link below to
      listen in another application.
    </audio>

    <div class="meta">
      <dl class="facts">
        <div class="fact">
          <dt>Format</dt>
          <dd>{{ props.speech.mediaType }}</dd>
        </div>
        <div v-if="durationLabel" class="fact">
          <dt>Duration</dt>
          <dd>{{ durationLabel }}</dd>
        </div>
        <div class="fact">
          <dt>Size</dt>
          <dd>{{ formatBytes(props.speech.byteLength) }}</dd>
        </div>
      </dl>

      <a class="download" :download="downloadName" :href="props.src">Download audio</a>
    </div>

    <!--
      The text alternative, as a peer of the player rather than hidden behind a disclosure. A
      visitor who cannot hear the audio gets the full result here, and anyone comparing two voices
      can see exactly which words were given to the model.
    -->
    <section class="alternative" aria-labelledby="spoken-text-heading">
      <h3 id="spoken-text-heading" class="alternative-heading">Text that was read</h3>
      <p class="spoken-text">{{ props.text }}</p>
    </section>
  </div>
</template>

<style scoped>
.player {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

/*
  Full width so the native control's seek bar is long enough to be usable. A narrow audio element
  makes seeking a precision exercise, which is exactly the kind of avoidable friction a native
  control is supposed to remove.
*/
.audio {
  width: 100%;
}

.meta {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 1.5rem;
  justify-content: space-between;
}

.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 1.5rem;
  margin: 0;
}

.fact dt {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
}

.fact dd {
  margin: 0;
}

.download {
  min-height: 2.25rem;
}

.alternative {
  background-color: rgb(var(--v-theme-surface-variant));
  border-radius: 0.5rem;
  padding: 0.75rem;
}

.alternative-heading {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
  font-weight: 600;
  margin: 0 0 0.375rem;
}

/*
  `pre-wrap` so the passage's own line breaks survive. Punctuation and line structure are what the
  model reads for pacing, so collapsing them here would misrepresent what was actually spoken.
*/
.spoken-text {
  margin: 0;
  white-space: pre-wrap;
}
</style>
