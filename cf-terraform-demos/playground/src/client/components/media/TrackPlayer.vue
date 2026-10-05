<script setup lang="ts">
/**
 * An accessible player for a generated music track, with transport shortcuts, a download, and the
 * lyrics beside it.
 *
 * Built on a native `<audio controls>` for the same reasons Read Text's player is: the native
 * element already provides play, pause, seeking, volume, and a time display; it is
 * keyboard-operable and announced correctly by screen readers; and it honours the operating
 * system's media keys. A hand-rolled transport has to add all of that back and usually adds most of
 * it.
 *
 * What this component adds on top, and why it is not duplication. **A music track is long enough
 * that seeking matters.** Read Text produces a sentence or two; a track here runs up to two
 * minutes, and a visitor comparing the opening of two tracks wants to jump back to the start rather
 * than drag a thin progress bar to roughly the right place. So there are three real `<button>`
 * controls — restart, back ten seconds, forward ten seconds — which are keyboard-reachable and
 * labelled by construction, plus arrow and `Home` shortcuts that work while focus is anywhere in
 * the player card. The shortcuts deliberately **ignore events that originate on the audio element
 * itself**, so the browser's own arrow-key seeking keeps working when the native control has focus
 * rather than being overridden by a worse version of itself.
 *
 * **No waveform.** The phase brief asked for one "if practical without a heavy dependency", and it
 * is not: drawing a real waveform means decoding the audio with `AudioContext.decodeAudioData` and
 * reducing a couple of million samples per track in the main thread, or adding a visualisation
 * package. A decorative shape that did not correspond to the audio would be worse than none — it
 * would be a picture of a different track. The duration, format, and size are reported as text
 * instead, which is the information a waveform would have been standing in for.
 *
 * **The lyrics are a peer of the player, not a caption.** Audio is the one output in this demo that
 * some visitors cannot perceive at all, so the words — when there are words, and when the model
 * returned or was given them — are rendered beside the player rather than behind a disclosure.
 */
import { computed, ref, watch } from 'vue';
import {
  MUSIC_FILE_EXTENSIONS,
  type GeneratedTrack,
  type MusicLyricsSource
} from '../../../shared/generate-music';
import { formatBytes } from './image-input';

/**
 * How many seconds a skip control moves by.
 *
 * Ten rather than five: a track here is tens of seconds long, so a five-second step would need
 * several presses to cross a section.
 */
const SKIP_SECONDS = 10;

const props = defineProps<{
  /**
   * The generated track to play.
   */
  track: GeneratedTrack;
  /**
   * Playable URL for the audio, built by the panel.
   */
  src: string;
  /**
   * The prompt the track was generated from, used as the player's accessible name so the control is
   * distinguishable from any other on the page.
   */
  prompt: string;
  /**
   * Run identifier, used to build a stable download file name.
   */
  runId: string;
  /**
   * Where the lyrics came from; see {@link MusicLyricsSource}.
   *
   * Drives what is said when there are no words to show. "This is an instrumental track" and "the
   * model wrote the lyrics and did not return them" are different facts, and collapsing them into
   * an empty panel would make the second look like a rendering fault.
   */
  lyricsSource: MusicLyricsSource;
  /**
   * The lyrics the track was sung from, when they are known.
   *
   * Only ever present for `caller` lyrics. A model that wrote its own words returns audio and
   * nothing else, which is a contract fact rather than an omission here.
   */
  lyrics?: string | undefined;
}>();

/**
 * The audio element, so the transport controls can act on it.
 */
const audio = ref<HTMLAudioElement | null>(null);

/**
 * Duration the player itself reported, or `undefined` before its metadata has loaded.
 */
const playerDuration = ref<number | undefined>(undefined);

// Reset when the audio changes. A duration left over from the previous run would otherwise be shown
// beside new audio for the moment before the element loads — a wrong number, briefly, and on this
// panel a wrong number next to a per-second price.
watch(
  () => props.src,
  () => {
    playerDuration.value = undefined;
  }
);

/**
 * The duration to display, preferring the player's own measurement.
 *
 * The server can only read a duration from a WAV header; for the MP3 formats both models return by
 * default it reports nothing rather than assuming a constant bitrate. The element's figure is
 * authoritative once it has loaded, so it wins whenever it exists.
 *
 * @returns The duration in seconds, or `undefined` when neither source has one yet.
 */
const duration = computed(() => playerDuration.value ?? props.track.durationSeconds);

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
  // Carries a 60-second rounding up into the minute, so 119.7 seconds reads as 2:00 rather than the
  // nonsensical 1:60.
  const [displayMinutes, displaySeconds] =
    remainder === 60 ? [minutes + 1, 0] : [minutes, remainder];

  return `${displayMinutes}:${String(displaySeconds).padStart(2, '0')}`;
});

/**
 * File name offered when the track is downloaded.
 *
 * Built from the run identifier and the sniffed media type, never from the prompt or the lyrics: a
 * file name derived from user content is a path-traversal and header-injection surface for no real
 * benefit.
 *
 * @returns The download file name.
 */
const downloadName = computed(
  () => `playground-track-${props.runId}.${MUSIC_FILE_EXTENSIONS[props.track.mediaType]}`
);

/**
 * What to say about the lyrics when there are none to display.
 *
 * @returns The sentence, or an empty string when lyrics are being shown instead.
 */
const lyricsNote = computed(() => {
  if (props.lyricsSource === 'caller' && props.lyrics !== undefined) {
    return '';
  }
  if (props.lyricsSource === 'none') {
    return 'This is an instrumental track, so there are no lyrics.';
  }
  if (props.lyricsSource === 'model') {
    return (
      'The model wrote the lyrics from your prompt and charged separately for doing so, but it '
      + 'returns only the audio — the words exist in the recording and nowhere else, so there is '
      + 'nothing to print here.'
    );
  }
  return '';
});

/**
 * Records the duration once the element knows it.
 *
 * @param event The element's `loadedmetadata` event.
 * @returns Nothing; the reported duration is stored.
 */
function captureDuration(event: Event): void {
  const element = event.target as HTMLAudioElement;
  // `Infinity` for a stream whose length is unknown, and `NaN` before metadata is parsed. Neither is
  // a duration, and both would render as nonsense.
  if (Number.isFinite(element.duration)) {
    playerDuration.value = element.duration;
  }
}

/**
 * Moves playback to the start of the track.
 *
 * @returns Nothing; the element's position is reset.
 */
function restart(): void {
  const element = audio.value;
  if (element !== null) {
    element.currentTime = 0;
  }
}

/**
 * Moves playback by a number of seconds, staying inside the track.
 *
 * Clamped at both ends rather than left to the element: seeking past the end of a track restarts
 * some browsers' playback, and seeking to a negative time is simply invalid.
 *
 * @param offsetSeconds How far to move; negative moves backwards.
 * @returns Nothing; the element's position is updated.
 */
function skip(offsetSeconds: number): void {
  const element = audio.value;
  if (element === null) {
    return;
  }

  const limit = Number.isFinite(element.duration) ? element.duration : (duration.value ?? 0);
  const target = element.currentTime + offsetSeconds;
  element.currentTime = Math.min(Math.max(target, 0), limit);
}

/**
 * Toggles playback.
 *
 * @returns Nothing; the element is played or paused. A rejected `play()` promise — which a browser
 *   returns when autoplay policy refuses the call — is swallowed deliberately: it is the browser
 *   declining, not an error the visitor can act on, and an unhandled rejection in the console would
 *   suggest otherwise.
 */
function togglePlayback(): void {
  const element = audio.value;
  if (element === null) {
    return;
  }

  if (element.paused) {
    void element.play()?.catch(() => undefined);
  } else {
    element.pause();
  }
}

/**
 * Handles a transport shortcut pressed anywhere in the player card.
 *
 * Events originating on the audio element itself are left alone, so the browser's own keyboard
 * handling keeps working when the native control has focus. Reimplementing it there would replace a
 * well-tested behaviour with a worse one.
 *
 * @param event The keyboard event.
 * @returns Nothing; the matching transport action has been performed and the event's default
 *   prevented, so `Home` does not also scroll the page.
 */
function handleShortcut(event: KeyboardEvent): void {
  if (event.target === audio.value) {
    return;
  }

  switch (event.key) {
    case 'ArrowLeft':
      skip(-SKIP_SECONDS);
      break;
    case 'ArrowRight':
      skip(SKIP_SECONDS);
      break;
    case 'Home':
      restart();
      break;
    // `k` is the play/pause key every major video site has settled on, so it is the one a visitor is
    // most likely to try. Space is deliberately *not* bound: it is how a keyboard user activates the
    // focused button, and stealing it would break the skip controls beside it.
    case 'k':
      togglePlayback();
      break;
    default:
      return;
  }

  event.preventDefault();
}
</script>

<template>
  <div class="track-player" @keydown="handleShortcut">
    <!--
      `preload="metadata"` so the duration is available without decoding the whole payload. The
      payload is already in the page as a `data:` URI, so this costs nothing — but stating the
      intent keeps the element correct if the source ever becomes a URL.
    -->
    <audio
      ref="audio"
      class="audio"
      controls
      preload="metadata"
      :src="props.src"
      :aria-label="`Generated track for: ${props.prompt}`"
      @loadedmetadata="captureDuration"
    >
      <!--
        Fallback for a browser that cannot play the element at all. It names the format rather than
        apologising generically, and the download link beside it still works.
      -->
      Your browser cannot play {{ props.track.mediaType }} audio. Use the download link below to
      listen in another application.
    </audio>

    <div class="transport" role="group" aria-label="Track transport">
      <button type="button" class="transport-button" data-transport="restart" @click="restart">
        Restart
      </button>
      <button
        type="button"
        class="transport-button"
        data-transport="back"
        @click="skip(-SKIP_SECONDS)"
      >
        Back {{ SKIP_SECONDS }}s
      </button>
      <button
        type="button"
        class="transport-button"
        data-transport="forward"
        @click="skip(SKIP_SECONDS)"
      >
        Forward {{ SKIP_SECONDS }}s
      </button>
    </div>

    <!--
      Stated rather than left to be discovered. A shortcut nobody knows about is a shortcut nobody
      uses, and the sentence is also where the deliberate absence of a Space binding is explained.
    -->
    <p class="shortcuts">
      With the player card focused: <kbd>←</kbd> and <kbd>→</kbd> skip {{ SKIP_SECONDS }} seconds,
      <kbd>Home</kbd> restarts, and <kbd>k</kbd> plays or pauses. Space is left to the buttons, and
      the player itself keeps its own browser shortcuts.
    </p>

    <div class="meta">
      <dl class="facts">
        <div class="fact">
          <dt>Format</dt>
          <dd>{{ props.track.mediaType }}</dd>
        </div>
        <div v-if="durationLabel" class="fact">
          <dt>Length</dt>
          <dd>{{ durationLabel }}</dd>
        </div>
        <div class="fact">
          <dt>Size</dt>
          <dd>{{ formatBytes(props.track.byteLength) }}</dd>
        </div>
      </dl>

      <a class="download" :download="downloadName" :href="props.src">Download track</a>
    </div>

    <!--
      The lyrics region is always present, because its *absence* is as informative as its content on
      this panel: an instrumental track and a model-written track with unreturned words are two
      different facts, and an empty box would represent neither.
    -->
    <section class="lyrics" aria-labelledby="track-lyrics-heading">
      <h3 id="track-lyrics-heading" class="lyrics-heading">Lyrics</h3>
      <p v-if="lyricsNote" class="lyrics-note">{{ lyricsNote }}</p>
      <p v-else class="lyrics-text">{{ props.lyrics }}</p>
    </section>
  </div>
</template>

<style scoped>
.track-player {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
  min-width: 0;
}

/*
  Full width so the native control's seek bar is long enough to be usable. A narrow audio element
  makes seeking a precision exercise, which is exactly the friction a native control removes.
*/
.audio {
  width: 100%;
}

.transport {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.transport-button {
  background-color: rgb(var(--v-theme-surface-variant));
  border: 1px solid rgb(var(--v-theme-outline-variant));
  border-radius: 999px;
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  /* Comfortably above WCAG 2.2's 24px minimum target size. */
  min-height: 2.25rem;
  padding: 0.375rem 0.875rem;
}

.transport-button:hover,
.transport-button:focus-visible {
  border-color: rgb(var(--v-theme-primary));
}

.transport-button:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.shortcuts {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
  margin: 0;
}

.shortcuts kbd {
  background-color: rgb(var(--v-theme-surface-variant));
  border: 1px solid rgb(var(--v-theme-outline-variant));
  border-radius: 0.25rem;
  font-size: 0.75rem;
  padding: 0.0625rem 0.25rem;
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

.lyrics {
  background-color: rgb(var(--v-theme-surface-variant));
  border-radius: 0.5rem;
  padding: 0.75rem;
}

.lyrics-heading {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
  font-weight: 600;
  margin: 0 0 0.375rem;
}

.lyrics-note {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin: 0;
}

/*
  `pre-wrap` so the lyric lines survive. Line structure is the whole shape of a verse, and
  collapsing it would misrepresent what was sung.
*/
.lyrics-text {
  margin: 0;
  white-space: pre-wrap;
}
</style>
