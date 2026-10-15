import { throwIfNull } from '@adrianhall/cloudflare-toolkit/guards';
import {
  statusAfterFailure,
  type FaqIndexJob,
  type IndexJobRepository,
  type IndexJobStatus,
  type IndexOperation
} from '../domain/index-job';

/**
 * Columns selected for every index-job read.
 */
const JOB_COLUMNS =
  'id, faq_id, faq_revision, operation, search_document_id, status, attempts, last_error, updated_at';

/**
 * Raw snake_cased index-job row as stored in D1.
 */
interface JobRow {
  /**
   * Job identifier.
   */
  id: string;
  /**
   * FAQ identifier.
   */
  faq_id: string;
  /**
   * Revision being indexed or removed.
   */
  faq_revision: number;
  /**
   * Operation as stored.
   */
  operation: string;
  /**
   * Search document identifier, or `null`.
   */
  search_document_id: string | null;
  /**
   * Lifecycle state as stored.
   */
  status: string;
  /**
   * Attempt count.
   */
  attempts: number;
  /**
   * Most recent failure description, or `null`.
   */
  last_error: string | null;
  /**
   * Last-change instant.
   */
  updated_at: string;
}

/**
 * Narrow a stored status column.
 *
 * An unrecognized value becomes `pending`, so a job whose state cannot be read is retried rather
 * than silently considered complete. A document that is indexed twice is harmless; one that is
 * never indexed is a published answer nobody can find.
 *
 * @param value Raw column value.
 * @returns The lifecycle state.
 */
function toStatus(value: string): IndexJobStatus {
  return value === 'indexed' || value === 'failed' ? value : 'pending';
}

/**
 * Convert a stored row into the domain representation.
 *
 * @param row Row returned by a query using {@link JOB_COLUMNS}.
 * @returns The equivalent domain job.
 */
function toJob(row: JobRow): FaqIndexJob {
  return {
    id: row.id,
    faqId: row.faq_id,
    faqRevision: row.faq_revision,
    operation: row.operation === 'delete' ? 'delete' : 'upsert',
    searchDocumentId: row.search_document_id,
    status: toStatus(row.status),
    attempts: row.attempts,
    lastError: row.last_error,
    updatedAt: row.updated_at
  };
}

/**
 * D1 implementation of the {@link IndexJobRepository} port.
 *
 * The `(faq_id, faq_revision, operation)` uniqueness constraint created by the Phase 2 migration
 * makes the whole indexing pipeline idempotent: {@link D1IndexJobRepository.enqueue} inserts with
 * `OR IGNORE` and then reads the row back, so replaying an upsert or deletion converges on one job,
 * while an archived or expired revision may still enqueue its necessary deletion.
 */
export class D1IndexJobRepository implements IndexJobRepository {
  /**
   * @param database D1 database bound to this Worker.
   */
  public constructor(private readonly database: Pick<D1Database, 'prepare'>) {}

  /**
   * Record the intent to index or remove one revision, ignoring a duplicate.
   *
   * @param faqId FAQ the job belongs to.
   * @param faqRevision Revision to index or remove.
   * @param operation Whether to publish or remove the revision.
   * @returns The job for that revision, created now or pre-existing.
   * @throws {Error} When D1 rejects the write, or when the row cannot be read back immediately
   *   after being written — which would mean the constraint this method relies on is gone.
   */
  public async enqueue(
    faqId: string,
    faqRevision: number,
    operation: IndexOperation
  ): Promise<FaqIndexJob> {
    const now = new Date().toISOString();
    await this.database
      .prepare(
        'INSERT OR IGNORE INTO faq_index_jobs (id, faq_id, faq_revision, operation, status, '
          + "attempts, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?)"
      )
      .bind(crypto.randomUUID(), faqId, faqRevision, operation, now)
      .run();

    const row = await this.database
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM faq_index_jobs WHERE faq_id = ? AND faq_revision = ? `
          + 'AND operation = ?'
      )
      .bind(faqId, faqRevision, operation)
      .first<JobRow>();
    throwIfNull(row, 'An enqueued index job must be readable immediately after it is written');
    return toJob(row);
  }

  /**
   * Read jobs still waiting to run, oldest first.
   *
   * @param limit Largest number of jobs to claim.
   * @returns Pending jobs.
   * @throws {Error} When D1 rejects the query.
   */
  public async listPending(limit: number): Promise<FaqIndexJob[]> {
    const result = await this.database
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM faq_index_jobs WHERE status = 'pending' `
          + 'ORDER BY updated_at ASC, id ASC LIMIT ?'
      )
      .bind(limit)
      .all<JobRow>();
    return result.results.map(toJob);
  }

  /**
   * Read every job, most recently changed first.
   *
   * @param limit Largest number of jobs to return.
   * @returns Jobs in any state.
   * @throws {Error} When D1 rejects the query.
   */
  public async listRecent(limit: number): Promise<FaqIndexJob[]> {
    const result = await this.database
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM faq_index_jobs ORDER BY updated_at DESC, id DESC LIMIT ?`
      )
      .bind(limit)
      .all<JobRow>();
    return result.results.map(toJob);
  }

  /**
   * Find the item identifier returned by the newest successful upload for an FAQ.
   *
   * @param faqId FAQ whose current search document should be removed.
   * @returns The opaque AI Search item identifier, or `null` when this FAQ has never indexed
   *   successfully.
   * @throws {Error} When D1 rejects the query.
   */
  public async findLatestDocumentId(faqId: string): Promise<string | null> {
    const row = await this.database
      .prepare(
        "SELECT search_document_id FROM faq_index_jobs WHERE faq_id = ? AND operation = 'upsert' "
          + "AND status = 'indexed' AND search_document_id IS NOT NULL "
          + 'ORDER BY updated_at DESC, id DESC LIMIT 1'
      )
      .bind(faqId)
      .first<{ search_document_id: string }>();
    return row?.search_document_id ?? null;
  }

  /**
   * Record a successful attempt.
   *
   * @param id Job identifier.
   * @param searchDocumentId Identifier of the resulting document, or `null` after a deletion.
   * @returns A promise fulfilled once the job is marked `indexed`.
   * @throws {Error} When D1 rejects the update.
   */
  public async markIndexed(id: string, searchDocumentId: string | null): Promise<void> {
    await this.database
      .prepare(
        "UPDATE faq_index_jobs SET status = 'indexed', search_document_id = ?, last_error = NULL, "
          + 'updated_at = ? WHERE id = ?'
      )
      .bind(searchDocumentId, new Date().toISOString(), id)
      .run();
  }

  /**
   * Record a failed attempt, incrementing the attempt count.
   *
   * The new status is computed from the incremented count by the domain rather than by SQL, so the
   * retry budget is stated once and the adapter cannot disagree with it.
   *
   * @param id Job identifier.
   * @param message Short, content-free failure description.
   * @returns The job as stored after the failure.
   * @throws {Error} When D1 rejects the read or update, or when the job disappeared mid-run.
   */
  public async markAttemptFailed(id: string, message: string): Promise<FaqIndexJob> {
    const current = await this.database
      .prepare(`SELECT ${JOB_COLUMNS} FROM faq_index_jobs WHERE id = ?`)
      .bind(id)
      .first<JobRow>();
    throwIfNull(current, 'A failing index job must still exist when its attempt is recorded');

    const attempts = current.attempts + 1;
    const status = statusAfterFailure(attempts);
    const updatedAt = new Date().toISOString();
    await this.database
      .prepare(
        'UPDATE faq_index_jobs SET status = ?, attempts = ?, last_error = ?, updated_at = ? '
          + 'WHERE id = ?'
      )
      .bind(status, attempts, message, updatedAt, id)
      .run();
    return { ...toJob(current), attempts, status, lastError: message, updatedAt };
  }
}
