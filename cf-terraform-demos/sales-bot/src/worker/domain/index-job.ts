/**
 * Whether a job publishes a revision to the search index or removes it.
 *
 * Deletion is a job rather than a direct call for the same reason publication is: removing an
 * archived or expired answer from the index has to survive the index being briefly unavailable, and
 * "the FAQ is gone from D1 but still searchable" is the failure that leaks restricted content.
 */
export type IndexOperation = 'upsert' | 'delete';

/**
 * Lifecycle of one index job.
 *
 * `failed` is terminal for the attempt budget, not for the FAQ: the administrator freshness view
 * exists precisely so a human can see that an answer is durable in D1 but absent from the index.
 */
export type IndexJobStatus = 'pending' | 'indexed' | 'failed';

/**
 * How many times an index job is attempted before it is parked as `failed`.
 *
 * Three: enough to ride out a transient upstream error, few enough that a genuinely broken job
 * surfaces in the freshness view within one maintenance cycle instead of retrying silently
 * forever.
 */
export const MAX_INDEX_ATTEMPTS = 3;

/**
 * One unit of index work for a single FAQ revision.
 *
 * Keyed by `(faqId, faqRevision, operation)` in storage. That uniqueness is what makes the whole
 * pipeline idempotent: replaying an upsert or deletion records one job rather than two, while the
 * two different operations can coexist when a previously published revision later expires or is
 * archived.
 */
export interface FaqIndexJob {
  /**
   * Generated job identifier.
   */
  id: string;
  /**
   * FAQ this job indexes.
   */
  faqId: string;
  /**
   * Exact revision this job indexes. A later revision gets its own job.
   */
  faqRevision: number;
  /**
   * Whether the revision is being published or removed.
   */
  operation: IndexOperation;
  /**
   * Identifier of the document in the search index, once one exists.
   */
  searchDocumentId: string | null;
  /**
   * Current lifecycle state.
   */
  status: IndexJobStatus;
  /**
   * Number of attempts made so far.
   */
  attempts: number;
  /**
   * Short, content-free description of the most recent failure, or `null`.
   */
  lastError: string | null;
  /**
   * ISO-8601 instant the job last changed.
   */
  updatedAt: string;
}

/**
 * Answer whether a failed attempt should be retried or parked.
 *
 * @param attempts Number of attempts made, including the one that just failed.
 * @returns Whether another attempt is permitted.
 */
export function canRetryIndexJob(attempts: number): boolean {
  return attempts < MAX_INDEX_ATTEMPTS;
}

/**
 * Status an index job takes after an attempt fails.
 *
 * @param attempts Number of attempts made, including the one that just failed.
 * @returns `pending` while retries remain, otherwise `failed`.
 */
export function statusAfterFailure(attempts: number): IndexJobStatus {
  return canRetryIndexJob(attempts) ? 'pending' : 'failed';
}

/**
 * Projection of an FAQ revision as it is stored in the search index.
 *
 * Only this shape crosses into the index. In particular the audience travels with the document so a
 * future retrieval can pre-filter, but the audience is still rechecked against D1 before anything
 * is delivered — the index is a convenience, never the authority on who may read what.
 */
export interface FaqIndexDocument {
  /**
   * Document identifier, stable per `(faqId, revision)`.
   */
  id: string;
  /**
   * FAQ identifier, so a retrieval can look the authoritative record back up in D1.
   */
  faqId: string;
  /**
   * Indexed revision.
   */
  revision: number;
  /**
   * Product slug, or `null` for a cross-product answer.
   */
  productId: string | null;
  /**
   * Audience classification, carried as metadata for pre-filtering only.
   */
  audience: string;
  /**
   * Indexable text: the question and answer of this revision.
   */
  content: string;
}

/**
 * Port for the search index that backs retrieval.
 *
 * This is the seam that keeps the knowledge base independent of how documents are actually indexed.
 * The application tier asks for a revision to be published or removed; only the adapter knows
 * whether that means an AI Search instance, and the Terraform that provisions it.
 *
 * Methods report failure by throwing, and the caller (`../application/index-job-service.ts`)
 * converts a throw into a recorded attempt. That is deliberate: an index failure must be durable
 * and visible, not swallowed, because the freshness view is how an administrator learns that a
 * published answer is not yet searchable.
 */
export interface SearchIndexPort {
  /**
   * Publish or replace one document.
   *
   * @param document Projection of the FAQ revision to index.
   * @returns The index's identifier for the stored document.
   * @throws {Error} When the index rejects or cannot accept the document.
   */
  upsert(document: FaqIndexDocument): Promise<string>;

  /**
   * Remove one document.
   *
   * Removing a document that is already absent succeeds. An adapter must treat that case as success
   * rather than an error, because a retried deletion would otherwise never reach `indexed` and
   * would park as `failed` for having done exactly what was asked.
   *
   * @param documentId Identifier previously returned by {@link SearchIndexPort.upsert}.
   * @returns A promise fulfilled once the document is absent from the index.
   * @throws {Error} When the index cannot be reached or refuses the deletion.
   */
  delete(documentId: string): Promise<void>;
}

/**
 * Persistence port for index jobs.
 */
export interface IndexJobRepository {
  /**
   * Record the intent to index or remove one revision, ignoring a duplicate.
   *
   * @param faqId FAQ the job belongs to.
   * @param faqRevision Revision to index or remove.
   * @param operation Whether to publish or remove the revision.
   * @returns The job for that revision, whether it was created now or already existed.
   * @throws {Error} When the underlying storage rejects the write.
   */
  enqueue(faqId: string, faqRevision: number, operation: IndexOperation): Promise<FaqIndexJob>;

  /**
   * Read jobs still waiting to run, oldest first.
   *
   * @param limit Largest number of jobs to claim in one pass.
   * @returns Pending jobs.
   * @throws {Error} When the underlying storage rejects the read.
   */
  listPending(limit: number): Promise<FaqIndexJob[]>;

  /**
   * Read every job, newest change first, for the administrator freshness view.
   *
   * @param limit Largest number of jobs to return.
   * @returns Jobs in any state.
   * @throws {Error} When the underlying storage rejects the read.
   */
  listRecent(limit: number): Promise<FaqIndexJob[]>;

  /**
   * Find the newest successful search-item identifier for an FAQ.
   *
   * A deletion job is a new operation and therefore has no identifier of its own yet. It resolves
   * the item published by the most recent successful upsert instead of guessing from an item key:
   * AI Search's Items API deletes by item ID, which is an opaque value returned from upload.
   *
   * @param faqId FAQ whose current search document should be removed.
   * @returns The item identifier, or `null` when no successful upload exists.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findLatestDocumentId(faqId: string): Promise<string | null>;

  /**
   * Record a successful attempt.
   *
   * @param id Job identifier.
   * @param searchDocumentId Identifier of the resulting document, or `null` after a deletion.
   * @returns A promise fulfilled once the job is marked `indexed`.
   * @throws {Error} When the underlying storage rejects the write.
   */
  markIndexed(id: string, searchDocumentId: string | null): Promise<void>;

  /**
   * Record a failed attempt, incrementing the attempt count.
   *
   * @param id Job identifier.
   * @param message Short, content-free failure description.
   * @returns The job as stored after the failure, so the caller can see whether it will be
   * retried.
   * @throws {Error} When the underlying storage rejects the write.
   */
  markAttemptFailed(id: string, message: string): Promise<FaqIndexJob>;
}
