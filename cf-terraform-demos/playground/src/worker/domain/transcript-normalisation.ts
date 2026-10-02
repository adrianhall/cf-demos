/**
 * @file Turns whichever shape a transcription model returned into one {@link Transcript}. This is
 *   the substance of the panel, and the reviewed contracts make it necessary rather than defensive
 *   — the three models return the same information in three genuinely unrelated envelopes:
 *
 *   - Whisper large v3 turbo: `{ text, segments: [{ start, end, text, avg_logprob }] }`
 *   - Whisper (original): `{ text, words: [{ word, start, end }] }`
 *   - Nova 3: `{ results: { channels: [{ alternatives: [{ transcript, confidence, words }] }] } }`
 *     The envelope is chosen from the reviewed descriptor rather than guessed by trying keys in
 *     turn. Guessing would be more forgiving and considerably worse: if a model's contract changed,
 *     a fallback would find some other string field and present it as a transcript, turning a
 *     contract break into a subtly wrong result that nobody notices. Reading the declared shape
 *     makes that same break a logged refusal. **A confidence number is carried unchanged, never
 *     rescaled.** Nova 3 reports a probability in `[0, 1]`; Whisper reports `avg_logprob`, which is
 *     negative and unbounded below. Normalising the second into the first's range — the obvious way
 *     to make one progress bar work for both — would fabricate a meaning the model never gave it.
 *     The scale travels with the numbers instead, and the panel renders them differently.
 */

import {
  countTranscriptWords,
  type ConfidenceScale,
  type TimestampGranularity,
  type Transcript,
  type TranscriptSpan
} from '../../shared/transcribe-audio';
import type { ModelDescriptor } from './models';

/**
 * Largest number of spans carried back to the browser.
 *
 * A bound rather than a preference. An hour of per-word timings from Nova 3 is tens of thousands of
 * objects, and serialising all of them would produce a response far larger than the transcript it
 * describes while rendering a table no visitor can read. The transcript text itself is never
 * truncated — only the timed breakdown is — and {@link Transcript} records nothing misleading when
 * the cap applies, because the spans are already a secondary view of text that is returned in
 * full.
 */
export const MAX_TRANSCRIPT_SPANS = 2_000;

/**
 * Reads a finite number from an untrusted field.
 *
 * @param value Candidate value from a provider response.
 * @returns The number, or `undefined` when it is absent or not finite. `NaN` and `Infinity` are
 *   rejected because both serialise to `null` and would reach the page as a missing timestamp
 *   rather than as the broken value they are.
 */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Reads a non-empty string from an untrusted field.
 *
 * @param value Candidate value from a provider response.
 * @returns The trimmed string, or `undefined` when it is absent, not a string, or blank.
 */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Reads a plain object from an untrusted field.
 *
 * @param value Candidate value from a provider response.
 * @returns The object, or `undefined` when it is absent, null, or an array.
 */
function plainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Builds one span from a provider's timed entry.
 *
 * Shared by all three envelopes, because the field _names_ differ while the shape does not: each
 * carries some text, a start, and an end. A span is produced only when all three are usable — a
 * partial entry is dropped rather than rendered with a zero timestamp, since a wrong timestamp
 * beside a correct one is worse than a shorter list.
 *
 * @param text The entry's text, under whichever key the model uses.
 * @param start The entry's start offset in seconds.
 * @param end The entry's end offset in seconds.
 * @param confidence The entry's quality figure, when the model reported one.
 * @param speaker The entry's speaker label, when diarization was applied.
 * @returns The span, or `undefined` when the entry was unusable.
 */
function toSpan(
  text: unknown,
  start: unknown,
  end: unknown,
  confidence?: unknown,
  speaker?: unknown
): TranscriptSpan | undefined {
  const spanText = nonEmptyString(text);
  const startSeconds = finiteNumber(start);
  const endSeconds = finiteNumber(end);

  if (spanText === undefined || startSeconds === undefined || endSeconds === undefined) {
    return undefined;
  }

  // A negative offset is not a timestamp. Clamping rather than dropping, because the text is still
  // good and the offset is only used for display ordering.
  const safeStart = Math.max(0, startSeconds);

  const confidenceValue = finiteNumber(confidence);
  const speakerValue = finiteNumber(speaker);

  return {
    text: spanText,
    startSeconds: safeStart,
    // An end before its start would render as a negative duration. Taking the later of the two
    // keeps the span coherent without inventing a length for it.
    endSeconds: Math.max(safeStart, endSeconds),
    ...(confidenceValue === undefined ? {} : { confidence: confidenceValue }),
    // Speaker labels are zero-based and integral in Nova 3's contract. A fractional or negative
    // value is not a speaker, so it is dropped rather than shown as one.
    ...(speakerValue === undefined || speakerValue < 0 || !Number.isInteger(speakerValue)
      ? {}
      : { speaker: speakerValue })
  };
}

/**
 * Sorts spans by start time and applies the span cap.
 *
 * Providers return spans in order in practice, and sorting anyway costs almost nothing and removes
 * a class of display bug: a single out-of-order entry would otherwise make a transcript appear to
 * jump backwards, which reads as corruption rather than as a provider quirk.
 *
 * @param spans Spans collected from a provider response.
 * @returns The spans in time order, truncated to {@link MAX_TRANSCRIPT_SPANS}.
 */
function orderSpans(spans: TranscriptSpan[]): TranscriptSpan[] {
  spans.sort((left, right) => left.startSeconds - right.startSeconds);
  return spans.length > MAX_TRANSCRIPT_SPANS ? spans.slice(0, MAX_TRANSCRIPT_SPANS) : spans;
}

/**
 * Normalises the Whisper family's flat envelope.
 *
 * Both Whisper models return `{ text }` at the top level and differ only in whether the timed
 * breakdown is `segments[]` or `words[]`, so one reader handles both and takes the key from the
 * declared granularity.
 *
 * @param record The provider's output object.
 * @param granularity Which key to read, from the reviewed descriptor.
 * @returns The transcript text and its spans, or `undefined` when there was no usable text.
 */
function readWhisperEnvelope(
  record: Record<string, unknown>,
  granularity: TimestampGranularity | undefined
): ReadEnvelope | undefined {
  const text = nonEmptyString(record['text']);
  if (text === undefined) {
    return undefined;
  }

  const spans: TranscriptSpan[] = [];
  const entries = granularity === 'word' ? record['words'] : record['segments'];

  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const item = plainObject(entry);
      if (item === undefined) {
        continue;
      }

      // `word` for the per-word shape, `text` for the per-segment one. `avg_logprob` exists only on
      // segments, and is a log probability rather than a confidence — the descriptor's declared
      // scale is what tells the panel how to present it.
      const span = toSpan(
        granularity === 'word' ? item['word'] : item['text'],
        item['start'],
        item['end'],
        item['avg_logprob']
      );

      if (span !== undefined) {
        spans.push(span);
      }
    }
  }

  // Only `whisper-large-v3-turbo` carries this, nested in `transcription_info`. Read optionally so
  // the same function serves the original Whisper, whose output has no such object.
  const info = plainObject(record['transcription_info']);
  const detectedLanguage = info === undefined ? undefined : nonEmptyString(info['language']);

  return {
    text,
    spans,
    ...(detectedLanguage === undefined ? {} : { detectedLanguage })
  };
}

/**
 * Normalises Nova 3's nested envelope.
 *
 * The transcript sits at `results.channels[0].alternatives[0].transcript` — four levels of nesting,
 * each of which can legitimately be absent. The first channel and first alternative are taken
 * deliberately: this panel never asks for `multichannel`, and an alternative list is ranked, so
 * anything past the first is a lower-confidence reading that would be wrong to concatenate.
 *
 * @param record The provider's output object.
 * @returns The transcript text and its spans, or `undefined` when there was no usable text.
 */
function readNovaEnvelope(record: Record<string, unknown>): ReadEnvelope | undefined {
  const results = plainObject(record['results']);
  const channels = results === undefined ? undefined : results['channels'];
  if (!Array.isArray(channels)) {
    return undefined;
  }

  const channel = plainObject(channels[0]);
  const alternatives = channel === undefined ? undefined : channel['alternatives'];
  if (!Array.isArray(alternatives)) {
    return undefined;
  }

  const best = plainObject(alternatives[0]);
  if (best === undefined) {
    return undefined;
  }

  // `transcript`, not `text`. Reading the wrong key here would produce an empty result against a
  // response that was perfectly valid, which is exactly the failure a reviewed envelope prevents.
  const text = nonEmptyString(best['transcript']);
  if (text === undefined) {
    return undefined;
  }

  const spans: TranscriptSpan[] = [];
  const words = best['words'];

  if (Array.isArray(words)) {
    for (const entry of words) {
      const item = plainObject(entry);
      if (item === undefined) {
        continue;
      }

      // `confidence` here is a genuine probability in [0, 1], unlike Whisper's `avg_logprob`.
      // `speaker` is present only when diarization was requested.
      const span = toSpan(
        item['word'],
        item['start'],
        item['end'],
        item['confidence'],
        item['speaker']
      );

      if (span !== undefined) {
        spans.push(span);
      }
    }
  }

  return { text, spans };
}

/**
 * Why a provider's output could not be turned into a transcript.
 *
 * Returned rather than thrown so the caller decides the HTTP shape, and so the reason can be logged
 * alongside the model identifier — a refusal here and a provider error both surface as a `502`, and
 * they have entirely different causes.
 */
export type TranscriptRejection = 'unrecognised_shape' | 'missing_transcript' | 'empty_transcript';

/**
 * The outcome of normalising a provider's output.
 */
export type NormaliseTranscriptOutcome =
  | { ok: true; transcript: Transcript }
  | { ok: false; reason: TranscriptRejection };

/**
 * What one envelope reader extracted before the common fields are derived.
 *
 * Shared by both readers so the caller handles one shape rather than narrowing a union. Only
 * `whisper-large-v3-turbo` ever populates `detectedLanguage`; the other two readers leave it
 * absent, which is the honest representation of a model that reports no language.
 */
interface ReadEnvelope {
  /**
   * The transcript text, already trimmed and confirmed non-empty.
   */
  text: string;
  /**
   * Timed spans, in whatever order the provider gave them.
   */
  spans: TranscriptSpan[];
  /**
   * Language the model reported, when its envelope carries one.
   */
  detectedLanguage?: string;
}

/**
 * Turns a transcription model's raw output into one normalised transcript.
 *
 * The envelope is selected from the reviewed descriptor — `body-object` encoding identifies the
 * Deepgram contract, and the Whisper family is read flat — rather than by probing for keys. The
 * declared timestamp granularity decides which timed array is read, and the declared confidence
 * scale travels back with the spans so the panel can label the numbers truthfully instead of
 * drawing two incomparable quantities as one bar.
 *
 * @param output The provider's raw output.
 * @param model The reviewed descriptor, which names the envelope, the granularity, and the scale.
 * @returns The normalised transcript, or a refusal carrying the reason; see
 *   {@link NormaliseTranscriptOutcome}.
 */
export function normaliseTranscript(
  output: unknown,
  model: ModelDescriptor
): NormaliseTranscriptOutcome {
  const record = plainObject(output);
  if (record === undefined) {
    return { ok: false, reason: 'unrecognised_shape' };
  }

  const controls = model.transcriptionControls;
  const granularity = controls?.timestampGranularity;

  const read =
    controls?.audioEncoding === 'body-object'
      ? readNovaEnvelope(record)
      : readWhisperEnvelope(record, granularity);

  if (read === undefined) {
    // Distinguished from `unrecognised_shape` so a log says whether the envelope was wrong or
    // merely empty — a model returning `{ text: "" }` for silent audio is a different event from
    // one that changed its response format.
    const hasEnvelope = Object.hasOwn(record, 'text') || Object.hasOwn(record, 'results');
    return { ok: false, reason: hasEnvelope ? 'empty_transcript' : 'missing_transcript' };
  }

  const spans = orderSpans(read.spans);

  return {
    ok: true,
    transcript: {
      text: read.text,
      spans,
      // Reported only when spans actually exist. Declaring a granularity beside an empty list
      // would describe a breakdown the visitor cannot see.
      ...(spans.length > 0 && granularity !== undefined
        ? { timestampGranularity: granularity }
        : {}),
      // Reported only when a span genuinely carries a number. A model that declares a scale but
      // returned no figures this time would otherwise have the panel label a column that is empty.
      ...(spans.some((span) => span.confidence !== undefined)
      && controls?.confidenceScale !== undefined
        ? { confidenceScale: controls.confidenceScale satisfies ConfidenceScale }
        : {}),
      ...(read.detectedLanguage === undefined ? {} : { detectedLanguage: read.detectedLanguage }),
      // Counted here rather than taken from a provider's own `word_count`, so the figure means the
      // same thing for every model. Two providers counting differently would make the number
      // useless for the comparison it exists to support.
      wordCount: countTranscriptWords(read.text),
      diarized: spans.some((span) => span.speaker !== undefined)
    }
  };
}
