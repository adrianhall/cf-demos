import { describe, expect, it } from 'vitest';
import committedManifest from '../../../src/documentation-manifest.json' with { type: 'json' };
import {
  needsReindex,
  validateContentHash,
  validateDocumentationPath,
  validateManifestEntry,
  validateSourceManifest,
  type DocumentationSource,
  type ManifestEntry
} from '../../../src/worker/domain/documentation';

const HASH = 'a'.repeat(64);
const ENTRY: ManifestEntry = {
  path: 'src/content/docs/d1/index.mdx',
  productId: 'd1',
  title: 'Cloudflare D1',
  contentHash: HASH
};

/**
 * Build a stored documentation row for a comparison test.
 *
 * @param overrides Fields to change from a freshly indexed page.
 * @returns A stored page.
 */
function storedPage(overrides: Partial<DocumentationSource> = {}): DocumentationSource {
  return {
    path: ENTRY.path,
    productId: ENTRY.productId,
    title: ENTRY.title,
    contentHash: HASH,
    sourceRevision: 'abc1234',
    indexStatus: 'indexed',
    attempts: 0,
    lastError: null,
    importedAt: '2026-10-01T00:00:00.000Z',
    indexedAt: '2026-10-01T00:01:00.000Z',
    ...overrides
  };
}

describe('documentation path containment', () => {
  it('accepts a relative Markdown path', () =>
    expect(validateDocumentationPath('src/content/docs/d1/index.mdx')).toBe(
      'src/content/docs/d1/index.mdx'
    ));

  it.each([
    '/etc/passwd',
    '../../../etc/passwd',
    'src/content/../../../secrets.md',
    'src/content/docs/d1/index.txt',
    'https://example.com/page.md',
    'C:\\docs\\page.md',
    ''
  ])('rejects %p', (path) =>
    expect(() => validateDocumentationPath(path)).toThrowError(expect.any(Error))
  );
});

describe('validateManifestEntry', () => {
  it('accepts a complete entry and trims its title', () =>
    expect(validateManifestEntry({ ...ENTRY, title: '  D1  ' }, 0).title).toBe('D1'));

  it.each([null, [], 'text'])('rejects %p as an entry', (value) =>
    expect(() => validateManifestEntry(value, 3)).toThrowError(expect.any(Error))
  );

  it('requires a product', () =>
    expect(() => validateManifestEntry({ ...ENTRY, productId: '' }, 0)).toThrowError(
      expect.any(Error)
    ));

  it('requires a title', () =>
    expect(() => validateManifestEntry({ ...ENTRY, title: '   ' }, 0)).toThrowError(
      expect.any(Error)
    ));

  it('requires a reviewed content hash', () =>
    expect(() => validateManifestEntry({ ...ENTRY, contentHash: 'short' }, 0)).toThrowError(
      expect.any(Error)
    ));
});

describe('validateSourceManifest', () => {
  it('validates the committed manifest this demo ships', () => {
    const manifest = validateSourceManifest(committedManifest);
    expect(manifest.entries.length).toBeGreaterThan(0);
    expect(manifest.revision).not.toBe('');
  });

  it('rejects a manifest that approves the same page twice', () =>
    // A duplicate would be imported into one row, silently overriding the first entry's product
    // or title, so the manifest would no longer describe what was imported.
    expect(() =>
      validateSourceManifest({ repository: 'r', revision: 'v', entries: [ENTRY, ENTRY] })
    ).toThrowError(expect.any(Error)));

  it.each([
    { revision: 'v', entries: [ENTRY] },
    { repository: 'r', entries: [ENTRY] },
    { repository: 'r', revision: 'v', entries: [] },
    { repository: 'r', revision: 'v' }
  ])('rejects a malformed manifest', (manifest) =>
    expect(() => validateSourceManifest(manifest)).toThrowError(expect.any(Error))
  );

  it.each([null, [], 'text'])('rejects %p as a manifest', (value) =>
    expect(() => validateSourceManifest(value)).toThrowError(expect.any(Error))
  );
});

describe('validateContentHash', () => {
  it('accepts a lowercase SHA-256', () => expect(validateContentHash(HASH)).toBe(HASH));

  it.each(['A'.repeat(64), 'a'.repeat(63), '', null])('rejects %p', (value) =>
    expect(() => validateContentHash(value)).toThrowError(expect.any(Error))
  );
});

describe('needsReindex', () => {
  const page = { entry: ENTRY, sourceRevision: 'def5678' };

  it('imports a page that has never been seen', () => expect(needsReindex(null, page)).toBe(true));

  it('skips an unchanged, already indexed page', () =>
    // An import then costs what actually changed rather than the size of the manifest.
    expect(needsReindex(storedPage(), page)).toBe(false));

  it('re-imports when the content hash changed', () =>
    expect(needsReindex(storedPage({ contentHash: 'b'.repeat(64) }), page)).toBe(true));

  it('re-imports when only the title changed', () =>
    expect(needsReindex(storedPage({ title: 'Old title' }), page)).toBe(true));

  it.each(['pending', 'failed'] as const)('re-imports a page whose index state is %s', (status) =>
    expect(needsReindex(storedPage({ indexStatus: status }), page)).toBe(true)
  );
});
