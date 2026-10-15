import { isAudienceVisible } from '../../../src/worker/domain/audience';
import type {
  AuditEvent,
  AuditEventInput,
  AuditQuery,
  AuditRepository
} from '../../../src/worker/domain/audit';
import type {
  DocumentationRepository,
  DocumentationSource,
  ImportedPage
} from '../../../src/worker/domain/documentation';
import type { Faq, FaqQuery, FaqRepository } from '../../../src/worker/domain/faq';
import { isFaqRetrievable } from '../../../src/worker/domain/faq';
import {
  statusAfterFailure,
  type FaqIndexDocument,
  type FaqIndexJob,
  type IndexJobRepository,
  type IndexOperation,
  type SearchIndexPort
} from '../../../src/worker/domain/index-job';
import type { Product, ProductRepository } from '../../../src/worker/domain/product';

/**
 * @file In-memory implementations of every repository port, used by the application-tier unit
 *   tests. These are real implementations of the ports rather than mocks: they store values and
 *   apply the same visibility rules the D1 adapters do. That matters because the tests here are
 *   about business rules — who may edit what, when an expiry applies, whether a retry duplicates
 *   work — and a mock that only records calls would prove the service called a method, not that the
 *   rule held. The D1 adapters are proven separately, against a real migrated database, in
 *   `tests/integration/`.
 */

/**
 * In-memory {@link FaqRepository}, keyed by `(id, revision)` exactly as D1 is.
 */
export class MemoryFaqRepository implements FaqRepository {
  /**
   * Every stored revision, in insertion order.
   */
  public readonly revisions: Faq[] = [];

  /**
   * List the newest revision of each FAQ matching a reader's filter.
   *
   * @param query Audience, product, status, and expiry filter.
   * @returns Matching revisions, most recently updated first.
   */
  public list(query: FaqQuery): Promise<Faq[]> {
    const now = new Date(query.now);
    const latest = [...new Set(this.revisions.map((faq) => faq.id))]
      .map((id) => this.newest(id))
      .filter((faq): faq is Faq => faq !== null)
      .filter((faq) => query.audiences.includes(faq.audience))
      .filter((faq) => query.productId === undefined || faq.productId === query.productId)
      .filter((faq) => query.includeInactive === true || isFaqRetrievable(faq, now));
    return Promise.resolve(latest.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }

  /**
   * Read the newest revision of one FAQ.
   *
   * @param id Stable FAQ identifier.
   * @returns The newest revision, or `null`.
   */
  public findLatest(id: string): Promise<Faq | null> {
    return Promise.resolve(this.newest(id));
  }

  /**
   * Insert revision 1.
   *
   * @param faq Fully resolved revision.
   * @returns A promise fulfilled once stored.
   * @throws {Error} When `(id, revision)` already exists, as D1's primary key would.
   */
  public insert(faq: Faq): Promise<void> {
    return this.insertRevision(faq);
  }

  /**
   * Insert any revision, rejecting a duplicate.
   *
   * @param faq Fully resolved revision.
   * @returns A promise fulfilled once stored.
   * @throws {Error} When `(id, revision)` already exists.
   */
  public insertRevision(faq: Faq): Promise<void> {
    if (this.revisions.some((stored) => stored.id === faq.id && stored.revision === faq.revision)) {
      return Promise.reject(new Error('UNIQUE constraint failed: faqs.id, faqs.revision'));
    }
    this.revisions.push({ ...faq });
    return Promise.resolve();
  }

  /**
   * Mark every active, newest revision whose expiry has passed.
   *
   * @param now Instant to compare expiries against.
   * @returns Identifiers of the FAQs that were marked.
   */
  public markExpired(now: string): Promise<string[]> {
    const marked: string[] = [];
    for (const id of new Set(this.revisions.map((faq) => faq.id))) {
      const newest = this.newest(id);
      if (
        newest !== null
        && newest.status === 'active'
        && newest.expiresAt !== null
        && newest.expiresAt <= now
      ) {
        newest.status = 'expired';
        newest.updatedAt = now;
        marked.push(id);
      }
    }
    return Promise.resolve(marked);
  }

  /**
   * Find the highest-numbered stored revision of one FAQ.
   *
   * @param id Stable FAQ identifier.
   * @returns The newest revision, or `null`.
   */
  private newest(id: string): Faq | null {
    const matching = this.revisions.filter((faq) => faq.id === id);
    return matching.length === 0
      ? null
      : matching.reduce((best, faq) => (faq.revision > best.revision ? faq : best));
  }
}

/**
 * In-memory {@link IndexJobRepository} enforcing the same `(faqId, revision)` uniqueness D1 does.
 */
export class MemoryIndexJobRepository implements IndexJobRepository {
  /**
   * Every job, in creation order.
   */
  public readonly jobs: FaqIndexJob[] = [];

  /**
   * Record the intent to index or remove one revision, ignoring a duplicate.
   *
   * @param faqId FAQ the job belongs to.
   * @param faqRevision Revision to index or remove.
   * @param operation Whether to publish or remove the revision.
   * @returns The job, created now or pre-existing.
   */
  public enqueue(
    faqId: string,
    faqRevision: number,
    operation: IndexOperation
  ): Promise<FaqIndexJob> {
    const existing = this.jobs.find(
      (job) => job.faqId === faqId && job.faqRevision === faqRevision && job.operation === operation
    );
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    const job: FaqIndexJob = {
      id: `job-${this.jobs.length + 1}`,
      faqId,
      faqRevision,
      operation,
      searchDocumentId: null,
      status: 'pending',
      attempts: 0,
      lastError: null,
      updatedAt: new Date().toISOString()
    };
    this.jobs.push(job);
    return Promise.resolve(job);
  }

  /**
   * Read jobs still waiting to run.
   *
   * @param limit Largest number of jobs to claim.
   * @returns Pending jobs, oldest first.
   */
  public listPending(limit: number): Promise<FaqIndexJob[]> {
    return Promise.resolve(this.jobs.filter((job) => job.status === 'pending').slice(0, limit));
  }

  /**
   * Read every job.
   *
   * @param limit Largest number of jobs to return.
   * @returns Jobs in any state.
   */
  public listRecent(limit: number): Promise<FaqIndexJob[]> {
    return Promise.resolve(this.jobs.slice(0, limit));
  }

  /**
   * Find the newest successful upload for an FAQ.
   *
   * @param faqId FAQ identifier.
   * @returns The uploaded item identifier, or `null`.
   */
  public findLatestDocumentId(faqId: string): Promise<string | null> {
    const job = [...this.jobs]
      .reverse()
      .find(
        (candidate) =>
          candidate.faqId === faqId
          && candidate.operation === 'upsert'
          && candidate.status === 'indexed'
          && candidate.searchDocumentId !== null
      );
    return Promise.resolve(job?.searchDocumentId ?? null);
  }

  /**
   * Record a successful attempt.
   *
   * @param id Job identifier.
   * @param searchDocumentId Resulting document identifier, or `null`.
   * @returns A promise fulfilled once recorded.
   */
  public markIndexed(id: string, searchDocumentId: string | null): Promise<void> {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (job !== undefined) {
      job.status = 'indexed';
      job.searchDocumentId = searchDocumentId;
      job.lastError = null;
    }
    return Promise.resolve();
  }

  /**
   * Record a failed attempt.
   *
   * @param id Job identifier.
   * @param message Short failure description.
   * @returns The job as stored after the failure.
   * @throws {Error} When the job does not exist.
   */
  public markAttemptFailed(id: string, message: string): Promise<FaqIndexJob> {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (job === undefined) {
      return Promise.reject(new Error(`Unknown index job ${id}`));
    }
    job.attempts += 1;
    job.status = statusAfterFailure(job.attempts);
    job.lastError = message;
    return Promise.resolve(job);
  }
}

/**
 * In-memory {@link AuditRepository}.
 */
export class MemoryAuditRepository implements AuditRepository {
  /**
   * Every recorded entry, oldest first.
   */
  public readonly events: AuditEvent[] = [];

  /**
   * Append one entry.
   *
   * @param input Action to record.
   * @returns The stored entry.
   */
  public record(input: AuditEventInput): Promise<AuditEvent> {
    const event: AuditEvent = {
      ...input,
      id: `audit-${this.events.length + 1}`,
      createdAt: new Date().toISOString()
    };
    this.events.push(event);
    return Promise.resolve(event);
  }

  /**
   * Read recent entries, newest first.
   *
   * @param query Action/resource filter and result limit.
   * @returns Matching entries.
   */
  public list(query: AuditQuery): Promise<AuditEvent[]> {
    return Promise.resolve(
      [...this.events]
        .reverse()
        .filter((event) => query.action === undefined || event.action === query.action)
        .filter((event) => query.resource === undefined || event.resource === query.resource)
        .slice(0, query.limit)
    );
  }
}

/**
 * In-memory {@link ProductRepository}.
 */
export class MemoryProductRepository implements ProductRepository {
  /**
   * @param products Products in the map.
   * @param scopes Product slugs by identity key.
   */
  public constructor(
    private readonly products: Product[] = [],
    private readonly scopes: Record<string, string[]> = {}
  ) {}

  /**
   * List every product in the map.
   *
   * @param includeInactive Include retired products.
   * @returns Products ordered by display name.
   */
  public list(includeInactive: boolean): Promise<Product[]> {
    return Promise.resolve(
      this.products
        .filter((product) => includeInactive || product.active)
        .sort((a, b) => a.name.localeCompare(b.name))
    );
  }

  /**
   * Read one product.
   *
   * @param id Product slug.
   * @returns The product, or `null`.
   */
  public find(id: string): Promise<Product | null> {
    return Promise.resolve(this.products.find((product) => product.id === id) ?? null);
  }

  /**
   * List the product slugs an identity manages.
   *
   * @param identityKey Verified identity key.
   * @returns Slugs currently in scope.
   */
  public scopesFor(identityKey: string): Promise<string[]> {
    return Promise.resolve(this.scopes[identityKey] ?? []);
  }
}

/**
 * In-memory {@link DocumentationRepository}.
 */
export class MemoryDocumentationRepository implements DocumentationRepository {
  /**
   * Stored pages by manifest path.
   */
  public readonly pages = new Map<string, DocumentationSource>();

  /**
   * List approved pages.
   *
   * @param limit Largest number of pages to return.
   * @returns Pages ordered by path.
   */
  public list(limit: number): Promise<DocumentationSource[]> {
    return Promise.resolve(
      [...this.pages.values()].sort((a, b) => a.path.localeCompare(b.path)).slice(0, limit)
    );
  }

  /**
   * Read one page.
   *
   * @param path Manifest path.
   * @returns The stored page, or `null`.
   */
  public find(path: string): Promise<DocumentationSource | null> {
    return Promise.resolve(this.pages.get(path) ?? null);
  }

  /**
   * Insert or update one page, resetting its indexing state.
   *
   * @param page Freshly read page.
   * @param importedAt Import instant.
   * @returns The stored page.
   */
  public upsert(page: ImportedPage, importedAt: string): Promise<DocumentationSource> {
    const stored: DocumentationSource = {
      path: page.entry.path,
      productId: page.entry.productId,
      title: page.entry.title,
      contentHash: page.entry.contentHash,
      sourceRevision: page.sourceRevision,
      indexStatus: 'pending',
      attempts: 0,
      lastError: null,
      importedAt,
      indexedAt: null
    };
    this.pages.set(stored.path, stored);
    return Promise.resolve(stored);
  }

  /**
   * Record a successful index.
   *
   * @param path Manifest path.
   * @param indexedAt Index instant.
   * @returns A promise fulfilled once recorded.
   */
  public markIndexed(path: string, indexedAt: string): Promise<void> {
    const page = this.pages.get(path);
    if (page !== undefined) {
      this.pages.set(path, { ...page, indexStatus: 'indexed', lastError: null, indexedAt });
    }
    return Promise.resolve();
  }

  /**
   * Record a failed index.
   *
   * @param path Manifest path.
   * @param message Short failure description.
   * @returns A promise fulfilled once recorded.
   */
  public markFailed(path: string, message: string): Promise<void> {
    const page = this.pages.get(path);
    if (page !== undefined) {
      this.pages.set(path, {
        ...page,
        indexStatus: 'failed',
        attempts: page.attempts + 1,
        lastError: message
      });
    }
    return Promise.resolve();
  }
}

/**
 * In-memory {@link SearchIndexPort} that can be told to fail.
 */
export class MemorySearchIndex implements SearchIndexPort {
  /**
   * Documents currently indexed, by identifier.
   */
  public readonly documents = new Map<string, FaqIndexDocument>();

  /**
   * How many more upserts should fail before succeeding, used to exercise retries.
   */
  public failUpserts = 0;

  /**
   * Publish or replace one document.
   *
   * @param document Projection to index.
   * @returns The document identifier.
   * @throws {Error} While {@link MemorySearchIndex.failUpserts} is positive.
   */
  public upsert(document: FaqIndexDocument): Promise<string> {
    if (this.failUpserts > 0) {
      this.failUpserts -= 1;
      return Promise.reject(new Error('Simulated index outage'));
    }
    this.documents.set(document.id, document);
    return Promise.resolve(document.id);
  }

  /**
   * Remove one document.
   *
   * @param documentId Identifier to remove.
   * @returns A promise fulfilled once absent.
   */
  public delete(documentId: string): Promise<void> {
    this.documents.delete(documentId);
    return Promise.resolve();
  }
}

/**
 * Apply the reader-facing audience filter to a list of FAQs.
 *
 * Shared by assertions that check a reader cannot see restricted material.
 *
 * @param faqs FAQs returned by a service.
 * @param clearance Reader's clearance.
 * @returns Whether every returned FAQ is within the clearance.
 */
export function allWithinClearance(faqs: Faq[], clearance: Faq['audience']): boolean {
  return faqs.every((faq) => isAudienceVisible(clearance, faq.audience));
}
