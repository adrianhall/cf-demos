import { describe, expect, it } from 'vitest';
import {
  addToGallery,
  downloadFileName,
  downloadLabel,
  formatBytes,
  imageAltText,
  MAX_GALLERY_RESULTS,
  toDataUri,
  type GalleryEntry
} from '../../../src/client/features/create-image/gallery';
import type { ImageMediaType } from '../../../src/shared/images';

/**
 * Builds a gallery entry.
 *
 * @param overrides Fields to replace on a default PNG entry.
 * @returns An entry ready to use.
 */
function entry(overrides: Partial<GalleryEntry> = {}): GalleryEntry {
  return {
    runId: 'run-1',
    image: { base64: 'AAAA', mediaType: 'image/png', byteLength: 2_048 },
    applied: { prompt: 'a lighthouse', model: '@cf/test/model', steps: 8 },
    modelName: 'Test Model',
    ...overrides
  };
}

describe('toDataUri', () => {
  it('builds a data URI from the sniffed media type and payload', () => {
    expect(toDataUri(entry().image)).toBe('data:image/png;base64,AAAA');
  });

  it.each(['image/png', 'image/jpeg', 'image/webp'] as ImageMediaType[])(
    'renders %s',
    (mediaType) => {
      expect(toDataUri({ base64: 'AAAA', mediaType, byteLength: 1 })).toContain(
        `data:${mediaType}`
      );
    }
  );

  // The check at the point of use is not redundant with the server's. This function is what hands a
  // media type to the browser's `data:` URI parser, and that type decides how the payload is
  // treated — so a future code path that obtained an image some other way cannot skip the check.
  it('refuses a media type outside the renderable allowlist', () => {
    const unsafe = { base64: 'AAAA', mediaType: 'image/svg+xml', byteLength: 1 };
    expect(() => toDataUri(unsafe as never)).toThrow(/unexpected media type/iu);
  });

  // Thrown rather than returning an empty string: a blank image reads as a rendering bug, whereas a
  // thrown error is a refusal somebody will investigate.
  it('throws rather than returning a blank source', () => {
    const unsafe = { base64: 'AAAA', mediaType: 'text/html', byteLength: 1 };
    expect(() => toDataUri(unsafe as never)).toThrow();
  });
});

describe('downloadFileName', () => {
  it('uses the extension matching the sniffed media type', () => {
    expect(downloadFileName(entry())).toBe('playground-run-1.png');
  });

  it.each([
    ['image/jpeg' as ImageMediaType, 'jpg'],
    ['image/webp' as ImageMediaType, 'webp']
  ])('maps %s to .%s', (mediaType, extension) => {
    const result = downloadFileName(entry({ image: { base64: 'A', mediaType, byteLength: 1 } }));
    expect(result).toBe(`playground-run-1.${extension}`);
  });

  // User text in a file name is a needless path-traversal and header-injection surface, and a long
  // prompt makes an unusable name.
  it('does not incorporate the prompt', () => {
    const name = downloadFileName(entry({ applied: { prompt: '../../etc/passwd', model: 'm' } }));
    expect(name).toBe('playground-run-1.png');
    expect(name).not.toContain('..');
  });
});

describe('downloadLabel', () => {
  // "Download" alone tells a screen-reader user nothing about what they are about to save, and the
  // format is not conveyed anywhere else.
  it('names the format in the accessible label', () => {
    expect(downloadLabel(entry())).toBe('Download this image as PNG');
  });

  it('names JPEG for a JPEG result', () => {
    const label = downloadLabel(
      entry({ image: { base64: 'A', mediaType: 'image/jpeg', byteLength: 1 } })
    );
    expect(label).toContain('JPG');
  });
});

describe('imageAltText', () => {
  // Nothing here has looked at the picture, so the alt text says what was asked for and labels it
  // as such. Asserting what the image contains would be a confident lie to the one user who cannot
  // check it — and diffusion models frequently do not produce what was requested.
  it('describes the image as generated from its prompt', () => {
    expect(imageAltText(entry())).toBe('Image generated from the prompt: a lighthouse');
  });

  it('does not claim to describe the picture itself', () => {
    const alt = imageAltText(entry());
    expect(alt).toMatch(/generated from the prompt/iu);
  });

  it('includes the full prompt so the description is specific', () => {
    const alt = imageAltText(entry({ applied: { prompt: 'a red bicycle', model: 'm' } }));
    expect(alt).toContain('a red bicycle');
  });
});

describe('addToGallery', () => {
  it('adds the newest result first', () => {
    const gallery = addToGallery([entry({ runId: 'old' })], entry({ runId: 'new' }));
    expect(gallery.map((item) => item.runId)).toEqual(['new', 'old']);
  });

  it('starts a gallery from empty', () => {
    expect(addToGallery([], entry())).toHaveLength(1);
  });

  // Each entry holds a multi-megabyte base64 payload, so an unbounded gallery would grow a long
  // session's tab until the browser evicted it.
  it('bounds the gallery and drops the oldest entry', () => {
    let gallery: GalleryEntry[] = [];
    for (let index = 0; index <= MAX_GALLERY_RESULTS; index += 1) {
      gallery = addToGallery(gallery, entry({ runId: `run-${index}` }));
    }

    expect(gallery).toHaveLength(MAX_GALLERY_RESULTS);
    expect(gallery.map((item) => item.runId)).not.toContain('run-0');
    expect(gallery[0]?.runId).toBe(`run-${MAX_GALLERY_RESULTS}`);
  });

  it('does not mutate the gallery it was given', () => {
    const original = [entry({ runId: 'first' })];
    addToGallery(original, entry({ runId: 'second' }));
    expect(original).toHaveLength(1);
  });
});

describe('formatBytes', () => {
  it('reports megabytes for a large image', () => {
    expect(formatBytes(2_621_440)).toBe('2.5 MB');
  });

  it('reports kilobytes for a smaller image', () => {
    expect(formatBytes(860 * 1_024)).toBe('860 KB');
  });

  // A sub-kilobyte image is unusual but possible, and "0 KB" would read as an empty file.
  it('never reports zero for a non-empty image', () => {
    expect(formatBytes(120)).toBe('1 KB');
  });
});
