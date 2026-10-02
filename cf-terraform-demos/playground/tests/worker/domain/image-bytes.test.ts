import { describe, expect, it } from 'vitest';
import {
  decodeBase64,
  encodeBase64,
  imageFileName,
  sniffImageMediaType
} from '../../../src/worker/domain/image-bytes';

/**
 * Builds a byte array with a signature followed by filler.
 *
 * @param signature Leading bytes.
 * @param length Total length to pad to.
 * @returns The constructed buffer.
 */
function withSignature(signature: number[], length = 64): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(signature, 0);
  return bytes;
}

/**
 * A minimal valid PNG header.
 */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/**
 * A minimal valid JPEG header.
 */
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
/**
 * A minimal valid WebP header: "RIFF" + 4 size bytes + "WEBP".
 */
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];

describe('sniffImageMediaType', () => {
  it('identifies PNG', () => expect(sniffImageMediaType(withSignature(PNG))).toBe('image/png'));
  it('identifies JPEG', () => expect(sniffImageMediaType(withSignature(JPEG))).toBe('image/jpeg'));
  it('identifies WebP', () => expect(sniffImageMediaType(withSignature(WEBP))).toBe('image/webp'));
  it('refuses unknown content', () =>
    expect(sniffImageMediaType(new Uint8Array([1, 2, 3]))).toBeUndefined());
});

describe('base64 helpers', () => {
  it('round trips bytes', () =>
    expect(decodeBase64(encodeBase64(new Uint8Array([0, 1, 255])))).toEqual(
      new Uint8Array([0, 1, 255])
    ));
  it('refuses malformed base64', () => expect(decodeBase64('not base64!')).toBeUndefined());
});

describe('imageFileName', () => {
  it('uses only run ID and sniffed extension', () =>
    expect(imageFileName('run-1', 'png')).toBe('playground-run-1.png'));
});
