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

import { isRenderableImageMediaType, type ImageMediaType } from '../../images';

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
