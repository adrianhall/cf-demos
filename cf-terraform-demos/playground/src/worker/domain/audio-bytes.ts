/**
 * @file Identifies audio bytes by their actual content. The specification requires that a declared
 *   content type is never trusted on its own, and this is where that rule is enforced for speech:
 *   the media type the browser renders is derived from the file signature, not from a provider
 *   header. The reason is the same as for images, and just as concrete. The panel plays the result
 *   from a `data:` URI, and a `data:` URI's media type decides how the browser treats the payload.
 *   A provider that declared `audio/mpeg` and returned an HTML error page — or returned raw PCM
 *   with no container, which Aura's schema genuinely permits — would otherwise reach the page
 *   labelled as playable audio. Sniffing the bytes against a short allowlist means the only thing
 *   that can be played is something that genuinely is one of two container formats a browser
 *   handles. Audio signatures are fuzzier than image ones, and the module is written around that. A
 *   PNG has one eight-byte magic number; an MP3 may begin with an ID3 metadata tag, or directly
 *   with a frame header whose first eleven bits are set and whose following bits must describe a
 *   legal version and bitrate. Matching "any byte pair starting with 0xFF" would accept almost
 *   anything, so the frame header is validated field by field.
 */

import { isPlayableAudioMediaType, type AudioMediaType } from '../../shared/read-text';

/**
 * Reports whether a byte pattern occurs at an offset.
 *
 * @param bytes Buffer to inspect.
 * @param offset Position the pattern should start at.
 * @param pattern Expected bytes.
 * @returns `true` when every byte matches and the buffer is long enough.
 */
function matchesAt(bytes: Uint8Array, offset: number, pattern: readonly number[]): boolean {
  if (bytes.length < offset + pattern.length) {
    return false;
  }

  return pattern.every((expected, index) => bytes[offset + index] === expected);
}

/**
 * Reports whether the bytes begin with an ID3v2 metadata tag.
 *
 * An MP3 produced by most encoders starts with `ID3` rather than with audio, so this is the common
 * case rather than an edge one. The tag is only a marker here: its declared length is not followed,
 * because the goal is to identify the format rather than to locate the first frame.
 *
 * @param bytes Candidate audio data.
 * @returns `true` when an ID3v2 tag header is present.
 */
function hasId3Tag(bytes: Uint8Array): boolean {
  // "ID3" followed by a major version byte. Version 0xFF is reserved and never valid, so requiring
  // anything below it rejects a payload that merely happens to start with those three letters.
  return matchesAt(bytes, 0, [0x49, 0x44, 0x33]) && (bytes[3] ?? 0xff) < 0xff;
}

/**
 * Reports whether a valid MPEG audio frame header sits at an offset.
 *
 * Validated field by field rather than by its sync word alone. The sync word is eleven set bits,
 * which occurs often enough in arbitrary binary data that accepting it on its own would make this
 * function a near-tautology. The version, layer, and bitrate fields each have a reserved encoding
 * that a real encoder never emits, so checking them is what turns a plausible match into a
 * confident one.
 *
 * @param bytes Candidate audio data.
 * @param offset Position the header should start at.
 * @returns `true` when the four bytes at `offset` form a legal frame header.
 */
function hasMpegFrameHeader(bytes: Uint8Array, offset: number): boolean {
  if (bytes.length < offset + 4) {
    return false;
  }

  const first = bytes[offset] ?? 0;
  const second = bytes[offset + 1] ?? 0;
  const third = bytes[offset + 2] ?? 0;

  // Eleven-bit sync word: all of byte one, and the top three bits of byte two.
  if (first !== 0xff || (second & 0xe0) !== 0xe0) {
    return false;
  }

  // Version ID `01` is reserved.
  if ((second & 0x18) === 0x08) {
    return false;
  }

  // Layer `00` is reserved.
  if ((second & 0x06) === 0x00) {
    return false;
  }

  // Bitrate index `1111` is invalid; `0000` means "free format", which no reviewed model emits.
  const bitrateIndex = (third & 0xf0) >> 4;
  if (bitrateIndex === 0x0f || bitrateIndex === 0x00) {
    return false;
  }

  // Sampling-rate index `11` is reserved.
  return (third & 0x0c) !== 0x0c;
}

/**
 * Reports whether the bytes are a RIFF/WAVE file.
 *
 * Both halves of the signature are required. `RIFF` alone is a generic container marker shared with
 * AVI, so matching it by itself would identify a video file as audio.
 *
 * @param bytes Candidate audio data.
 * @returns `true` when the RIFF header declares a WAVE payload.
 */
function isWave(bytes: Uint8Array): boolean {
  return (
    // "RIFF"
    matchesAt(bytes, 0, [0x52, 0x49, 0x46, 0x46])
    // "WAVE", after the four-byte chunk size.
    && matchesAt(bytes, 8, [0x57, 0x41, 0x56, 0x45])
  );
}

/**
 * Identifies audio bytes by signature.
 *
 * An MP3 is accepted either by its ID3 tag or by a frame header at the very start, because both are
 * produced in practice. The frame-header search is deliberately _not_ a scan through the buffer: a
 * sync word found some way into an arbitrary payload says nothing about the payload's format, and
 * scanning would turn this check into a way of finding false positives in a JSON error document.
 *
 * @param bytes Candidate audio data, as returned by a provider.
 * @returns The media type the bytes actually are, or `undefined` when they match no playable format
 *   — which includes an empty buffer, a truncated response, raw headerless PCM, and a JSON or HTML
 *   error document returned under a success status.
 */
export function sniffAudioMediaType(bytes: Uint8Array): AudioMediaType | undefined {
  if (isWave(bytes)) {
    return 'audio/wav';
  }

  if (hasId3Tag(bytes) || hasMpegFrameHeader(bytes, 0)) {
    return 'audio/mpeg';
  }

  return undefined;
}

/**
 * Reports whether a media type is one this module will report.
 *
 * Re-exported from the shared contract so the Worker tier has one import for audio byte handling,
 * matching how `image-bytes.ts` re-exports the image predicate.
 *
 * @param value Candidate media type.
 * @returns `true` when the type is playable.
 */
export function isPlayable(value: string): boolean {
  return isPlayableAudioMediaType(value);
}

/**
 * Builds a download file name for generated speech.
 *
 * The extension comes from the sniffed media type, so a saved file's name always agrees with its
 * actual bytes. The spoken text is deliberately not used: a file name derived from user text is a
 * path-traversal and header-injection surface for no real benefit.
 *
 * @param runId Run the audio belongs to, which makes the name unique per generation.
 * @param extension File extension for the sniffed media type.
 * @returns A safe, stable file name.
 */
export function speechFileName(runId: string, extension: string): string {
  return `playground-${runId}.${extension}`;
}

/**
 * Estimates how long a WAV file plays for, in seconds.
 *
 * Read from the format chunk rather than decoded, so the cost is a few byte reads regardless of
 * file size. Only WAV is attempted: an MP3's duration cannot be read from its first frame without
 * either assuming a constant bitrate — which is wrong for the variable-bitrate output encoders
 * commonly produce — or walking every frame in the file. A wrong duration shown beside a player
 * that disagrees with it is worse than no duration, so MP3 returns `undefined` and the panel reads
 * the real value from the audio element once it has loaded the metadata.
 *
 * @param bytes The full file.
 * @param mediaType The type already determined by {@link sniffAudioMediaType}. Passed in rather
 *   than re-sniffed so the caller cannot accidentally read one format's header as another's.
 * @returns The duration in seconds, or `undefined` when it cannot be determined cheaply and
 *   correctly.
 */
export function readAudioDurationSeconds(
  bytes: Uint8Array,
  mediaType: AudioMediaType
): number | undefined {
  if (mediaType !== 'audio/wav') {
    return undefined;
  }

  // Byte rate sits at offset 28 of a canonical WAV header, as a little-endian 32-bit value. The
  // data chunk's own size is not used: a streamed WAV may declare a placeholder length, whereas the
  // actual remaining bytes are known for certain.
  if (bytes.length < 44) {
    return undefined;
  }

  const byteRate =
    (bytes[28] ?? 0)
    + ((bytes[29] ?? 0) << 8)
    + ((bytes[30] ?? 0) << 16)
    + ((bytes[31] ?? 0) << 24);

  if (byteRate <= 0) {
    return undefined;
  }

  // Everything after the 44-byte canonical header is sample data. A file with extra chunks before
  // the data chunk makes this a slight over-estimate, which is why the panel still prefers the
  // player's own reported duration once it is available.
  return (bytes.length - 44) / byteRate;
}
