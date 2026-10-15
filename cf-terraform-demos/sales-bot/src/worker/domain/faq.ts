import type { Audience } from './audience';

/**
 * Lifecycle state of an FAQ revision.
 *
 * `expired` is a materialized marker written by scheduled maintenance, not the authority on expiry:
 * retrieval compares `expiresAt` against the current time on every read, so an FAQ whose date has
 * passed is excluded even when the marker has not run yet. See {@link isFaqRetrievable}.
 */
export type FaqStatus = 'active' | 'expired' | 'archived';

/**
 * Days of validity given to a newly published FAQ when the author does not choose a date.
 *
 * Ninety days is the specification's default. A knowledge base about a fast-moving product is more
 * dangerous when it is confidently stale than when it is missing, so the safe default is an expiry
 * rather than none.
 */
export const DEFAULT_EXPIRY_DAYS = 90;

/**
 * One revision of an answer owned by a product team.
 *
 * An FAQ is identified by `(id, revision)`. Editing publishes a new revision rather than mutating
 * the stored one, so the audit trail and the index job history both refer to something immutable.
 */
export interface Faq {
  /**
   * Stable identifier shared by every revision of this FAQ.
   */
  id: string;
  /**
   * Monotonically increasing revision number, starting at 1.
   */
  revision: number;
  /**
   * Question as a salesperson would ask it.
   */
  question: string;
  /**
   * Approved answer text.
   */
  answer: string;
  /**
   * Product this FAQ belongs to, or `null` when it is not product-specific. A `null` product can
   * only be managed by an administrator, because no PM's scope covers it.
   */
  productId: string | null;
  /**
   * Verified identity key of the owning PM, or `null` for an administrator-owned entry.
   */
  ownerIdentityKey: string | null;
  /**
   * Audience classification checked on retrieval and again before delivery.
   */
  audience: Audience;
  /**
   * ISO-8601 instant after which this FAQ must not be retrieved, or `null` when the author
   * deliberately removed the expiry.
   */
  expiresAt: string | null;
  /**
   * Lifecycle state.
   */
  status: FaqStatus;
  /**
   * Escalation this answer was published from, or `null` when it was authored directly.
   */
  sourceEscalationId: string | null;
  /**
   * ISO-8601 instant the revision was created.
   */
  createdAt: string;
  /**
   * ISO-8601 instant the revision last changed.
   */
  updatedAt: string;
}

/**
 * Validated input for publishing a new FAQ.
 */
export interface CreateFaqInput {
  /**
   * Normalized question text.
   */
  question: string;
  /**
   * Normalized answer text.
   */
  answer: string;
  /**
   * Owning product, or `null` for a cross-product entry.
   */
  productId: string | null;
  /**
   * Audience classification.
   */
  audience: Audience;
  /**
   * Explicit expiry instant, or `null` when the author removed the expiry. Absent means "apply the
   * {@link DEFAULT_EXPIRY_DAYS} default", which is why this is an optional property holding a
   * nullable value rather than merely nullable.
   */
  expiresAt?: string | null;
}

/**
 * Validated set of mutable FAQ fields. At least one is always present.
 */
export interface UpdateFaqInput {
  /**
   * Replacement question text.
   */
  question?: string;
  /**
   * Replacement answer text.
   */
  answer?: string;
  /**
   * Replacement product, or `null` to make the FAQ cross-product.
   */
  productId?: string | null;
  /**
   * Replacement audience classification.
   */
  audience?: Audience;
  /**
   * Replacement expiry instant, or `null` to remove the expiry entirely.
   */
  expiresAt?: string | null;
  /**
   * Replacement lifecycle state. Only `active` and `archived` may be set by a caller; `expired` is
   * written by scheduled maintenance.
   */
  status?: Exclude<FaqStatus, 'expired'>;
}

/**
 * Filter applied when listing FAQs for a reader.
 */
export interface FaqQuery {
  /**
   * Audiences the reader is cleared to see, from {@link import('./audience').visibleAudiences}.
   */
  audiences: Audience[];
  /**
   * Restrict to one product, or omit for every product the reader may see.
   */
  productId?: string;
  /**
   * Include archived and expired revisions. Only a management view sets this; retrieval never does.
   */
  includeInactive?: boolean;
  /**
   * Instant used to evaluate expiry, so the caller and the repository agree on "now" within one
   * request.
   */
  now: string;
}

/**
 * Compute the default expiry for a newly published FAQ.
 *
 * @param now Instant the FAQ is published, as a `Date`.
 * @returns An ISO-8601 instant {@link DEFAULT_EXPIRY_DAYS} days later.
 */
export function defaultExpiry(now: Date): string {
  return new Date(now.getTime() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Answer whether an FAQ may be returned to a reader right now.
 *
 * This is the check the specification requires to run during retrieval "even if the scheduled
 * marker/index cleanup has not run": an FAQ whose `expiresAt` has passed is unusable regardless of
 * its stored `status`, and an archived FAQ is unusable regardless of its date.
 *
 * @param faq Revision read from D1.
 * @param now Instant to evaluate the expiry against.
 * @returns Whether the FAQ is active, unexpired, and therefore retrievable.
 */
export function isFaqRetrievable(faq: Pick<Faq, 'expiresAt' | 'status'>, now: Date): boolean {
  if (faq.status === 'archived' || faq.status === 'expired') {
    return false;
  }
  return faq.expiresAt === null || Date.parse(faq.expiresAt) > now.getTime();
}

/**
 * Persistence port for FAQ revisions, owned by the application tier.
 *
 * The port takes already-authorized input: every method here assumes the caller has checked who may
 * act. Authorization is an application decision (`../application/faq-service.ts`), never a
 * repository one, so no storage adapter can accidentally become the thing that grants access.
 */
export interface FaqRepository {
  /**
   * List the newest revision of each FAQ matching a reader's filter.
   *
   * @param query Audience, product, status, and expiry filter.
   * @returns Matching revisions, newest update first.
   * @throws {Error} When the underlying storage rejects the read.
   */
  list(query: FaqQuery): Promise<Faq[]>;

  /**
   * Read the newest revision of one FAQ, ignoring audience and expiry.
   *
   * Unfiltered on purpose: this is the management read, and a PM editing an expired FAQ must be
   * able to see it. The reader-facing filter lives in {@link FaqRepository.list}.
   *
   * @param id Stable FAQ identifier.
   * @returns The newest revision, or `null` when no FAQ has that identifier.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findLatest(id: string): Promise<Faq | null>;

  /**
   * Insert revision 1 of a new FAQ.
   *
   * @param faq Fully resolved revision, including its generated identifier and timestamps.
   * @returns A promise fulfilled once the revision is durable.
   * @throws {Error} When the underlying storage rejects the write, including when `(id, revision)`
   *   already exists.
   */
  insert(faq: Faq): Promise<void>;

  /**
   * Insert the next revision of an existing FAQ.
   *
   * @param faq Fully resolved revision whose `revision` is one greater than the stored newest.
   * @returns A promise fulfilled once the revision is durable.
   * @throws {Error} When the underlying storage rejects the write, which includes the uniqueness
   *   violation that two concurrent edits of the same revision produce.
   */
  insertRevision(faq: Faq): Promise<void>;

  /**
   * Mark every active revision whose expiry has passed as `expired`.
   *
   * @param now Instant to compare expiries against.
   * @returns Identifiers of the FAQs whose newest revision was marked, so the caller can queue
   *   index deletions for exactly those.
   * @throws {Error} When the underlying storage rejects the read or write.
   */
  markExpired(now: string): Promise<string[]>;
}
