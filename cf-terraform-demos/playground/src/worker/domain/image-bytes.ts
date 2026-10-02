/**
 * @file Identifies image bytes by their actual content. The specification requires that a declared
 *   browser content type is never trusted on its own, and this is where that rule is enforced: the
 *   media type the browser renders is derived from the file signature, not from a provider header
 *   and not from a field in a JSON response. The reason is concrete. The panel renders the result
 *   in a `data:` URI, and a `data:` URI's media type decides how the browser treats the payload. A
 *   provider that declared `image/svg+xml` — or a response that was not an image at all — would
 *   otherwise reach the page as a scripting context wearing a picture's label. Sniffing the bytes
 *   and matching them against a short allowlist means the only thing that can be rendered is
 *   something that genuinely is one of three raster formats.
 */

import { isRenderableImageMediaType, type ImageMediaType } from '../../shared/images';

/**
 * One format's magic-number signature.
 */
interface ImageSignature {
  /**
   * Media type to report when the signature matches.
   */
  mediaType: ImageMediaType;
  /**
   * Byte offset the pattern starts at. WebP's identifying bytes sit after a four-byte length field,
   * so the offset is part of the signature rather than always zero.
   */
  offset: number;
  /**
   * Bytes that must match exactly.
   */
  pattern: readonly number[];
  /**
   * Additional bytes that must also match, at their own offset. Only WebP needs this: its first
   * four bytes are the generic RIFF container marker, which by itself does not mean the payload is
   * an image.
   */
  also?: { offset: number; pattern: readonly number[] };
}

/**
 * Signatures for the formats this panel renders, in match order.
 *
 * Deliberately short. Every entry here is a format whose bytes a browser will treat as a raster
 * image and nothing else; adding a format means accepting responsibility for how a browser handles
 * it. SVG is absent on purpose, and so is anything that could be interpreted as markup.
 */
const SIGNATURES: readonly ImageSignature[] = [
  {
    // PNG: \x89 P N G \r \n \x1a \n
    mediaType: 'image/png',
    offset: 0,
    pattern: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  },
  {
    // JPEG: start-of-image marker, then any APPn/other marker.
    mediaType: 'image/jpeg',
    offset: 0,
    pattern: [0xff, 0xd8, 0xff]
  },
  {
    // WebP: "RIFF" ... "WEBP". Both parts are required; "RIFF" alone is also WAV and AVI.
    mediaType: 'image/webp',
    offset: 0,
    pattern: [0x52, 0x49, 0x46, 0x46],
    also: { offset: 8, pattern: [0x57, 0x45, 0x42, 0x50] }
  }
];

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
 * Identifies image bytes by signature.
 *
 * @param bytes Candidate image data, as returned by a provider.
 * @returns The media type the bytes actually are, or `undefined` when they match no renderable
 *   format — which includes an empty buffer, a truncated response, and a JSON error document the
 *   provider returned with a success status.
 */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  for (const signature of SIGNATURES) {
    if (!matchesAt(bytes, signature.offset, signature.pattern)) {
      continue;
    }

    if (
      signature.also !== undefined
      && !matchesAt(bytes, signature.also.offset, signature.also.pattern)
    ) {
      continue;
    }

    return signature.mediaType;
  }

  return undefined;
}

/**
 * Encodes bytes as base64 for transport in a JSON body.
 *
 * Built in 8 KiB chunks rather than one spread call. `String.fromCharCode(...bytes)` on a
 * multi-megabyte image exceeds the argument limit and throws a `RangeError`, which would turn a
 * large but perfectly valid image into an unexplained failure.
 *
 * @param bytes Data to encode.
 * @returns The base64 representation.
 */
export function encodeBase64(bytes: Uint8Array): string {
  const CHUNK = 8_192;
  let binary = '';

  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }

  return btoa(binary);
}

/**
 * Decodes base64 into bytes.
 *
 * Used when a model returns its image already base64-encoded in a JSON field: the bytes have to be
 * decoded in order to be sniffed, because the point of sniffing is to inspect content rather than
 * believe a declaration.
 *
 * @param value Base64 text from a provider response.
 * @returns The decoded bytes, or `undefined` when the value is not valid base64.
 */
export function decodeBase64(value: string): Uint8Array | undefined {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * Builds a download file name for a generated image.
 *
 * The extension comes from the sniffed media type, so a saved file's name always agrees with its
 * actual bytes. The prompt is deliberately not used: a file name derived from user text is a path
 * -traversal and header-injection surface for no real benefit.
 *
 * @param runId Run the image belongs to, which makes the name unique per generation.
 * @param extension File extension for the sniffed media type.
 * @returns A safe, stable file name.
 */
export function imageFileName(runId: string, extension: string): string {
  return `playground-${runId}.${extension}`;
}

/**
 * Reports whether a media type is one this module will report.
 *
 * Re-exported from the shared contract so the Worker tier has one import for byte handling.
 *
 * @param value Candidate media type.
 * @returns `true` when the type is renderable.
 */
export function isRenderable(value: string): boolean {
  return isRenderableImageMediaType(value);
}

/**
 * A picture's pixel dimensions, as declared by its own header.
 */
export interface ImageDimensions {
  /**
   * Width in pixels.
   */
  width: number;
  /**
   * Height in pixels.
   */
  height: number;
}

/**
 * Reads a big-endian unsigned integer.
 *
 * @param bytes Buffer to read from.
 * @param offset Position of the first byte.
 * @param length Number of bytes to combine.
 * @returns The value, or `undefined` when the buffer is too short.
 */
function readBigEndian(bytes: Uint8Array, offset: number, length: number): number | undefined {
  if (bytes.length < offset + length) {
    return undefined;
  }

  let value = 0;
  for (let index = 0; index < length; index += 1) {
    value = value * 256 + (bytes[offset + index] ?? 0);
  }
  return value;
}

/**
 * Reads a little-endian unsigned integer.
 *
 * @param bytes Buffer to read from.
 * @param offset Position of the first byte.
 * @param length Number of bytes to combine.
 * @returns The value, or `undefined` when the buffer is too short.
 */
function readLittleEndian(bytes: Uint8Array, offset: number, length: number): number | undefined {
  if (bytes.length < offset + length) {
    return undefined;
  }

  let value = 0;
  for (let index = length - 1; index >= 0; index -= 1) {
    value = value * 256 + (bytes[offset + index] ?? 0);
  }
  return value;
}

/**
 * Reads a PNG's dimensions from its IHDR chunk.
 *
 * IHDR is required by the specification to be the first chunk, so the offsets are fixed: the
 * signature occupies eight bytes, the chunk length and type eight more, and the two dimensions
 * follow as big-endian 32-bit integers.
 *
 * @param bytes The full file.
 * @returns The dimensions, or `undefined` when the header is truncated.
 */
function pngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const width = readBigEndian(bytes, 16, 4);
  const height = readBigEndian(bytes, 20, 4);
  return width === undefined || height === undefined ? undefined : { width, height };
}

/**
 * Reads a JPEG's dimensions by walking its segment markers.
 *
 * Unlike PNG there is no fixed offset: a JPEG is a chain of variable-length segments, and the size
 * lives in whichever start-of-frame segment the encoder used. The walk therefore follows each
 * segment's declared length until it meets a frame header.
 *
 * @param bytes The full file.
 * @returns The dimensions, or `undefined` when no frame header is found before the data ends.
 */
function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  // Start after the two-byte start-of-image marker.
  let offset = 2;

  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      // Not sitting on a marker. A padding byte or a corrupt stream; give up rather than guess,
      // because a misaligned walk could read an arbitrary pair of bytes as a size.
      return undefined;
    }

    const marker = bytes[offset + 1] ?? 0;
    const length = readBigEndian(bytes, offset + 2, 2);
    if (length === undefined || length < 2) {
      return undefined;
    }

    // Start-of-frame markers carry the dimensions. The three exclusions are not frame headers
    // despite falling inside the range: define-huffman-table, define-arithmetic-coding, and
    // restart-interval.
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isStartOfFrame) {
      // Within a frame header: one byte of precision, then height, then width.
      const height = readBigEndian(bytes, offset + 5, 2);
      const width = readBigEndian(bytes, offset + 7, 2);
      return width === undefined || height === undefined ? undefined : { width, height };
    }

    offset += 2 + length;
  }

  return undefined;
}

/**
 * Reads a WebP's dimensions.
 *
 * WebP is three formats behind one signature, and they store their size differently: lossy (`VP8 `)
 * in a VP8 keyframe header, lossless (`VP8L`) as two 14-bit fields packed across a bit stream, and
 * extended (`VP8X`) as two 24-bit fields. All three are handled because all three are produced by
 * ordinary tools, and a visitor has no way to know which one their file is.
 *
 * @param bytes The full file.
 * @returns The dimensions, or `undefined` when the variant is unrecognised or the header is
 *   truncated.
 */
function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const variant = String.fromCharCode(...bytes.subarray(12, 16));

  if (variant === 'VP8 ') {
    // Lossy: a three-byte sync code precedes the dimensions, which are 14-bit values with the
    // upper two bits used as a scale factor this demo ignores.
    const width = readLittleEndian(bytes, 26, 2);
    const height = readLittleEndian(bytes, 28, 2);
    return width === undefined || height === undefined
      ? undefined
      : { width: width & 0x3fff, height: height & 0x3fff };
  }

  if (variant === 'VP8L') {
    // Lossless: dimensions are stored minus one, packed as 14 bits each across four bytes that
    // follow the one-byte signature.
    const packed = readLittleEndian(bytes, 21, 4);
    if (packed === undefined) {
      return undefined;
    }
    return { width: (packed & 0x3fff) + 1, height: ((packed >> 14) & 0x3fff) + 1 };
  }

  if (variant === 'VP8X') {
    // Extended: 24-bit canvas dimensions, also stored minus one.
    const width = readLittleEndian(bytes, 24, 3);
    const height = readLittleEndian(bytes, 27, 3);
    return width === undefined || height === undefined
      ? undefined
      : { width: width + 1, height: height + 1 };
  }

  return undefined;
}

/**
 * Reads a picture's pixel dimensions from its own header.
 *
 * Exists because a byte limit is not a pixel limit. A large flat-coloured image compresses to
 * almost nothing while still being enormous to decode, so a file that passes a size check can still
 * be an unreasonable thing to hand a vision model. Reading the declared dimensions bounds that
 * before a request is made, and does so without decoding the image.
 *
 * The dimensions are read from the file rather than from anything the browser said, for the same
 * reason the media type is: a value the client supplied is a value the client chose.
 *
 * @param bytes The full file.
 * @param mediaType The type already determined by {@link sniffImageMediaType}. Passed in rather
 *   than re-sniffed so the caller cannot accidentally read one format's header as another's.
 * @returns The dimensions, or `undefined` when the header is truncated, malformed, or uses a
 *   variant this demo does not parse.
 */
export function readImageDimensions(
  bytes: Uint8Array,
  mediaType: ImageMediaType
): ImageDimensions | undefined {
  const dimensions =
    mediaType === 'image/png'
      ? pngDimensions(bytes)
      : mediaType === 'image/jpeg'
        ? jpegDimensions(bytes)
        : webpDimensions(bytes);

  // A zero or negative edge is a malformed header rather than a tiny picture, and letting it
  // through would turn a validation rule into a division by zero somewhere downstream.
  if (dimensions === undefined || dimensions.width <= 0 || dimensions.height <= 0) {
    return undefined;
  }

  return dimensions;
}
