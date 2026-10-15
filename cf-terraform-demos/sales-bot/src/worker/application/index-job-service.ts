import type { AuditRepository } from '../domain/audit';
import type { FaqRepository } from '../domain/faq';
import {
  canRetryIndexJob,
  type FaqIndexJob,
  type IndexJobRepository,
  type SearchIndexPort
} from '../domain/index-job';

/**
 * Outcome of one pass over the pending index jobs.
 */
export interface IndexRunSummary {
  /**
   * Jobs that completed successfully.
   */
  indexed: number;
  /**
   * Attempts that failed and will be retried.
   */
  retrying: number;
  /**
   * Attempts that failed and exhausted the attempt budget.
   */
  failed: number;
}

/**
 * How many pending jobs one maintenance pass claims.
 *
 * Bounded so a backlog is worked through over several runs rather than in one invocation that might
 * exceed a Worker's CPU budget and lose all of its progress.
 */
export const INDEX_BATCH_SIZE = 25;

/**
 * Reduce an arbitrary thrown value to a short, content-free failure description.
 *
 * Only the message is kept, truncated. An index error can carry an upstream payload, and this value
 * is persisted and shown in the administrator view — so it is bounded here rather than trusted to
 * be small, and the stack is dropped entirely.
 *
 * @param cause Value thrown by the search index adapter.
 * @returns A description at most 200 characters long.
 */
export function describeIndexFailure(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : 'Unknown indexing failure.';
  return message.slice(0, 200);
}

/**
 * Runs queued index work against the search index.
 *
 * The service never decides _that_ something should be indexed — {@link FaqService} does, when it
 * writes a revision. This is only the retryable executor, which is what lets an index outage be a
 * visible backlog rather than a lost publication.
 */
export class IndexJobService {
  /**
   * @param jobs Index-job persistence port.
   * @param faqs FAQ persistence port, read to build the document projection.
   * @param index Search index port.
   * @param audit Audit trail port.
   */
  public constructor(
    private readonly jobs: IndexJobRepository,
    private readonly faqs: FaqRepository,
    private readonly index: SearchIndexPort,
    private readonly audit: AuditRepository
  ) {}

  /**
   * Work through the pending jobs once.
   *
   * @param correlationId Correlation identifier for this maintenance run.
   * @param limit Largest number of jobs to claim. Defaults to {@link INDEX_BATCH_SIZE}.
   * @returns Counts of indexed, retrying, and permanently failed jobs.
   * @throws {Error} When the job repository itself cannot be read. A failure of one job against the
   *   index is recorded rather than thrown, so one bad document cannot stall the batch.
   */
  public async runPending(
    correlationId: string,
    limit: number = INDEX_BATCH_SIZE
  ): Promise<IndexRunSummary> {
    const summary: IndexRunSummary = { indexed: 0, retrying: 0, failed: 0 };
    for (const job of await this.jobs.listPending(limit)) {
      try {
        await this.runJob(job);
        summary.indexed += 1;
      } catch (cause: unknown) {
        const updated = await this.jobs.markAttemptFailed(job.id, describeIndexFailure(cause));
        if (canRetryIndexJob(updated.attempts)) {
          summary.retrying += 1;
        } else {
          summary.failed += 1;
          await this.audit.record({
            actorIdentityKey: null,
            action: 'documentation.index_failed',
            resource: `faq:${job.faqId}`,
            reason: 'index_attempts_exhausted',
            correlationId
          });
        }
      }
    }
    return summary;
  }

  /**
   * Execute one job against the index and record its success.
   *
   * A job whose FAQ revision has disappeared from D1 is treated as done rather than retried
   * forever: there is nothing left to index, and the only alternative — parking it as failed —
   * would fill the administrator's freshness view with work that can never succeed.
   *
   * @param job Job claimed from the queue.
   * @returns A promise fulfilled once the job is marked `indexed`.
   * @throws {Error} When the search index rejects the operation. The caller converts the throw into
   *   a recorded attempt.
   */
  private async runJob(job: FaqIndexJob): Promise<void> {
    if (job.operation === 'delete') {
      const documentId = job.searchDocumentId ?? (await this.jobs.findLatestDocumentId(job.faqId));
      if (documentId !== null) {
        await this.index.delete(documentId);
      }
      await this.jobs.markIndexed(job.id, null);
      return;
    }

    const faq = await this.faqs.findLatest(job.faqId);
    if (faq === null || faq.revision !== job.faqRevision) {
      await this.jobs.markIndexed(job.id, job.searchDocumentId);
      return;
    }

    const documentId = await this.index.upsert({
      id: documentIdFor(faq.id, faq.revision),
      faqId: faq.id,
      revision: faq.revision,
      productId: faq.productId,
      audience: faq.audience,
      content: `${faq.question}\n\n${faq.answer}`
    });
    await this.jobs.markIndexed(job.id, documentId);
  }

  /**
   * Read recent jobs for the administrator freshness view.
   *
   * @param limit Largest number of jobs to return.
   * @returns Jobs in any state, most recently changed first.
   * @throws {Error} When the repository rejects the read.
   */
  public async listRecent(limit: number): Promise<FaqIndexJob[]> {
    return this.jobs.listRecent(limit);
  }
}

/**
 * Build the stable logical identifier for one FAQ revision.
 *
 * This is an application-level key sent in the indexed document projection. The actual AI Search
 * Items API returns its own opaque item ID, which the job repository persists and a later deletion
 * resolves through {@link IndexJobRepository.findLatestDocumentId}; it must not be guessed from this
 * logical identifier.
 *
 * @param faqId FAQ identifier.
 * @param revision Revision number.
 * @returns The logical identifier used in the document projection.
 */
export function documentIdFor(faqId: string, revision: number): string {
  return `faq:${faqId}:${revision}`;
}
