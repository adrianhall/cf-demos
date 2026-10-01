/**
 * @file Builders for real image bytes, used wherever a test needs a picture the production code
 *   will actually accept. These construct genuine headers rather than returning a canned base64
 *   blob. The code under test identifies a format by its signature and reads its dimensions from
 *   its header, so a fixture has to carry both — and building them here means a test can ask for a
 *   specific size ("4,097 pixels wide") instead of hunting for a file that happens to have one.
 */

/**
 * Builds a PNG with the given dimensions.
 *
 * Only the signature and the IHDR chunk are real; no pixel data follows. That is enough, because
 * nothing in this demo decodes a picture — the Worker validates the header and forwards the bytes.
 *
 * @param width Width in pixels to declare.
 * @param height Height in pixels to declare.
 * @param padding Extra trailing bytes, to reach a particular file size.
 * @returns The PNG bytes.
 */
export function pngBytes(width = 64, height = 64, padding = 0): Uint8Array {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  // IHDR: a four-byte length of 13, then the chunk type.
  const ihdr = [0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52];

  const bytes = new Uint8Array(8 + 8 + 8 + padding);
  bytes.set(header, 0);
  bytes.set(ihdr, 8);

  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);

  return bytes;
}

/**
 * Builds a JPEG with the given dimensions.
 *
 * Emits a start-of-image marker followed by a baseline start-of-frame segment, which is the
 * shortest byte sequence the segment walk will accept as a real JPEG.
 *
 * @param width Width in pixels to declare.
 * @param height Height in pixels to declare.
 * @returns The JPEG bytes.
 */
export function jpegBytes(width = 64, height = 64): Uint8Array {
  const bytes = new Uint8Array(20);
  const view = new DataView(bytes.buffer);

  // Start of image.
  bytes[0] = 0xff;
  bytes[1] = 0xd8;

  // Baseline start-of-frame (SOF0), whose payload carries the dimensions.
  bytes[2] = 0xff;
  bytes[3] = 0xc0;
  view.setUint16(4, 17);
  // Sample precision in bits.
  bytes[6] = 8;
  view.setUint16(7, height);
  view.setUint16(9, width);

  return bytes;
}

/**
 * Builds a lossy WebP with the given dimensions.
 *
 * @param width Width in pixels to declare.
 * @param height Height in pixels to declare.
 * @returns The WebP bytes.
 */
export function webpBytes(width = 64, height = 64): Uint8Array {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);

  // "RIFF", a file-size field, then "WEBP".
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, bytes.length - 8, true);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);

  // "VP8 " chunk: the lossy variant.
  bytes.set([0x56, 0x50, 0x38, 0x20], 12);
  // Three-byte frame tag and the three-byte sync code that precedes the dimensions.
  bytes.set([0x9d, 0x01, 0x2a], 23);
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);

  return bytes;
}

/**
 * Encodes bytes as base64, as the browser does before sending them.
 *
 * @param bytes Data to encode.
 * @returns The base64 representation.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

/**
 * A valid PNG, base64-encoded, for the common case where the picture's content is irrelevant.
 *
 * @param width Width in pixels to declare.
 * @param height Height in pixels to declare.
 * @returns The base64 PNG.
 */
export function pngBase64(width = 64, height = 64): string {
  return toBase64(pngBytes(width, height));
}
