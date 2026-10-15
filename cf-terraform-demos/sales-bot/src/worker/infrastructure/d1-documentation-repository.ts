import { throwIfNull } from '@adrianhall/cloudflare-toolkit/guards';
import type {
  DocumentationIndexStatus,
  DocumentationRepository,
  DocumentationSource,
  ImportedPage
} from '../domain/documentation';

/**
 * Columns selected for every documentation read.
 */
const SOURCE_COLUMNS =
  'path, product_id, title, content_hash, source_revision, index_status, attempts, last_error, '
  + 'imported_at, indexed_at';

/**
 * Raw snake_cased documentation row as stored in D1.
 */
interface SourceRow {
  /**
   * Manifest path, which is the primary key.
   */
  path: string;
  /**
   * Product slug, or `null`.
   */
  product_id: string | null;
  /**
   * Page title.
   */
  title: string;
  /**
   * SHA-256 of the imported content.
   */
  content_hash: string;
  /**
   * Checkout revision the content was read at.
   */
  source_revision: string;
  /**
   * Indexing state as stored.
   */
  index_status: string;
  /**
   * Indexing attempt count.
   */
  attempts: number;
  /**
   * Most recent failure description, or `null`.
   */
  last_error: string | null;
  /**
   * Last import instant.
   */
  imported_at: string;
  /**
   * Last successful index instant, or `null`.
   */
  indexed_at: string | null;
}

/**
 * Narrow a stored index-status column.
 *
 * An unrecognized value becomes `pending`, so an unreadable state causes the page to be indexed
 * again rather than assumed current.
 *
 * @param value Raw column value.
 * @returns The indexing state.
 */
function toIndexStatus(value: string): DocumentationIndexStatus {
  return value === 'indexed' || value === 'failed' ? value : 'pending';
}

/**
 * Convert a stored row into the domain representation.
 *
 * @param row Row returned by a query using {@link SOURCE_COLUMNS}.
 * @returns The equivalent domain documentation source.
 */
function toSource(row: SourceRow): DocumentationSource {
  return {
    path: row.path,
    productId: row.product_id,
    title: row.title,
    contentHash: row.content_hash,
    sourceRevision: row.source_revision,
    indexStatus: toIndexStatus(row.index_status),
    attempts: row.attempts,
    lastError: row.last_error,
    importedAt: row.imported_at,
    indexedAt: row.indexed_at
  };
}

/**
 * D1 implementation of the {@link DocumentationRepository} port.
 *
 * Keyed by manifest path rather than by a surrogate identifier. That is what makes an import
 * idempotent: re-importing the same manifest updates the row for each page instead of accumulating
 * a second copy of every page on every run.
 */
export class D1DocumentationRepository implements DocumentationRepository {
  /**
   * @param database D1 database bound to this Worker.
   */
  public constructor(private readonly database: Pick<D1Database, 'prepare'>) {}

  /**
   * List approved pages for the administrator view.
   *
   * @param limit Largest number of pages to return.
   * @returns Pages ordered by path.
   * @throws {Error} When D1 rejects the query.
   */
  public async list(limit: number): Promise<DocumentationSource[]> {
    const result = await this.database
      .prepare(`SELECT ${SOURCE_COLUMNS} FROM documentation_sources ORDER BY path ASC LIMIT ?`)
      .bind(limit)
      .all<SourceRow>();
    return result.results.map(toSource);
  }

  /**
   * Read one page by its manifest path.
   *
   * @param path Manifest path.
   * @returns The stored page, or `null` when it has never been imported.
   * @throws {Error} When D1 rejects the query.
   */
  public async find(path: string): Promise<DocumentationSource | null> {
    const row = await this.database
      .prepare(`SELECT ${SOURCE_COLUMNS} FROM documentation_sources WHERE path = ? LIMIT 1`)
      .bind(path)
      .first<SourceRow>();
    return row === null ? null : toSource(row);
  }

  /**
   * Insert or update one page, resetting its indexing state.
   *
   * The reset is deliberate: new content has not been indexed, however recently the previous
   * content was, and leaving the old `indexed` state would make the freshness view claim the index
   * holds text it does not.
   *
   * @param page Freshly read page.
   * @param importedAt ISO-8601 instant of the import.
   * @returns The stored page.
   * @throws {Error} When D1 rejects the write, or when the row cannot be read back.
   */
  public async upsert(page: ImportedPage, importedAt: string): Promise<DocumentationSource> {
    await this.database
      .prepare(
        'INSERT INTO documentation_sources (path, product_id, title, content_hash, '
          + 'source_revision, index_status, attempts, last_error, imported_at, indexed_at) '
          + "VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?, NULL) "
          + 'ON CONFLICT(path) DO UPDATE SET product_id = excluded.product_id, '
          + 'title = excluded.title, content_hash = excluded.content_hash, '
          + "source_revision = excluded.source_revision, index_status = 'pending', attempts = 0, "
          + 'last_error = NULL, imported_at = excluded.imported_at, indexed_at = NULL'
      )
      .bind(
        page.entry.path,
        page.entry.productId,
        page.entry.title,
        page.entry.contentHash,
        page.sourceRevision,
        importedAt
      )
      .run();

    const stored = await this.find(page.entry.path);
    throwIfNull(stored, 'An imported documentation page must be readable immediately after import');
    return stored;
  }

  /**
   * Record that a page was indexed successfully.
   *
   * @param path Manifest path.
   * @param indexedAt ISO-8601 instant of the successful index.
   * @returns A promise fulfilled once the page is marked `indexed`.
   * @throws {Error} When D1 rejects the update.
   */
  public async markIndexed(path: string, indexedAt: string): Promise<void> {
    await this.database
      .prepare(
        "UPDATE documentation_sources SET index_status = 'indexed', last_error = NULL, "
          + 'indexed_at = ? WHERE path = ?'
      )
      .bind(indexedAt, path)
      .run();
  }

  /**
   * Record that indexing a page failed, incrementing its attempt count.
   *
   * The statement is a no-op for a path that has never been imported. That is the right behaviour
   * for the importer's "this manifest entry is missing from the checkout" case: there is nothing to
   * annotate, and inserting a placeholder row would put a page into the approved list that no
   * content exists for.
   *
   * @param path Manifest path.
   * @param message Short, content-free failure description.
   * @returns A promise fulfilled once the failure is durable.
   * @throws {Error} When D1 rejects the update.
   */
  public async markFailed(path: string, message: string): Promise<void> {
    await this.database
      .prepare(
        "UPDATE documentation_sources SET index_status = 'failed', attempts = attempts + 1, "
          + 'last_error = ? WHERE path = ?'
      )
      .bind(message, path)
      .run();
  }
}
