/**
 * @file Tests for byte-level video identification. These bytes arrive from a third-party host and
 *   are then served back from this demo's own authenticated origin, so the type must be established
 *   from content rather than from the provider's `Content-Type`. The cases that matter most are the
 *   refusals: an HTML error page or a JSON fault document served under a success status is a real
 *   provider behaviour, and storing one as `video/mp4` would mean serving attacker-influenced
 *   content from our origin under a type we chose for it.
 */

import { describe, expect, it } from 'vitest';
import {
  playableVideoMediaType,
  sniffVideoMediaType,
  VIDEO_SNIFF_BYTES
} from '../../../src/worker/domain/video-bytes';

/**
 * Builds an ISO base media header with the given brand.
 *
 * @param brand Four-character brand to place at offset 8.
 * @returns A buffer whose leading bytes look like the brand's `ftyp` box.
 */
function isoHeader(brand: string): Uint8Array {
  const bytes = new Uint8Array(64);
  // Box size, then the literal `ftyp`, then the brand — the layout the sniffer reads.
  bytes.set([0x00, 0x00, 0x00, 0x20], 0);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4);
  bytes.set(
    Array.from(brand, (character) => character.charCodeAt(0)),
    8
  );
  return bytes;
}

/**
 * Builds a buffer whose leading bytes are EBML magic, shared by WebM and Matroska.
 *
 * @returns A WebM-looking buffer.
 */
function webmHeader(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  return bytes;
}

describe('sniffVideoMediaType', () => {
  it.each(['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'dash'])(
    'identifies the %s brand as MP4',
    (brand) => {
      expect(sniffVideoMediaType(isoHeader(brand))).toBe('video/mp4');
    }
  );

  it('identifies EBML magic as WebM', () => {
    expect(sniffVideoMediaType(webmHeader())).toBe('video/webm');
  });

  it('refuses an ISO container whose brand is not allowlisted', () => {
    // The ISO family covers formats a `<video>` element will not play. Serving one as `video/mp4`
    // would produce a player that fails with no explanation, so an unknown brand is refused rather
    // than assumed.
    expect(sniffVideoMediaType(isoHeader('qt  '))).toBe(undefined);
    expect(sniffVideoMediaType(isoHeader('heic'))).toBe(undefined);
  });

  it('refuses an HTML error page', () => {
    // A provider answering a success status with an error page is a real behaviour, not a
    // hypothetical one.
    const html = new TextEncoder().encode(
      '<!DOCTYPE html><html><body>Gateway Timeout</body></html>'
    );
    expect(sniffVideoMediaType(html)).toBe(undefined);
  });

  it('refuses a JSON fault document', () => {
    const json = new TextEncoder().encode('{"error":"quota exceeded","code":429}');
    expect(sniffVideoMediaType(json)).toBe(undefined);
  });

  it('refuses an image, which is the plausible wrong-media case', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(sniffVideoMediaType(png)).toBe(undefined);
  });

  it('refuses an empty buffer', () => {
    expect(sniffVideoMediaType(new Uint8Array(0))).toBe(undefined);
  });

  it('refuses a truncated header rather than reading past it', () => {
    // Four bytes cannot contain a `ftyp` box at offset 4, and reading optimistically would be an
    // out-of-bounds read reported as a successful identification.
    expect(sniffVideoMediaType(new Uint8Array([0x00, 0x00, 0x00, 0x20]))).toBe(undefined);
  });

  it('needs no more than the published sniff window', () => {
    // The sniffer runs against the head of a stream, so it must not depend on bytes the caller has
    // not promised to buffer.
    const header = isoHeader('isom');
    expect(sniffVideoMediaType(header.subarray(0, VIDEO_SNIFF_BYTES))).toBe('video/mp4');
    expect(header.length).toBeLessThanOrEqual(VIDEO_SNIFF_BYTES);
  });
});

describe('playableVideoMediaType', () => {
  it('accepts the containers the panel plays', () => {
    expect(playableVideoMediaType(isoHeader('isom'))).toBe('video/mp4');
    expect(playableVideoMediaType(webmHeader())).toBe('video/webm');
  });

  it('refuses anything else', () => {
    expect(playableVideoMediaType(new TextEncoder().encode('{"error":1}'))).toBe(undefined);
    expect(playableVideoMediaType(isoHeader('qt  '))).toBe(undefined);
  });
});
