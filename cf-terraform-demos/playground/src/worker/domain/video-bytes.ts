/**
 * @file Byte-level identification of generated video, mirroring `image-bytes.ts` for the formats
 *   this panel plays. The reason to sniff rather than trust is the same as for images, but the
 *   consequence is sharper here. The bytes arrive from a third-party host over the public internet
 *   and are then served back from _this demo's own origin_ — where Cloudflare Access has already
 *   authenticated the visitor and the page's own scripts run. A `Content-Type` chosen by the
 *   provider would therefore be a provider choosing how our origin interprets a file. Establishing
 *   the type from the leading bytes, and refusing anything that is not a container this panel
 *   plays, is what keeps that decision ours. Only the first kilobyte is ever examined, so this
 *   works on the head of a stream and the body itself is never buffered whole.
 */

import { isPlayableVideoMediaType, type VideoMediaType } from '../../shared/create-video';

/**
 * Bytes needed to identify a container.
 *
 * An ISO base media file declares `ftyp` at offset 4, and a `ftyp` box is permitted to be fairly
 * large before the brand list ends, so a kilobyte is comfortably enough while staying small enough
 * to read from the head of a stream without materially delaying it.
 */
export const VIDEO_SNIFF_BYTES = 1_024;

/**
 * ISO base media file brands this demo accepts as MP4.
 *
 * An allowlist of brands rather than acceptance of any `ftyp` box. The ISO container family also
 * covers formats a `<video>` element will not play, and quietly serving one as `video/mp4` would
 * produce a player that fails with no explanation. Every brand here is one the reviewed providers
 * actually emit or a baseline brand a browser plays.
 */
const MP4_BRANDS: readonly string[] = [
  'isom',
  'iso2',
  'iso4',
  'iso5',
  'iso6',
  'avc1',
  'mp41',
  'mp42',
  'dash',
  'M4V ',
  'mmp4'
];

/**
 * Reports whether `bytes` matches `pattern` at `offset`.
 *
 * @param bytes Buffer to test.
 * @param offset Byte offset to compare at.
 * @param pattern Expected byte values.
 * @returns `true` when every pattern byte matches.
 */
function matchesAt(bytes: Uint8Array, offset: number, pattern: readonly number[]): boolean {
  if (bytes.length < offset + pattern.length) {
    return false;
  }
  return pattern.every((value, index) => bytes[offset + index] === value);
}

/**
 * Reads a four-character ASCII tag.
 *
 * @param bytes Buffer to read from.
 * @param offset Byte offset of the tag.
 * @returns The tag, or `undefined` when the buffer is too short.
 */
function readTag(bytes: Uint8Array, offset: number): string | undefined {
  if (bytes.length < offset + 4) {
    return undefined;
  }
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

/**
 * Identifies a video container from its leading bytes.
 *
 * Recognises two containers deliberately rather than guessing at more: MP4, which every reviewed
 * provider returns, and WebM, so a provider that switches to it is handled rather than refused.
 * Anything else — including an HTML error page or a JSON fault document served under a success
 * status, which is a real provider behaviour — yields `undefined` and is refused by the caller.
 *
 * @param bytes The first bytes of the response; {@link VIDEO_SNIFF_BYTES} is sufficient.
 * @returns The media type, or `undefined` when the bytes are not a container this panel plays.
 */
export function sniffVideoMediaType(bytes: Uint8Array): VideoMediaType | undefined {
  // EBML magic, shared by WebM and Matroska. The `DocType` that distinguishes them sits further in
  // and is not at a fixed offset; a Matroska file mislabelled `video/webm` is a playback failure
  // rather than a security problem, and WebM is overwhelmingly what a provider would emit.
  if (matchesAt(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
    return 'video/webm';
  }

  // ISO base media: a four-byte big-endian box size, then the literal `ftyp`, then the brand.
  if (matchesAt(bytes, 4, [0x66, 0x74, 0x79, 0x70])) {
    const brand = readTag(bytes, 8);
    if (brand !== undefined && MP4_BRANDS.includes(brand)) {
      return 'video/mp4';
    }
    // A `ftyp` box whose brand is not in the allowlist: deliberately refused rather than assumed to
    // be MP4, so an unplayable container fails with a clear reason instead of in the player.
    return undefined;
  }

  return undefined;
}

/**
 * Reports whether stored bytes are a video this panel is willing to serve.
 *
 * Kept beside the sniffer so a caller cannot check one without the other. It exists because the
 * read path validates independently of the write path: an object already in the bucket is still
 * verified before its first byte reaches a browser, rather than trusted because something stored it
 * earlier.
 *
 * @param bytes The first bytes of the stored object.
 * @returns The media type when the bytes are playable, otherwise `undefined`.
 */
export function playableVideoMediaType(bytes: Uint8Array): VideoMediaType | undefined {
  const sniffed = sniffVideoMediaType(bytes);
  if (sniffed === undefined || !isPlayableVideoMediaType(sniffed)) {
    return undefined;
  }
  return sniffed;
}
