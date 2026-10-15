import { unprocessableContent } from '@adrianhall/cloudflare-toolkit/errors';

/**
 * Shape a manifest path must match: a relative path inside the documentation checkout, ending in a
 * Markdown extension.
 *
 * The pattern is the security control, not a convenience. It rejects an absolute path, a Windows
 * drive letter, a `..` segment, and any extension other than Markdown, so a manifest entry can only
 * ever name a Markdown page below the configured content root. The importer never crawls and never
 * fetches a URL, so this is the only way content can enter the index.
 */
const MANIFEST_PATH_PATTERN = /^(?!\/)(?:[\w.-]+\/)*[\w.-]+\.mdx?$/u;

/**
 * Longest accepted page title, matching the bound the importer applies to the front-matter title.
 */
const MAX_TITLE_LENGTH = 200;

/**
 * Shape a content hash must match: lowercase hexadecimal SHA-256.
 */
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Indexing state of one approved documentation page.
 */
export type DocumentationIndexStatus = 'pending' | 'indexed' | 'failed';

/**
 * One entry in the committed documentation manifest.
 *
 * The manifest is the approval list. An administrator reviewing this file is reviewing exactly what
 * the product may ground an answer in, which is only useful if the file is the sole input — hence
 * no globs, no directories, and no remote sources.
 */
export interface ManifestEntry {
  /**
   * Path of the Markdown page, relative to the documentation checkout root.
   */
  path: string;
  /**
   * Product slug this page belongs to, matching the seeded product map.
   */
  productId: string;
  /**
   * Human-readable page title shown in the administrator view.
   */
  title: string;
  /**
   * SHA-256 of the page content at {@link SourceManifest.revision}.
   *
   * Recorded in the manifest rather than computed at import time because a Worker has no
   * filesystem: the documentation checkout exists on a maintainer's machine, not in the deployment.
   * `pnpm generate:manifest` reads the checkout and writes this file, so reviewing the committed
   * manifest is reviewing exactly the bytes that were approved — and an import is then an offline
   * operation that cannot reach anything the review did not cover.
   */
  contentHash: string;
}

/**
 * The committed manifest as a whole.
 */
export interface SourceManifest {
  /**
   * Repository the paths are relative to, recorded so an administrator can tell which checkout the
   * manifest describes.
   */
  repository: string;
  /**
   * Commit the manifest was validated against.
   */
  revision: string;
  /**
   * Approved pages.
   */
  entries: ManifestEntry[];
}

/**
 * One approved documentation page as stored in D1.
 */
export interface DocumentationSource {
  /**
   * Manifest path, which is also the primary key: re-importing the same page updates its row.
   */
  path: string;
  /**
   * Product slug, or `null` when the page is not product-specific.
   */
  productId: string | null;
  /**
   * Page title.
   */
  title: string;
  /**
   * SHA-256 of the imported content, used to detect that a page changed since it was indexed.
   */
  contentHash: string;
  /**
   * Checkout revision the content was read from.
   */
  sourceRevision: string;
  /**
   * Indexing state.
   */
  indexStatus: DocumentationIndexStatus;
  /**
   * Number of indexing attempts made.
   */
  attempts: number;
  /**
   * Short, content-free description of the most recent failure, or `null`.
   */
  lastError: string | null;
  /**
   * ISO-8601 instant the page was last imported.
   */
  importedAt: string;
  /**
   * ISO-8601 instant the page was last successfully indexed, or `null`.
   */
  indexedAt: string | null;
}

/**
 * One approved page resolved against the manifest revision it was approved at.
 */
export interface ImportedPage {
  /**
   * Manifest entry describing the page, including its reviewed content hash.
   */
  entry: ManifestEntry;
  /**
   * Checkout revision the entry's hash was recorded at.
   */
  sourceRevision: string;
}

/**
 * Validate a documentation path.
 *
 * This is the containment check. It is exported on its own because a path also arrives from places
 * that carry no surrounding entry — a queue message, a maintenance record — and those must be
 * checked with exactly the same rule rather than a looser one written nearby.
 *
 * @param value Candidate path.
 * @returns The validated relative Markdown path.
 * @throws {ProblemDetailsError} `unprocessableContent()` (422) when the value is absolute, contains
 *   a `..` segment, or does not end in a Markdown extension.
 */
export function validateDocumentationPath(value: unknown): string {
  if (
    typeof value !== 'string'
    || !MANIFEST_PATH_PATTERN.test(value)
    || value.split('/').includes('..')
  ) {
    throw unprocessableContent({
      detail: 'A documentation path must be relative, Markdown, and free of ".." segments.'
    });
  }
  return value;
}

/**
 * Validate one manifest entry.
 *
 * @param value Candidate entry, parsed from the manifest or supplied by an import request.
 * @param position Index of the entry, used to make the error message locatable.
 * @returns The validated entry.
 * @throws {ProblemDetailsError} `unprocessableContent()` (422) when the entry is not an object, or
 *   its path, product, or title is missing or malformed. A path that escapes the content root — an
 *   absolute path or one containing `..` — fails here.
 */
export function validateManifestEntry(value: unknown, position: number): ManifestEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw unprocessableContent({ detail: `Manifest entry ${position} must be an object.` });
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.path !== 'string' || !MANIFEST_PATH_PATTERN.test(entry.path)) {
    throw unprocessableContent({
      detail: `Manifest entry ${position} must have a relative Markdown path without ".." segments.`
    });
  }
  if (typeof entry.productId !== 'string' || entry.productId.length === 0) {
    throw unprocessableContent({
      detail: `Manifest entry ${position} must name a product.`
    });
  }
  if (
    typeof entry.title !== 'string'
    || entry.title.trim().length === 0
    || entry.title.length > MAX_TITLE_LENGTH
  ) {
    throw unprocessableContent({
      detail: `Manifest entry ${position} must have a title of 1 to ${MAX_TITLE_LENGTH} characters.`
    });
  }
  return {
    path: entry.path,
    productId: entry.productId,
    title: entry.title.trim(),
    contentHash: validateContentHash(entry.contentHash)
  };
}

/**
 * Validate a whole manifest, including that no page is approved twice.
 *
 * A duplicate path is an error rather than a tolerated repetition: two entries for one page would
 * be imported into one row, so the second would silently override the first's product or title and
 * the manifest would no longer describe what was actually imported.
 *
 * @param value Candidate manifest, typically the parsed committed JSON file.
 * @returns The validated manifest.
 * @throws {ProblemDetailsError} `unprocessableContent()` (422) when the document is not an object,
 *   `repository` or `revision` is missing, `entries` is not a non-empty array, an entry is invalid,
 *   or a path appears more than once.
 */
export function validateSourceManifest(value: unknown): SourceManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw unprocessableContent({ detail: 'The manifest must be an object.' });
  }
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.repository !== 'string' || manifest.repository.length === 0) {
    throw unprocessableContent({ detail: 'The manifest must name its source repository.' });
  }
  if (typeof manifest.revision !== 'string' || manifest.revision.length === 0) {
    throw unprocessableContent({ detail: 'The manifest must record its source revision.' });
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw unprocessableContent({ detail: 'The manifest must approve at least one page.' });
  }

  const entries = manifest.entries.map((entry, position) => validateManifestEntry(entry, position));
  const paths = new Set<string>();
  for (const entry of entries) {
    if (paths.has(entry.path)) {
      throw unprocessableContent({ detail: `Manifest path ${entry.path} is approved twice.` });
    }
    paths.add(entry.path);
  }
  return { repository: manifest.repository, revision: manifest.revision, entries };
}

/**
 * Validate a content hash supplied alongside imported content.
 *
 * @param value Candidate hash.
 * @returns The validated lowercase hexadecimal SHA-256.
 * @throws {ProblemDetailsError} `unprocessableContent()` (422) when the value is not a 64-character
 *   lowercase hexadecimal string.
 */
export function validateContentHash(value: unknown): string {
  if (typeof value !== 'string' || !CONTENT_HASH_PATTERN.test(value)) {
    throw unprocessableContent({
      detail: 'contentHash must be a lowercase hexadecimal SHA-256 digest.'
    });
  }
  return value;
}

/**
 * Answer whether an imported page differs from what is already stored.
 *
 * Used to avoid re-indexing an unchanged page on every import. The comparison is on content hash
 * rather than on the revision, because most commits to a documentation repository do not touch most
 * pages, and re-indexing all of them would make an import cost proportional to the manifest rather
 * than to what actually changed.
 *
 * @param stored Row currently in D1, or `null` when the page has never been imported.
 * @param page Freshly read page.
 * @returns Whether the page needs importing and re-indexing.
 */
export function needsReindex(stored: DocumentationSource | null, page: ImportedPage): boolean {
  if (stored === null || stored.indexStatus !== 'indexed') {
    return true;
  }
  return stored.contentHash !== page.entry.contentHash || stored.title !== page.entry.title;
}

/**
 * Persistence port for approved documentation pages.
 */
export interface DocumentationRepository {
  /**
   * List approved pages for the administrator view.
   *
   * @param limit Largest number of pages to return.
   * @returns Pages ordered by path.
   * @throws {Error} When the underlying storage rejects the read.
   */
  list(limit: number): Promise<DocumentationSource[]>;

  /**
   * Read one page by its manifest path.
   *
   * @param path Manifest path.
   * @returns The stored page, or `null` when it has never been imported.
   * @throws {Error} When the underlying storage rejects the read.
   */
  find(path: string): Promise<DocumentationSource | null>;

  /**
   * Insert or update one page, resetting its indexing state.
   *
   * @param page Freshly read page.
   * @param importedAt ISO-8601 instant of the import.
   * @returns The stored page.
   * @throws {Error} When the underlying storage rejects the write.
   */
  upsert(page: ImportedPage, importedAt: string): Promise<DocumentationSource>;

  /**
   * Record that a page was indexed successfully.
   *
   * @param path Manifest path.
   * @param indexedAt ISO-8601 instant of the successful index.
   * @returns A promise fulfilled once the page is marked `indexed`.
   * @throws {Error} When the underlying storage rejects the write.
   */
  markIndexed(path: string, indexedAt: string): Promise<void>;

  /**
   * Record that indexing a page failed, incrementing its attempt count.
   *
   * @param path Manifest path.
   * @param message Short, content-free failure description.
   * @returns A promise fulfilled once the failure is durable.
   * @throws {Error} When the underlying storage rejects the write.
   */
  markFailed(path: string, message: string): Promise<void>;
}
