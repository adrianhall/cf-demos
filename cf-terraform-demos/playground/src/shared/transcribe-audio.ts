/**
 * @file The Transcribe Audio panel's wire contract. It sits in `src/shared/` beside the other
 *   panels' contracts because both tiers need it, and like them it carries no model descriptors —
 *   the browser learns which models exist and what each accepts from `/api/catalogue`. This panel
 *   inverts Read Text: there the request was a short passage and the response was audio, here the
 *   request carries the audio and the answer is text. Four things make its contract different from
 *   every panel before it, and all four come from the reviewed model contracts rather than from a
 *   design preference. **The models disagree about how the audio bytes are carried.** Whisper large
 *   v3 turbo accepts a base64 string. Nova 3 requires an `{ body, contentType }` object. The
 *   original Whisper requires an array of integers — one JSON number per byte. Those are three
 *   different encodings of the same bytes, and the third is dramatically more expensive in isolate
 *   memory than the other two, which is why the accepted size limit is declared _per model_ rather
 *   than once for the panel. **The models disagree about the shape of the answer.** One returns `{
 *   text, segments[] }`, one returns `{ text, words[] }`, and one returns `{ results: { channels:
 *   [{ alternatives: [{ transcript, words[] }] }] } }`. The panel presents a single normalised
 *   transcript, so the browser never learns that providers disagree. **The models disagree about
 *   what a confidence number means.** Nova 3 returns a genuine confidence between 0 and 1. Whisper
 *   returns `avg_logprob` — an average log probability, which is negative and unbounded below.
 *   Rendering the second as a percentage bar would be a fabrication, so this contract keeps the two
 *   apart by type and the panel labels them differently. See {@link ConfidenceScale}. **Timestamps
 *   come at different granularities, or not at all.** Turbo returns segment ranges, the other two
 *   return per-word ranges, and a model is free to return neither. The contract therefore treats
 *   timestamps as optional and records which granularity produced them. The submitted audio is
 *   never stored and never returned. The browser already holds the file it chose, so echoing it
 *   back would put a visitor's recording in one more place for no benefit — see
 *   `tests/worker/panel-architecture.test.ts`, which holds that boundary.
 */

import type { RunReceipt } from './runs.ts';

/**
 * Largest audio file the panel accepts, in bytes, for a model whose contract takes the bytes
 * efficiently.
 *
 * This is the decoded size, not the size of the base64 text that carried it. Two of the three
 * reviewed models accept the audio either as a base64 string or as an opaque body object, so the
 * Worker holds roughly one copy of the file and 4 MiB is comfortable inside a 128 MB isolate.
 *
 * It is a _ceiling_ rather than the limit that always applies: a model whose schema demands a JSON
 * array of byte values cannot be given this much, and declares a lower figure of its own. See
 * {@link TranscriptionControlSupport.maxAudioBytes}.
 *
 * 4 MiB is a few minutes of ordinary speech in any compressed format, which is the length this
 * panel is for. It is also a cost bound: every reviewed model bills per audio minute, so capping
 * the file caps the charge a single click can produce.
 */
export const MAX_INPUT_AUDIO_BYTES = 4 * 1_024 * 1_024;

/**
 * Smallest audio file the panel accepts, in bytes.
 *
 * Below this there is no speech to recognise, so the request would spend credit to produce an empty
 * transcript or a hallucinated one. Refusing early is kinder than charging for it. The figure is
 * deliberately tiny — a fraction of a second of compressed audio — because the goal is to catch an
 * empty or truncated file rather than to judge how much someone said.
 */
export const MIN_INPUT_AUDIO_BYTES = 256;

/**
 * Longest audio this panel will transcribe, in seconds, where the duration can be established.
 *
 * Enforced only when the duration is actually knowable from the container, which in practice means
 * WAV. An MP3's duration cannot be read from its header without either assuming a constant bitrate
 * — wrong for the variable-bitrate output most encoders produce — or walking every frame, so for
 * those formats {@link MAX_INPUT_AUDIO_BYTES} is the only bound and the panel says so rather than
 * implying a duration check it does not perform.
 *
 * Ten minutes is far above what 4 MiB of compressed speech can hold, and exists to catch the one
 * case where bytes are a poor proxy: uncompressed WAV is roughly 2.8 MB per minute at 24 kHz mono,
 * so a long low-rate recording could slip under the byte cap while costing ten times more to
 * transcribe than its size suggests.
 */
export const MAX_INPUT_AUDIO_SECONDS = 600;

/**
 * Media types the panel accepts as input.
 *
 * Wider than the two formats Read Text will _play_, and deliberately so — the directions are not
 * symmetric. Read Text chooses what to render in the page, so its allowlist is as narrow as the
 * browser's reliable support. Here the file is forwarded to a provider rather than rendered, and
 * the set has to include what a browser's own recorder produces: Chrome's `MediaRecorder` emits
 * WebM and Safari emits MP4, so excluding either would make the microphone button useless on that
 * browser.
 *
 * It is still an allowlist established by inspecting the leading bytes, never by trusting the
 * `type` a `File` reported. A declared content type is exactly the kind of value an attacker
 * controls.
 */
export const ACCEPTED_AUDIO_MEDIA_TYPES = [
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
  'audio/mp4'
] as const;

/**
 * One media type the panel accepts as input; see {@link ACCEPTED_AUDIO_MEDIA_TYPES}.
 */
export type InputAudioMediaType = (typeof ACCEPTED_AUDIO_MEDIA_TYPES)[number];

/**
 * Reports whether a value is a media type this panel accepts as input.
 *
 * @param value Candidate media type, sniffed from the submitted bytes.
 * @returns `true` when the type is in the input allowlist.
 */
export function isAcceptedAudioMediaType(value: string): value is InputAudioMediaType {
  return (ACCEPTED_AUDIO_MEDIA_TYPES as readonly string[]).includes(value);
}

/**
 * How a model's schema demands the audio bytes be delivered.
 *
 * Declared per model because the three reviewed contracts genuinely differ, and because the choice
 * has a cost that is not obvious. `byte-array` is the same bytes as `base64` expressed as a JSON
 * array of numbers; it inflates the payload enormously and costs far more isolate memory than the
 * bytes behind it, which is why a model demanding it also declares a smaller accepted file size.
 *
 * - `base64` — a base64 string in an `audio` field, as Whisper large v3 turbo accepts.
 * - `body-object` — `{ body, contentType }`, as Nova 3 requires.
 * - `byte-array` — `number[]`, as the original Whisper requires.
 */
export type AudioEncodingStyle = 'base64' | 'body-object' | 'byte-array';

/**
 * What a confidence number from a model actually measures.
 *
 * The distinction this panel exists to be honest about. Nova 3 reports a `confidence` between 0 and
 * 1, which can reasonably be drawn as a proportion. Whisper reports `avg_logprob`: an average log
 * probability, which is negative, unbounded below, and _not_ a proportion of anything. Mapping it
 * onto a percentage bar would invent precision the model never claimed, so the two are kept apart
 * by type and rendered differently.
 *
 * - `probability` — a value in `[0, 1]` the model calls a confidence.
 * - `log-probability` — an average log probability, at most 0 and with no lower bound.
 */
export type ConfidenceScale = 'probability' | 'log-probability';

/**
 * At what granularity a model reports timing information.
 *
 * - `segment` — ranges covering phrases or sentences, as Whisper large v3 turbo returns.
 * - `word` — one range per word, as the original Whisper and Nova 3 return.
 */
export type TimestampGranularity = 'segment' | 'word';

/**
 * A numeric control a transcription model exposes, with the range the server will accept.
 *
 * Structurally similar to the other panels' range types and deliberately separate from them, for
 * the same reason: sharing one type would couple this panel's published contract to another's, so a
 * later change to an image control would silently alter what this panel advertises.
 */
export interface TranscriptionNumericRange {
  /**
   * Lowest accepted value, inclusive.
   */
  min: number;
  /**
   * Highest accepted value, inclusive.
   */
  max: number;
  /**
   * Granularity for the UI control. Does not constrain validation.
   */
  step: number;
  /**
   * Value the model uses when the control is omitted.
   */
  default: number;
}

/**
 * Which controls one transcription model supports, how it carries audio, and what it charges.
 *
 * Every field beyond the encoding and the size ceiling is optional, so a model supports nothing it
 * has not explicitly declared. A control absent here is rejected by validation rather than ignored,
 * which is the same direction every other panel in this demo takes.
 */
export interface TranscriptionControlSupport {
  /**
   * How this model's schema demands the audio bytes; see {@link AudioEncodingStyle}.
   */
  audioEncoding: AudioEncodingStyle;
  /**
   * Largest file this model may be given, in decoded bytes.
   *
   * Declared per model rather than once for the panel, because the encoding the model demands
   * decides what is safe. A model taking a base64 string can have the full
   * {@link MAX_INPUT_AUDIO_BYTES}; one demanding a JSON array of byte values cannot, and its lower
   * figure is a property of its contract rather than an arbitrary restriction. The UI states the
   * limit for the selected model so the difference is visible rather than surprising.
   */
  maxAudioBytes: number;
  /**
   * Language codes this model accepts as a hint, or `undefined` when it exposes no language
   * parameter at all.
   *
   * The reviewed models disagree three ways. Whisper large v3 turbo takes an ISO 639-1 code, Nova 3
   * takes a BCP-47 tag, and the original Whisper takes no language parameter whatsoever — it
   * detects the language and cannot be told. A reviewed restriction rather than a transcribed enum
   * in both cases where it exists, because both schemas type the field as an open string;
   * forwarding an unlisted code would send something unchecked to a provider.
   */
  languages?: readonly string[];
  /**
   * Whether the model can be asked to detect the language rather than be told it.
   *
   * Distinct from simply omitting the hint. Nova 3 has an explicit `detect_language` flag that
   * changes what it returns; Whisper detects by default and has no flag to set.
   */
  supportsLanguageDetection?: boolean;
  /**
   * Whether the model can label which speaker said what.
   *
   * Only Nova 3 declares `diarize`. The panel offers the control for that model alone rather than
   * offering it everywhere and silently dropping it for the others.
   */
  supportsDiarization?: boolean;
  /**
   * Whether the model can be asked to add punctuation and capitalisation.
   *
   * Nova 3 exposes `punctuate` as a flag. The Whisper models punctuate as part of their output and
   * have no control for it, which is a capability difference rather than a missing feature.
   */
  supportsPunctuation?: boolean;
  /**
   * Whether the model accepts a text prompt giving context for the audio.
   *
   * Whisper large v3 turbo declares `initial_prompt`, documented as a way to supply domain
   * vocabulary. It is the one control on this panel that carries visitor-authored text, which is
   * why the request treats it as content rather than as a bounded choice.
   */
  supportsContextPrompt?: boolean;
  /**
   * Timestamp granularity this model returns, or `undefined` when it returns no timing at all.
   */
  timestampGranularity?: TimestampGranularity;
  /**
   * What this model's confidence numbers measure, or `undefined` when it reports none.
   */
  confidenceScale?: ConfidenceScale;
  /**
   * Price in US dollars per minute of submitted audio, or `undefined` when the model publishes no
   * rate at all.
   *
   * Present so the panel can estimate before the request _when the duration is knowable_, which it
   * is only for a container declaring it. The reviewed models differ by a factor of ten here, which
   * is the single most useful thing a visitor can learn from this panel's model selector.
   *
   * **Optional because one reviewed model genuinely has no published price.** Whisper Tiny EN is in
   * the catalogue with no pricing property and no rate on its documentation page. The honest
   * response is to say so, exactly as Read Text already does for a model billed in a unit it cannot
   * estimate — not to invent a plausible figure, and not to print `$0.0000`, which would be a
   * specific and false claim rather than an absence.
   *
   * The figure shown after a run always comes from the AI Gateway log; this is only ever labelled
   * as an estimate.
   */
  pricePerAudioMinuteUsd?: number;
}

/**
 * Every control name a Transcribe Audio request may carry.
 *
 * Used by validation to name the offending control in an error, and by tests to walk the full set
 * rather than a hand-written subset that could fall behind.
 */
export const TRANSCRIPTION_CONTROL_NAMES = [
  'language',
  'detectLanguage',
  'diarize',
  'punctuate',
  'contextPrompt'
] as const;

/**
 * One optional Transcribe Audio control; see {@link TRANSCRIPTION_CONTROL_NAMES}.
 */
export type TranscriptionControlName = (typeof TRANSCRIPTION_CONTROL_NAMES)[number];

/**
 * Longest context prompt the panel accepts, in characters.
 *
 * Short on purpose. `initial_prompt` is documented as a place to put domain vocabulary — names,
 * jargon, spellings — not a place to put instructions, and a long one measurably biases the
 * transcript towards its own wording. Capping it keeps the control useful for what it is for.
 */
export const MAX_CONTEXT_PROMPT_CHARACTERS = 512;

/**
 * What the browser posts to have audio transcribed.
 *
 * As in every other panel there is no identity field and no way to supply one: the actor comes from
 * the verified Access JWT alone, and the domain rejects a body carrying one rather than ignoring
 * it.
 *
 * No media type travels with the audio, and that is deliberate. The server identifies the format
 * from the bytes themselves; a declared type would be a value the browser chose, which is exactly
 * the thing this panel must not rely on.
 */
export interface TranscribeAudioRequest {
  /**
   * The audio, base64-encoded.
   *
   * Carried in the JSON body rather than as `multipart/form-data`, matching the image panels: the
   * request's other fields are JSON already, and one body shape means one validation path and one
   * size limit instead of two. The cost is roughly a third in transfer size, bounded by the
   * selected model's declared ceiling.
   */
  audioBase64: string;
  /**
   * Reviewed model identifier, which must be registered against the `transcribe-audio` panel.
   */
  model: string;
  /**
   * Opaque run identifier generated by the browser, so the UI can correlate its pending state with
   * the receipt.
   */
  runId: string;
  /**
   * Spoken-language hint, which must be one of the model's declared codes.
   */
  language?: string;
  /**
   * Ask the model to detect the language rather than be told it.
   */
  detectLanguage?: boolean;
  /**
   * Ask the model to label which speaker said what.
   */
  diarize?: boolean;
  /**
   * Ask the model to add punctuation and capitalisation.
   */
  punctuate?: boolean;
  /**
   * Domain vocabulary to bias the transcript towards.
   */
  contextPrompt?: string;
}

/**
 * Facts about the submitted audio, as the server verified them.
 *
 * Returned so the panel can state what it actually sent rather than what the browser believed it
 * was sending. When a visitor's file manager says "MP3" and the bytes say WAV, this is where the
 * discrepancy becomes visible instead of silently resolving itself.
 */
export interface VerifiedAudioFacts {
  /**
   * Media type determined by inspecting the bytes, never by trusting a declaration.
   */
  mediaType: InputAudioMediaType;
  /**
   * Decoded size in bytes.
   */
  byteLength: number;
  /**
   * Duration in seconds, when the container declares it.
   *
   * Absent for a compressed format whose duration cannot be read cheaply and correctly. Absence is
   * reported as absence; it is never filled in with an estimate, because a wrong duration beside a
   * cost figure derived from it would be worse than no duration at all.
   */
  durationSeconds?: number;
}

/**
 * One timed span of a transcript.
 *
 * Normalised from whichever shape the model returned, so the panel renders one kind of row
 * regardless of which provider produced it.
 */
export interface TranscriptSpan {
  /**
   * Text of this span.
   */
  text: string;
  /**
   * Where the span starts, in seconds from the beginning of the audio.
   */
  startSeconds: number;
  /**
   * Where the span ends, in seconds from the beginning of the audio.
   */
  endSeconds: number;
  /**
   * The model's own confidence number for this span, when it reported one.
   *
   * Interpret against {@link Transcript.confidenceScale}. The raw figure is carried unchanged rather
   * than rescaled into a common range, because rescaling a log probability into a proportion would
   * invent a meaning the model never gave it.
   */
  confidence?: number;
  /**
   * Zero-based speaker label, when the model was asked to diarize and did.
   */
  speaker?: number;
}

/**
 * A normalised transcript, whichever model produced it.
 */
export interface Transcript {
  /**
   * The full transcript as one block of text.
   *
   * Always present. This is the panel's primary result, and the one thing every reviewed model
   * returns; everything else on this type is something only some models provide.
   */
  text: string;
  /**
   * Timed spans, when the model returned timing information.
   *
   * Empty rather than absent when a model returned none, so the panel can render "no timestamps"
   * without distinguishing an absent field from an empty one.
   */
  spans: readonly TranscriptSpan[];
  /**
   * Granularity of the spans, when there are any; see {@link TimestampGranularity}.
   */
  timestampGranularity?: TimestampGranularity;
  /**
   * What the span confidence numbers measure, when any were returned; see {@link ConfidenceScale}.
   */
  confidenceScale?: ConfidenceScale;
  /**
   * Language the model reported, when it reported one.
   */
  detectedLanguage?: string;
  /**
   * How many words the transcript contains.
   *
   * Counted by this application rather than taken from a provider's own `word_count`, so the figure
   * means the same thing for every model. Two providers counting words differently would otherwise
   * make the number useless for comparison, which is the only reason to show it.
   */
  wordCount: number;
  /**
   * Whether any span carries a speaker label.
   */
  diarized: boolean;
}

/**
 * The settings one run was produced with.
 *
 * Echoed back rather than assumed, so the UI can state what produced a result even after the form
 * has moved on.
 */
export interface AppliedTranscriptionControls {
  /**
   * Model identifier that produced the transcript.
   */
  model: string;
  /**
   * Language hint applied, when the model has that control and one was chosen.
   */
  language?: string;
  /**
   * Whether language detection was requested.
   */
  detectLanguage?: boolean;
  /**
   * Whether speaker labelling was requested.
   */
  diarize?: boolean;
  /**
   * Whether punctuation was requested.
   */
  punctuate?: boolean;
  /**
   * Whether a context prompt was supplied.
   *
   * A boolean rather than the text. The prompt is the visitor's own content and the browser already
   * has it; returning it would put it in one more place for no benefit, while the flag still lets
   * the panel state that one was used.
   */
  contextPromptUsed?: boolean;
  /**
   * Estimated cost in US dollars, from the model's published per-minute price.
   *
   * Absent when the duration could not be established, which is the common case for a compressed
   * file. An absent estimate is reported as absent; it is never filled in with zero, which would
   * read as "free".
   */
  estimatedCostUsd?: number;
}

/**
 * What the Transcribe Audio endpoint returns on success.
 */
export interface TranscribeAudioResponse {
  /**
   * The normalised transcript; see {@link Transcript}.
   */
  transcript: Transcript;
  /**
   * What the server verified about the submitted audio; see {@link VerifiedAudioFacts}.
   */
  audio: VerifiedAudioFacts;
  /**
   * The run receipt, whose `costStatus` is `pending` whenever a gateway log exists to poll for.
   */
  receipt: RunReceipt;
  /**
   * The controls the server actually applied.
   */
  applied: AppliedTranscriptionControls;
}

/**
 * Estimates what a run will cost before it is made.
 *
 * Exported and shared so the browser's pre-request estimate and the server's reported estimate are
 * the same calculation rather than two implementations that can disagree by a rounding rule.
 *
 * @param durationSeconds Audio length in seconds, or `undefined` when the container did not declare
 *   one.
 * @param pricePerAudioMinuteUsd The model's published per-minute rate.
 * @returns The estimate in US dollars, or `undefined` when the duration is unknown and a
 *   pre-request estimate is therefore impossible. Absence is a meaningful answer here and is
 *   rendered as such.
 */
export function estimateTranscriptionCostUsd(
  durationSeconds: number | undefined,
  pricePerAudioMinuteUsd: number | undefined
): number | undefined {
  if (durationSeconds === undefined || pricePerAudioMinuteUsd === undefined) {
    return undefined;
  }

  return (durationSeconds / 60) * pricePerAudioMinuteUsd;
}

/**
 * Counts the words in a transcript.
 *
 * Shared between the tiers so the browser and the server agree, and defined here rather than taken
 * from a provider's own `word_count` so the figure means the same thing for every model.
 *
 * @param text Transcript text.
 * @returns The number of whitespace-separated words, and zero for text that is empty or only
 *   whitespace.
 */
export function countTranscriptWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/u).length;
}

/**
 * Formats a second offset as a short timestamp.
 *
 * Shared so a timestamp rendered beside a span and one written into a downloaded transcript cannot
 * disagree.
 *
 * @param seconds Offset from the start of the audio.
 * @returns A string such as `"0:07"`, or `"1:02:03"` for audio past an hour.
 */
export function formatTimestamp(seconds: number): string {
  // Guards against a provider returning a negative or non-finite offset, which would otherwise
  // render as `NaN:NaN` rather than as something harmless.
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}
