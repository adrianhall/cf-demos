/**
 * @file Tests for turning a chosen file into something the panel can send. Every rule these cover
 *   is a courtesy rather than a control — the server re-derives all of it from the bytes — so the
 *   tests are written around a visitor's experience: a clear refusal instead of a round trip that
 *   fails. The one exception is the base64 chunking, which is a real correctness bug that only
 *   appears on files large enough that nobody tries them by hand.
 */

import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_UPLOAD_TYPES,
  encodeBase64,
  formatBytes,
  imageFromClipboard,
  isAcceptedUploadType,
  prepareImage,
  UPLOAD_ACCEPT_ATTRIBUTE
} from '../../../src/client/features/describe-image/image-input';
import { MAX_INPUT_IMAGE_BYTES } from '../../../src/describe-image';

/**
 * Builds a `File` with the given bytes and declared type.
 *
 * @param bytes Contents.
 * @param type Declared media type, as a browser would report it.
 * @param name File name.
 * @returns The file.
 */
function fileOf(bytes: Uint8Array, type = 'image/png', name = 'picture.png'): File {
  return new File([bytes as BlobPart], name, { type });
}

describe('the accepted type list', () => {
  // Matches the server's allowlist. SVG is absent for the same reason it is absent server-side:
  // it is a scripting context rather than a picture, and previewing one executes it.
  it('offers exactly the three raster formats the server accepts', () => {
    expect([...ACCEPTED_UPLOAD_TYPES]).toEqual(['image/png', 'image/jpeg', 'image/webp']);
  });

  it('excludes SVG, which is markup rather than a picture', () => {
    expect(isAcceptedUploadType('image/svg+xml')).toBe(false);
  });

  it('excludes a real image format outside the allowlist', () => {
    expect(isAcceptedUploadType('image/gif')).toBe(false);
  });

  it('builds an accept attribute from the same list', () => {
    for (const type of ACCEPTED_UPLOAD_TYPES) {
      expect(UPLOAD_ACCEPT_ATTRIBUTE).toContain(type);
    }
  });
});

describe('preparing a chosen file', () => {
  it('accepts a picture and reports its size', async () => {
    const outcome = await prepareImage(fileOf(new Uint8Array([1, 2, 3, 4])));

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.image.byteLength).toBe(4);
      expect(outcome.image.fileName).toBe('picture.png');
    }
  });

  it('builds a preview URI the browser can render', async () => {
    const outcome = await prepareImage(fileOf(new Uint8Array([1, 2, 3])));

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.image.previewUri).toMatch(/^data:image\/png;base64,/u);
    }
  });

  // Returned rather than thrown, because every refusal here is an ordinary thing a visitor can do
  // rather than an exceptional condition.
  it('refuses an unsupported type with a message naming the accepted ones', async () => {
    const outcome = await prepareImage(fileOf(new Uint8Array([1]), 'image/gif', 'cat.gif'));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('unsupported-type');
      expect(outcome.message).toContain('PNG');
    }
  });

  it('refuses an empty file', async () => {
    const outcome = await prepareImage(fileOf(new Uint8Array(0)));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('empty');
    }
  });

  // Checked against `size` before reading, so an oversized file never enters memory.
  it('refuses an oversized file without reading it', async () => {
    const tooBig = {
      type: 'image/png',
      size: MAX_INPUT_IMAGE_BYTES + 1,
      name: 'huge.png',
      arrayBuffer: () => {
        throw new Error('the oversized file should be refused before it is read');
      }
    } as unknown as File;

    const outcome = await prepareImage(tooBig);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('too-large');
    }
  });

  it('accepts a file exactly at the size limit', async () => {
    const atLimit = {
      type: 'image/png',
      size: MAX_INPUT_IMAGE_BYTES,
      name: 'big.png',
      arrayBuffer: async () => new Uint8Array(8).buffer
    } as unknown as File;

    expect((await prepareImage(atLimit)).ok).toBe(true);
  });

  // A file can vanish between selection and reading — removable media, or a file replaced
  // underneath the picker — and that should be a message rather than an unhandled rejection.
  it('refuses a file that cannot be read', async () => {
    const unreadable = {
      type: 'image/png',
      size: 16,
      name: 'gone.png',
      arrayBuffer: () => Promise.reject(new Error('NotReadableError'))
    } as unknown as File;

    const outcome = await prepareImage(unreadable);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('unreadable');
    }
  });
});

describe('base64 encoding', () => {
  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const decoded = Uint8Array.from(atob(encodeBase64(bytes)), (char) => char.charCodeAt(0));
    expect([...decoded]).toEqual([...bytes]);
  });

  // The reason the encoder works in chunks. `String.fromCharCode(...bytes)` on a multi-megabyte
  // picture exceeds the argument limit and throws a `RangeError`, which would turn a large but
  // perfectly valid file into an unexplained failure — and only for files too big to try by hand.
  it('encodes a payload far beyond the spread-argument limit', () => {
    const large = new Uint8Array(500_000).fill(0x41);
    expect(() => encodeBase64(large)).not.toThrow();
    expect(encodeBase64(large).length).toBeGreaterThan(600_000);
  });

  it('encodes an empty buffer as an empty string', () => {
    expect(encodeBase64(new Uint8Array(0))).toBe('');
  });
});

describe('pasting a picture', () => {
  /**
   * Builds a clipboard item list.
   *
   * @param items Item descriptors.
   * @returns A list shaped like `DataTransferItemList`.
   */
  function clipboard(items: { kind: string; type: string; file?: File }[]): DataTransferItemList {
    return items.map((item) => ({
      kind: item.kind,
      type: item.type,
      getAsFile: () => item.file ?? null
    })) as unknown as DataTransferItemList;
  }

  // A screenshot is the likeliest thing someone wants described, and making them save it to disk
  // first would be the slowest path to the thing the panel exists to do.
  it('finds a pasted picture', () => {
    const file = fileOf(new Uint8Array([1]));
    expect(imageFromClipboard(clipboard([{ kind: 'file', type: 'image/png', file }]))).toBe(file);
  });

  it('ignores pasted text', () => {
    expect(imageFromClipboard(clipboard([{ kind: 'string', type: 'text/plain' }]))).toBeUndefined();
  });

  it('ignores a pasted file of an unsupported type', () => {
    const file = fileOf(new Uint8Array([1]), 'image/gif');
    expect(
      imageFromClipboard(clipboard([{ kind: 'file', type: 'image/gif', file }]))
    ).toBeUndefined();
  });

  it('takes the first picture when several are pasted', () => {
    const first = fileOf(new Uint8Array([1]), 'image/png', 'first.png');
    const second = fileOf(new Uint8Array([2]), 'image/png', 'second.png');

    expect(
      imageFromClipboard(
        clipboard([
          { kind: 'file', type: 'image/png', file: first },
          { kind: 'file', type: 'image/png', file: second }
        ])
      )
    ).toBe(first);
  });

  it('handles an absent clipboard', () => {
    expect(imageFromClipboard(undefined)).toBeUndefined();
  });
});

describe('formatting a byte count', () => {
  it.each([
    [2_048, '2 KB'],
    [1_572_864, '1.5 MB'],
    [100, '1 KB']
  ])('formats %i bytes as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
