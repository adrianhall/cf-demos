/**
 * @file Tests for reading a picture's dimensions from its own header. This matters more than it
 *   looks. The pixel limit is the only check standing between a visitor and a decompression bomb —
 *   an image that is trivial on disk and enormous once decoded — and a dimension reader that
 *   silently returns `undefined` would turn that limit off without failing anything. Several tests
 *   here therefore assert that a _valid_ header is read correctly, not just that a broken one is
 *   refused.
 */

import { describe, expect, it } from 'vitest';
import { readImageDimensions, sniffImageMediaType } from '../../../src/worker/domain/image-bytes';
import { jpegBytes, pngBytes, webpBytes } from '../support/image-fixtures';

describe('reading PNG dimensions', () => {
  it('reads the size from the IHDR chunk', () => {
    expect(readImageDimensions(pngBytes(800, 600), 'image/png')).toEqual({
      width: 800,
      height: 600
    });
  });

  it('reads a large size without overflowing', () => {
    expect(readImageDimensions(pngBytes(16_384, 16_384), 'image/png')).toEqual({
      width: 16_384,
      height: 16_384
    });
  });

  it('refuses a truncated header', () => {
    const signatureOnly = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(readImageDimensions(signatureOnly, 'image/png')).toBeUndefined();
  });

  // A zero edge is a malformed header rather than a tiny picture, and letting it through would
  // turn a validation rule into a division by zero somewhere downstream.
  it('refuses a header declaring a zero edge', () => {
    expect(readImageDimensions(pngBytes(0, 100), 'image/png')).toBeUndefined();
    expect(readImageDimensions(pngBytes(100, 0), 'image/png')).toBeUndefined();
  });
});

describe('reading JPEG dimensions', () => {
  // Unlike PNG there is no fixed offset: the size lives in whichever start-of-frame segment the
  // encoder used, so the reader has to walk the segment chain to find it.
  it('finds the size by walking to the start-of-frame segment', () => {
    expect(readImageDimensions(jpegBytes(1_024, 768), 'image/jpeg')).toEqual({
      width: 1_024,
      height: 768
    });
  });

  it('walks past a preceding application segment', () => {
    // A JFIF APP0 segment ahead of the frame header, which is what a real camera file looks like.
    const frame = jpegBytes(320, 240);
    const withApp0 = new Uint8Array(frame.length + 18);

    withApp0.set([0xff, 0xd8], 0);
    withApp0.set([0xff, 0xe0], 2);
    // APP0 payload length, covering the 16 bytes that follow the length field itself.
    withApp0.set([0x00, 0x10], 4);
    withApp0.set(frame.subarray(2), 20);

    expect(readImageDimensions(withApp0, 'image/jpeg')).toEqual({ width: 320, height: 240 });
  });

  it('refuses a stream with no frame header', () => {
    const noFrame = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
    expect(readImageDimensions(noFrame, 'image/jpeg')).toBeUndefined();
  });

  // Giving up beats guessing: a misaligned walk could read an arbitrary pair of bytes as a size,
  // which would be a confidently wrong answer rather than a refusal.
  it('refuses a misaligned stream rather than guessing', () => {
    const misaligned = new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(readImageDimensions(misaligned, 'image/jpeg')).toBeUndefined();
  });

  it('refuses a segment declaring an impossible length', () => {
    const badLength = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(readImageDimensions(badLength, 'image/jpeg')).toBeUndefined();
  });
});

describe('reading WebP dimensions', () => {
  // WebP is three formats behind one signature. All three are produced by ordinary tools, and a
  // visitor has no way to know which one their file is.
  it('reads a lossy VP8 header', () => {
    expect(readImageDimensions(webpBytes(640, 480), 'image/webp')).toEqual({
      width: 640,
      height: 480
    });
  });

  it('reads a lossless VP8L header', () => {
    const bytes = new Uint8Array(32);
    const view = new DataView(bytes.buffer);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x45, 0x42, 0x50], 8);
    bytes.set([0x56, 0x50, 0x38, 0x4c], 12);
    bytes[20] = 0x2f;
    // Dimensions are stored minus one, packed as 14 bits each.
    view.setUint32(21, (300 - 1) | ((200 - 1) << 14), true);

    expect(readImageDimensions(bytes, 'image/webp')).toEqual({ width: 300, height: 200 });
  });

  it('reads an extended VP8X header', () => {
    const bytes = new Uint8Array(32);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x45, 0x42, 0x50], 8);
    bytes.set([0x56, 0x50, 0x38, 0x58], 12);
    // 24-bit canvas dimensions, also stored minus one.
    bytes.set([0x3f, 0x00, 0x00], 24);
    bytes.set([0x1f, 0x00, 0x00], 27);

    expect(readImageDimensions(bytes, 'image/webp')).toEqual({ width: 64, height: 32 });
  });

  it('refuses an unrecognised WebP variant', () => {
    const bytes = new Uint8Array(32);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x45, 0x42, 0x50], 8);
    bytes.set([0x56, 0x50, 0x39, 0x39], 12);

    expect(readImageDimensions(bytes, 'image/webp')).toBeUndefined();
  });
});

describe('dimension reading and format sniffing agree', () => {
  // The reader is given the already-sniffed type rather than re-sniffing, so that one picture
  // cannot be identified as two different things. This checks the two stay consistent for every
  // format the demo accepts.
  it.each([
    ['PNG', pngBytes(200, 100), 'image/png'],
    ['JPEG', jpegBytes(200, 100), 'image/jpeg'],
    ['WebP', webpBytes(200, 100), 'image/webp']
  ])('sniffs %s and reads its dimensions consistently', (_label, bytes, expectedType) => {
    const mediaType = sniffImageMediaType(bytes);
    expect(mediaType).toBe(expectedType);
    expect(readImageDimensions(bytes, mediaType!)).toEqual({ width: 200, height: 100 });
  });
});
