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
  it('identifies PNG', () => {
    expect(sniffImageMediaType(withSignature(PNG))).toBe('image/png');
  });

  it('identifies JPEG', () => {
    expect(sniffImageMediaType(withSignature(JPEG))).toBe('image/jpeg');
  });

  it('identifies WebP', () => {
    expect(sniffImageMediaType(withSignature(WEBP))).toBe('image/webp');
  });

  // The specification requires that a declared content type is never trusted alone. These are the
  // cases that rule exists for: each one would be rendered as an image if the declaration were
  // believed.
  describe('refuses data that is not a renderable raster image', () => {
    // The most dangerous case by a distance. A `data:` URI's media type decides how the browser
    // treats the payload, and SVG is a scripting context rather than a picture. It must never be
    // reported as renderable, however the provider labelled it.
    it('refuses SVG markup', () => {
      const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      expect(sniffImageMediaType(svg)).toBeUndefined();
    });

    it('refuses HTML', () => {
      const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');
      expect(sniffImageMediaType(html)).toBeUndefined();
    });

    // A provider that answers with a JSON error document under a success status is a real failure
    // mode, and the bytes must not reach the page as an "image".
    it('refuses a JSON error document', () => {
      const json = new TextEncoder().encode('{"error":"content policy violation"}');
      expect(sniffImageMediaType(json)).toBeUndefined();
    });

    it('refuses an empty buffer', () => {
      expect(sniffImageMediaType(new Uint8Array(0))).toBeUndefined();
    });

    it('refuses GIF, which this panel does not render', () => {
      expect(sniffImageMediaType(withSignature([0x47, 0x49, 0x46, 0x38]))).toBeUndefined();
    });

    it('refuses a BMP', () => {
      expect(sniffImageMediaType(withSignature([0x42, 0x4d]))).toBeUndefined();
    });
  });

  describe('rejects near-miss signatures', () => {
    // "RIFF" alone is also WAV and AVI, so matching it without the "WEBP" marker would accept an
    // audio file as an image.
    it('refuses a RIFF container that is not WebP', () => {
      const wav = [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45];
      expect(sniffImageMediaType(withSignature(wav))).toBeUndefined();
    });

    it('refuses a truncated PNG signature', () => {
      expect(sniffImageMediaType(new Uint8Array(PNG.slice(0, 4)))).toBeUndefined();
    });

    it('refuses a buffer shorter than the signature it starts to match', () => {
      expect(sniffImageMediaType(new Uint8Array([0xff, 0xd8]))).toBeUndefined();
    });

    it('refuses a PNG signature that is one byte wrong', () => {
      const corrupt = [...PNG];
      corrupt[7] = 0x00;
      expect(sniffImageMediaType(withSignature(corrupt))).toBeUndefined();
    });

    // A signature has to be at its documented offset. Finding PNG's magic bytes somewhere in the
    // middle of a payload does not make that payload a PNG.
    it('refuses a signature that appears at the wrong offset', () => {
      const shifted = new Uint8Array(64);
      shifted.set(PNG, 16);
      expect(sniffImageMediaType(shifted)).toBeUndefined();
    });

    it('refuses a WebP whose second marker is at the wrong offset', () => {
      const bytes = new Uint8Array(64);
      bytes.set([0x52, 0x49, 0x46, 0x46], 0);
      bytes.set([0x57, 0x45, 0x42, 0x50], 12);
      expect(sniffImageMediaType(bytes)).toBeUndefined();
    });
  });
});

describe('encodeBase64', () => {
  it('round-trips through decodeBase64', () => {
    const original = withSignature(PNG, 256);
    expect(decodeBase64(encodeBase64(original))).toEqual(original);
  });

  it('encodes an empty buffer', () => {
    expect(encodeBase64(new Uint8Array(0))).toBe('');
  });

  it('encodes every byte value without corruption', () => {
    const all = new Uint8Array(256);
    for (let index = 0; index < 256; index += 1) {
      all[index] = index;
    }
    expect(decodeBase64(encodeBase64(all))).toEqual(all);
  });

  // The chunked implementation exists for exactly this case: a spread call over a multi-megabyte
  // image exceeds the argument limit and throws a RangeError, turning a valid large image into an
  // unexplained failure.
  it('encodes a payload far larger than the argument limit', () => {
    const large = new Uint8Array(1_500_000);
    large.set(PNG, 0);
    const encoded = encodeBase64(large);
    expect(encoded.length).toBeGreaterThan(1_000_000);
    expect(decodeBase64(encoded)).toEqual(large);
  });

  it('preserves a payload whose length is not a multiple of three', () => {
    const odd = withSignature(PNG, 100);
    expect(decodeBase64(encodeBase64(odd))).toEqual(odd);
  });
});

describe('decodeBase64', () => {
  it('reports invalid base64 as undefined rather than throwing', () => {
    expect(decodeBase64('not base64 !!!')).toBeUndefined();
  });

  it('decodes a valid payload', () => {
    expect(decodeBase64(encodeBase64(withSignature(JPEG)))).toBeDefined();
  });
});

describe('imageFileName', () => {
  it('builds a name from the run identifier and the extension', () => {
    expect(imageFileName('run-123', 'png')).toBe('playground-run-123.png');
  });

  // The prompt is deliberately not part of the name: user text in a file name is a needless
  // path-traversal and header-injection surface, and a long prompt makes an unusable name.
  it('does not incorporate user text', () => {
    expect(imageFileName('run-123', 'png')).not.toMatch(/\s/u);
  });
});
