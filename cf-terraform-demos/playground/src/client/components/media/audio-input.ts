/**
 * @file Pure helpers for turning a chosen or recorded audio file into something the panel can send
 *   and play. Plain functions over plain data: no Vue, no fetch, no component state. Every check
 *   here is a courtesy, not a control — the server re-derives the format from the bytes and
 *   re-measures the file, because a browser-side check protects nobody. It only spares a visitor a
 *   round trip and a confusing error. Saying so plainly matters, because client-side validation
 *   that _looks_ authoritative is how people end up trusting it. One check here is genuinely
 *   different from the image panels' equivalents, though. The size limit is **per model**, not per
 *   panel, because the three reviewed models demand the audio in three different encodings and one
 *   of those is far more expensive to handle. So `prepareAudio` takes the limit as an argument
 *   rather than reading a constant, and the panel passes whatever the selected model published. A
 *   file that is fine for one model and refused for another is correct behaviour rather than a
 *   bug.
 */

/**
 * Media types the file picker will offer.
 *
 * Matches the server's input allowlist. Wider than the two formats Read Text will play, because
 * this file is forwarded to a provider rather than rendered in the page — and because it must
 * include what a browser's own recorder produces.
 */
export const ACCEPTED_AUDIO_UPLOAD_TYPES = [
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
  'audio/mp4'
] as const;

/**
 * The `accept` attribute for the audio file input.
 *
 * Includes `audio/*` alongside the explicit list because a file's reported type varies by platform
 * for the same format — `audio/x-wav`, `audio/vnd.wave`, and `audio/wave` are all seen for WAV —
 * and a strict list would hide real files from the picker. The server decides what is actually
 * acceptable by reading the bytes, so a permissive filter costs nothing.
 */
export const AUDIO_UPLOAD_ACCEPT_ATTRIBUTE = [...ACCEPTED_AUDIO_UPLOAD_TYPES, 'audio/*'].join(',');

/**
 * Audio the panel is ready to send.
 */
export interface PreparedAudio {
  /**
   * The bytes, base64-encoded, as the request carries them.
   */
  base64: string;
  /**
   * A `data:` URI so the visitor can play back what they are about to submit.
   *
   * Built from the type the _browser_ reported. The server independently sniffs the bytes and may
   * disagree; when it does, its answer is the one the panel reports afterwards.
   */
  previewUri: string;
  /**
   * Size of the decoded audio in bytes.
   */
  byteLength: number;
  /**
   * The file's own name, shown so a visitor can tell two uploads apart.
   *
   * Displayed only. It is never sent to the server and never used to decide anything: a file name
   * is attacker-controlled text.
   */
  fileName: string;
  /**
   * Whether this audio came from the microphone rather than from a file.
   *
   * Surfaced so the panel can label a recording as such — a visitor who has made three recordings
   * and chosen two files needs to know which is loaded, and a generated file name alone does not
   * tell them.
   */
  recorded: boolean;
}

/**
 * Why a chosen file was refused before it was ever sent.
 */
export type AudioRejectionReason = 'unsupported-type' | 'too-large' | 'too-small' | 'unreadable';

/**
 * The outcome of preparing chosen or recorded audio.
 */
export type PrepareAudioOutcome =
  | { ok: true; audio: PreparedAudio }
  | { ok: false; reason: AudioRejectionReason; message: string };

/**
 * Smallest file the panel will send, in bytes.
 *
 * Matches the server's own floor. Catches an empty or truncated file rather than judging how much
 * someone said.
 */
export const MIN_AUDIO_UPLOAD_BYTES = 256;

/**
 * Encodes bytes as base64.
 *
 * Built in 8 KiB chunks rather than one spread call: `String.fromCharCode(...bytes)` on a
 * multi-megabyte file exceeds the argument limit and throws a `RangeError`, turning a large but
 * valid recording into an unexplained failure. Audio files are routinely large enough for this to
 * matter, so it is the common path rather than an edge case.
 *
 * @param bytes Data to encode.
 * @returns The base64 representation.
 */
export function encodeAudioBase64(bytes: Uint8Array): string {
  const CHUNK = 8_192;
  let binary = '';

  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }

  return btoa(binary);
}

/**
 * Formats a byte count for display.
 *
 * @param bytes Size to describe.
 * @returns A short string such as `"1.4 MB"` or `"860 KB"`.
 */
export function formatAudioBytes(bytes: number): string {
  if (bytes >= 1_024 * 1_024) {
    return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1_024))} KB`;
}

/**
 * Prepares a chosen or recorded file for sending and playback.
 *
 * @param file The file a visitor picked, dropped, or recorded.
 * @param maxBytes Largest size to accept, taken from the selected model's published ceiling. Passed
 *   in rather than read from a constant because this limit is a property of the model's contract:
 *   one reviewed model accepts a quarter of what the others do, because its schema demands the
 *   audio as a JSON array of byte values.
 * @param recorded Whether the audio came from the microphone.
 * @returns The prepared audio, or a refusal carrying a reason and a message to show; see
 *   {@link PrepareAudioOutcome}. Refusals are returned rather than thrown because every one of them
 *   is an ordinary thing a visitor can do, not an exceptional condition.
 */
export async function prepareAudio(
  file: File,
  maxBytes: number,
  recorded = false
): Promise<PrepareAudioOutcome> {
  // The declared type is checked only loosely, and only to catch an obvious mistake like a chosen
  // PDF. The server identifies the format from the bytes, so a strict check here would reject real
  // audio whose platform-specific type string is not in any list.
  if (file.type !== '' && !file.type.startsWith('audio/') && !file.type.startsWith('video/')) {
    return reject('unsupported-type', maxBytes);
  }

  // Checked before reading, so an oversized file is refused without pulling it into memory first.
  // This matters more here than for images: the files are several times larger.
  if (file.size > maxBytes) {
    return reject('too-large', maxBytes);
  }

  if (file.size < MIN_AUDIO_UPLOAD_BYTES) {
    return reject('too-small', maxBytes);
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    // A file that vanished or became unreadable between selection and reading — removable media, or
    // a file replaced underneath the picker.
    return reject('unreadable', maxBytes);
  }

  if (bytes.length < MIN_AUDIO_UPLOAD_BYTES) {
    return reject('too-small', maxBytes);
  }

  const base64 = encodeAudioBase64(bytes);
  // Falls back to a playable type when the browser reported none, which happens for a `File`
  // constructed from recorder output on some platforms. The preview is the only consumer, and an
  // empty media type in a `data:` URI makes it unplayable.
  const previewType = file.type === '' ? 'audio/webm' : file.type;

  return {
    ok: true,
    audio: {
      base64,
      previewUri: `data:${previewType};base64,${base64}`,
      byteLength: bytes.length,
      fileName: file.name,
      recorded
    }
  };
}

/**
 * Builds a refusal outcome.
 *
 * The messages say what to do next rather than only what went wrong, and the size message quotes
 * the _selected model's_ limit — because a visitor who just succeeded with the same file on another
 * model would otherwise reasonably conclude the panel was broken.
 *
 * @param reason Why the file was refused.
 * @param maxBytes The limit in force, so the message can name it.
 * @returns The refusal, with its matching message.
 */
function reject(reason: AudioRejectionReason, maxBytes: number): PrepareAudioOutcome {
  const messages: Readonly<Record<AudioRejectionReason, string>> = {
    'unsupported-type': 'That file is not audio. Choose an MP3, WAV, Ogg, WebM, or MP4 recording.',
    'too-large':
      `That recording is larger than the ${formatAudioBytes(maxBytes)} limit for the selected `
      + 'model. Choose a shorter recording, or a model that accepts larger files.',
    'too-small': 'That file is too short to contain any speech.',
    'unreadable': 'That file could not be read. Try choosing it again.'
  };

  return { ok: false, reason, message: messages[reason] };
}

/**
 * Where the microphone flow currently stands.
 *
 * Modelled as explicit states rather than a pair of booleans because the specification requires
 * recording, processing, and failure to be _distinct_, and because two of these states are things a
 * visitor must be able to act on. `denied` is permanent until they change a browser setting, which
 * is advice the panel can give; `unsupported` is not their fault at all and the panel should stop
 * offering the feature rather than letting them click a button that cannot work.
 *
 * - `unsupported` — the browser has no `MediaRecorder` or no secure context for `getUserMedia`.
 * - `idle` — available and not recording.
 * - `requesting` — the permission prompt is open.
 * - `recording` — capturing.
 * - `denied` — permission was refused.
 * - `failed` — the device or recorder failed after permission was granted.
 */
export type RecordingState =
  | 'unsupported'
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'denied'
  | 'failed';

/**
 * Reports whether this browser can record from the microphone at all.
 *
 * Checked rather than assumed, and checked for both halves: `getUserMedia` is absent outside a
 * secure context, and `MediaRecorder` is absent on some older browsers that nonetheless have
 * `getUserMedia`. Offering a button that throws on click is worse than not offering it — which is
 * why the panel's upload path never depends on this returning `true`.
 *
 * @returns `true` when both APIs are present.
 */
export function canRecordAudio(): boolean {
  return (
    typeof MediaRecorder !== 'undefined'
    && typeof navigator !== 'undefined'
    && navigator.mediaDevices?.getUserMedia !== undefined
  );
}

/**
 * Chooses a recording container this browser actually supports.
 *
 * Browsers disagree and do not overlap: Chrome and Firefox produce WebM, Safari produces MP4.
 * Asking for an unsupported type makes `MediaRecorder` throw, so the type is negotiated rather than
 * assumed. Returning `undefined` lets the recorder pick its own default, which is the right
 * fallback for a browser whose support this list does not predict.
 *
 * @returns A supported MIME type, or `undefined` to accept the browser's default.
 */
export function preferredRecordingMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || MediaRecorder.isTypeSupported === undefined) {
    return undefined;
  }

  // Opus-in-WebM first because it is the most compact of the three at speech bitrates, which
  // matters when the result travels base64-encoded inside a JSON body.
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

/**
 * Classifies a `getUserMedia` failure into a state the panel can explain.
 *
 * The distinction is worth making because the two outcomes need opposite advice. A denial is a
 * decision the visitor can revisit in their browser's site settings; anything else is a device or
 * driver problem that retrying might genuinely fix.
 *
 * @param cause Whatever `getUserMedia` rejected with.
 * @returns `denied` for a permission refusal, `failed` for any other cause.
 */
export function classifyRecordingFailure(cause: unknown): 'denied' | 'failed' {
  if (cause instanceof DOMException) {
    // `NotAllowedError` is the standard denial. `SecurityError` is what older WebKit raised for the
    // same situation, and treating it as a device fault would send the visitor to debug hardware
    // that is working.
    if (cause.name === 'NotAllowedError' || cause.name === 'SecurityError') {
      return 'denied';
    }
  }

  return 'failed';
}

/**
 * Builds a file name for a recording.
 *
 * Derived from the run-independent timestamp rather than from anything a visitor typed, so the name
 * is always safe, and given a real extension so a downloaded copy opens in an audio player.
 *
 * @param mimeType The recorder's own output type.
 * @param now Epoch milliseconds, injected so a test can assert on the name.
 * @returns A safe, human-readable file name.
 */
export function recordingFileName(mimeType: string | undefined, now: number): string {
  const extension = mimeType?.includes('mp4') === true ? 'mp4' : 'webm';
  // Colons are not safe in a file name on every platform, so the ISO timestamp is reduced to
  // digits rather than used as-is.
  const stamp = new Date(now)
    .toISOString()
    .replaceAll(/[^0-9]/gu, '')
    .slice(0, 14);
  return `recording-${stamp}.${extension}`;
}
