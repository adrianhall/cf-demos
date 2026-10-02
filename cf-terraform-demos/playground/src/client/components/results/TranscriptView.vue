<script setup lang="ts">
/**
 * A transcript with its optional timed breakdown, copy, and download.
 *
 * The full text comes first and the timed spans come second, because the text is the result and the
 * spans are a view of it. That ordering is also what makes the panel usable when a model returns no
 * timing at all: the primary output is in the same place regardless of which model produced it.
 *
 * **The confidence column is the careful part.** Two reviewed models report a quality number and
 * they mean different things: Nova 3 reports a probability in `[0, 1]`, while Whisper reports an
 * average log probability, which is negative and unbounded below. Drawing both as one progress bar
 * would be a fabrication, so a probability gets a bar and a log probability gets its raw value with
 * a plain-language note. The third model reports nothing and the column is absent entirely.
 */
import { computed, ref } from 'vue';
import {
  formatTimestamp,
  type Transcript,
  type VerifiedAudioFacts
} from '../../../shared/transcribe-audio';
import { formatAudioBytes } from '../media/audio-input';

const props = defineProps<{
  /**
   * The normalised transcript to render.
   */
  transcript: Transcript;
  /**
   * What the server verified about the submitted audio.
   */
  audio: VerifiedAudioFacts;
  /**
   * Run identifier, used to build a stable download file name.
   */
  runId: string;
}>();

/**
 * Whether the transcript has just been copied, so the button can confirm it.
 */
const copied = ref(false);

/**
 * Whether any span carries a confidence figure.
 *
 * @returns `true` when the column should be rendered.
 */
const hasConfidence = computed(
  () =>
    props.transcript.confidenceScale !== undefined
    && props.transcript.spans.some((span) => span.confidence !== undefined)
);

/**
 * Whether the confidence numbers are proportions that may be drawn as bars.
 *
 * @returns `true` only for a genuine probability scale.
 */
const confidenceIsProportion = computed(() => props.transcript.confidenceScale === 'probability');

/**
 * A sentence explaining what the confidence numbers actually measure.
 *
 * Stated rather than left to a column heading, because "confidence" is exactly the word a visitor
 * will read as "chance of being right" — and for one of the two scales that is not what it is.
 *
 * @returns The explanation, or an empty string when there are no numbers.
 */
const confidenceNote = computed(() => {
  if (!hasConfidence.value) {
    return '';
  }

  return confidenceIsProportion.value
    ? 'Confidence is the model\u2019s own score between 0 and 1 for each word. It is not a '
        + 'probability that the word is correct.'
    : 'This model reports an average log probability rather than a confidence. It is negative, '
        + 'has no lower bound, and cannot be read as a percentage \u2014 less negative is more '
        + 'certain.';
});

/**
 * The transcript as a downloadable plain-text document.
 *
 * Timestamps are included when the model returned them, because a transcript saved without its
 * timings loses the one thing that makes it useful against the original recording. The text-only
 * form is still first in the file, so the download is readable even when the spans are per-word.
 *
 * @returns The file's contents.
 */
const downloadText = computed(() => {
  const lines = [props.transcript.text, ''];

  if (props.transcript.spans.length > 0) {
    lines.push('--- Timed transcript ---', '');
    for (const span of props.transcript.spans) {
      const speaker = span.speaker === undefined ? '' : ` [Speaker ${span.speaker}]`;
      lines.push(`[${formatTimestamp(span.startSeconds)}]${speaker} ${span.text}`);
    }
  }

  return lines.join('\n');
});

/**
 * A `data:` URI carrying the downloadable transcript.
 *
 * Encoded through `encodeURIComponent` rather than base64 so a non-ASCII transcript survives: a
 * naive `btoa` would throw on any character outside Latin-1, which is most of the languages these
 * models support.
 *
 * @returns The download URI.
 */
const downloadUri = computed(
  () => `data:text/plain;charset=utf-8,${encodeURIComponent(downloadText.value)}`
);

/**
 * File name offered when the transcript is downloaded.
 *
 * Built from the run identifier, never from the transcript: a file name derived from model output
 * is a path-traversal and header-injection surface for no real benefit.
 *
 * @returns The download file name.
 */
const downloadName = computed(() => `transcript-${props.runId}.txt`);

/**
 * Copies the transcript text to the clipboard.
 *
 * Only the text, not the timed breakdown. Copying is almost always a prelude to pasting the words
 * somewhere, and timestamps interleaved into that would have to be deleted by hand; the download is
 * where the full form lives.
 *
 * @returns A promise fulfilled once the copy has been attempted.
 */
async function copyTranscript(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.transcript.text);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2_000);
  } catch {
    // A denied or unavailable clipboard is not worth an error banner: the text is on screen and
    // selectable, so the visitor has already got what they need by another route.
    copied.value = false;
  }
}
</script>

<template>
  <div class="transcript">
    <dl class="facts">
      <div class="fact">
        <dt>Words</dt>
        <dd>{{ props.transcript.wordCount.toLocaleString() }}</dd>
      </div>
      <div class="fact">
        <dt>Audio</dt>
        <dd>{{ props.audio.mediaType }} · {{ formatAudioBytes(props.audio.byteLength) }}</dd>
      </div>
      <div v-if="props.audio.durationSeconds !== undefined" class="fact">
        <dt>Duration</dt>
        <dd>{{ formatTimestamp(props.audio.durationSeconds) }}</dd>
      </div>
      <div v-if="props.transcript.detectedLanguage !== undefined" class="fact">
        <dt>Language</dt>
        <dd>{{ props.transcript.detectedLanguage }}</dd>
      </div>
    </dl>

    <section class="primary" aria-labelledby="transcript-heading">
      <div class="primary-header">
        <h3 id="transcript-heading" class="heading">Transcript</h3>
        <div class="actions">
          <!--
            `aria-live` on the button's own label so the confirmation is announced. A separate
            live region would be announced in addition to the button, which is noisier than the
            single change screen-reader users expect from a copy action.
          -->
          <button type="button" class="action" @click="copyTranscript">
            <span aria-live="polite">{{ copied ? 'Copied' : 'Copy text' }}</span>
          </button>
          <a class="action" :download="downloadName" :href="downloadUri">Download</a>
        </div>
      </div>

      <!--
        `pre-wrap` so a transcript's own paragraph breaks survive. A model asked to punctuate
        returns structure, and collapsing it would discard the thing that was paid for.
      -->
      <p class="text">{{ props.transcript.text }}</p>
    </section>

    <section v-if="props.transcript.spans.length > 0" class="spans" aria-labelledby="spans-heading">
      <h3 id="spans-heading" class="heading">
        Timed breakdown
        <span class="granularity">
          ({{ props.transcript.timestampGranularity === 'word' ? 'per word' : 'per phrase' }})
        </span>
      </h3>

      <p v-if="confidenceNote" class="note">{{ confidenceNote }}</p>

      <!--
        A real table, because this is tabular data: a screen reader announces the column for each
        cell, which a stack of divs cannot do. `scope` on every header is what makes that work.
      -->
      <div class="table-scroll">
        <table class="span-table">
          <caption class="visually-hidden">
            Transcript segments with start times{{
              props.transcript.diarized ? ', speakers' : ''
            }}{{
              hasConfidence ? ', and the model\u2019s own quality score' : ''
            }}
          </caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th v-if="props.transcript.diarized" scope="col">Speaker</th>
              <th scope="col">Text</th>
              <th v-if="hasConfidence" scope="col">
                {{ confidenceIsProportion ? 'Confidence' : 'Avg. log prob.' }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(span, index) in props.transcript.spans"
              :key="`${span.startSeconds}-${index}`"
            >
              <td class="time">{{ formatTimestamp(span.startSeconds) }}</td>
              <td v-if="props.transcript.diarized">
                {{ span.speaker === undefined ? '—' : span.speaker }}
              </td>
              <td>{{ span.text }}</td>
              <td v-if="hasConfidence" class="confidence">
                <template v-if="span.confidence === undefined">—</template>
                <!--
                  A bar only for a genuine probability. A log probability gets its number and
                  nothing else, because there is no honest length to draw for an unbounded scale.
                -->
                <template v-else-if="confidenceIsProportion">
                  <span class="bar" aria-hidden="true">
                    <span class="bar-fill" :style="{ width: `${span.confidence * 100}%` }"></span>
                  </span>
                  <span class="score">{{ span.confidence.toFixed(2) }}</span>
                </template>
                <template v-else>
                  <span class="score">{{ span.confidence.toFixed(2) }}</span>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!--
      Said plainly rather than left as an empty space. A model returning no timings is a contract
      difference worth knowing about, not a loading failure.
    -->
    <p v-else class="note">
      This model returned no timing information, so there is no timed breakdown for this run.
    </p>
  </div>
</template>

<style scoped>
.transcript {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  min-width: 0;
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

.primary,
.spans {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-width: 0;
}

.primary-header {
  align-items: baseline;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  justify-content: space-between;
}

.heading {
  font-size: 1rem;
  margin: 0;
}

.granularity,
.note {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  font-weight: normal;
}

.note {
  margin: 0;
}

.actions {
  display: flex;
  gap: 0.5rem;
}

.action {
  background: transparent;
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.35rem;
  color: inherit;
  cursor: pointer;
  font: inherit;
  min-height: 2.25rem;
  padding: 0.25rem 0.75rem;
  text-decoration: none;
}

.action:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.text {
  background-color: rgb(var(--v-theme-surface-variant));
  border-radius: 0.5rem;
  margin: 0;
  padding: 0.75rem;
  white-space: pre-wrap;
}

/*
  A scroll container rather than a shrinking table: per-word spans produce hundreds of rows, and
  letting them set the panel's height would push everything else off the screen.
*/
.table-scroll {
  max-height: 24rem;
  overflow: auto;
}

.span-table {
  border-collapse: collapse;
  width: 100%;
}

.span-table th,
.span-table td {
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
  padding: 0.3rem 0.5rem;
  text-align: left;
  vertical-align: top;
}

/*
  Sticky so the column meanings stay visible while scrolling a long breakdown — otherwise the
  confidence column becomes an unlabelled set of numbers a few rows down.
*/
.span-table thead th {
  background-color: rgb(var(--v-theme-surface));
  position: sticky;
  top: 0;
}

.time {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.confidence {
  align-items: center;
  display: flex;
  gap: 0.5rem;
  white-space: nowrap;
}

.bar {
  background-color: rgb(var(--v-theme-outline-variant));
  border-radius: 999px;
  display: inline-block;
  height: 0.5rem;
  overflow: hidden;
  width: 3rem;
}

.bar-fill {
  background-color: rgb(var(--v-theme-primary));
  display: block;
  height: 100%;
}

.score {
  font-variant-numeric: tabular-nums;
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
