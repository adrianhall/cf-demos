import { notFound } from '@adrianhall/cloudflare-toolkit/errors';
import {
  isAdministrator,
  requireFaqEdit,
  requireProductManagement,
  type Actor
} from '../domain/actor';
import { isAudienceVisible, visibleAudiences } from '../domain/audience';
import type { AuditRepository } from '../domain/audit';
import { defaultExpiry, isFaqRetrievable, type Faq, type FaqRepository } from '../domain/faq';
import {
  validateCreateFaqInput,
  validateFaqId,
  validateUpdateFaqInput
} from '../domain/faq-validation';
import type { IndexJobRepository } from '../domain/index-job';

/**
 * Request-scoped values every write shares.
 */
export interface FaqContext {
  /**
   * Resolved authorization subject.
   */
  actor: Actor;
  /**
   * Correlation identifier shared with the structured logs for this request.
   */
  correlationId: string;
  /**
   * Instant the operation is evaluated at, so validation, expiry, and audit timestamps all agree
   * within one request.
   */
  now: Date;
}

/**
 * Business rules for the FAQ knowledge base.
 *
 * The service is where authorization, the expiry default, the audience filter, the revision
 * sequence, the audit trail, and index-job enqueueing meet. None of those live in a route or in a
 * repository: the routes stay a readable description of the API surface, and no storage adapter can
 * become the thing that decides who may read or write what.
 *
 * Two invariants are worth stating because they are easy to lose:
 *
 * 1. **Expiry is evaluated on read.** Nothing relies on the scheduled marker having run; see
 *    {@link isFaqRetrievable}. The marker exists to clean the index, not to enforce the rule.
 * 2. **Every write is durable before it is indexed.** The revision is inserted, then an index job is
 *    enqueued. Doing it the other way round would let a search result outlive a failed write.
 */
export class FaqService {
  /**
   * @param faqs FAQ persistence port.
   * @param indexJobs Index-job persistence port.
   * @param audit Audit trail port.
   */
  public constructor(
    private readonly faqs: FaqRepository,
    private readonly indexJobs: IndexJobRepository,
    private readonly audit: AuditRepository
  ) {}

  /**
   * List the FAQs a reader may see.
   *
   * Audience, product, active status, and expiry are all applied in the repository query, and the
   * expiry is checked again here against the request's `now`. The second check is not redundant:
   * the repository compares against a timestamp string, and this guards the boundary case where a
   * record expires between the query being built and its rows being read.
   *
   * @param context Actor, correlation identifier, and evaluation instant.
   * @param productId Restrict to one product, or omit for everything the reader may see.
   * @returns Visible, active, unexpired FAQs.
   * @throws {Error} When the repository rejects the read.
   */
  public async listFaqs(context: FaqContext, productId?: string): Promise<Faq[]> {
    const faqs = await this.faqs.list({
      audiences: visibleAudiences(context.actor.clearance),
      now: context.now.toISOString(),
      ...(productId === undefined ? {} : { productId })
    });
    return faqs.filter((faq) => isFaqRetrievable(faq, context.now));
  }

  /**
   * List every FAQ a manager may administer, including archived and expired revisions.
   *
   * A PM sees the entries they own or cover; an administrator sees all of them. The audience filter
   * still applies: management rights do not raise a clearance, so a PM who is not cleared for
   * internal material does not see internal FAQs even in their own product.
   *
   * @param context Actor, correlation identifier, and evaluation instant.
   * @returns Manageable FAQs in any lifecycle state.
   * @throws {Error} When the repository rejects the read.
   */
  public async listManageableFaqs(context: FaqContext): Promise<Faq[]> {
    const faqs = await this.faqs.list({
      audiences: visibleAudiences(context.actor.clearance),
      includeInactive: true,
      now: context.now.toISOString()
    });
    if (isAdministrator(context.actor)) {
      return faqs;
    }
    return faqs.filter(
      (faq) =>
        context.actor.identityKey === faq.ownerIdentityKey
        || (faq.productId !== null && context.actor.productScopes.includes(faq.productId))
    );
  }

  /**
   * Read one FAQ for a reader.
   *
   * @param context Actor, correlation identifier, and evaluation instant.
   * @param id Unvalidated identifier from the request path.
   * @returns The newest revision.
   * @throws {ProblemDetailsError} `notFound()` (404) when the identifier is malformed, no FAQ has
   *   it, the reader is not cleared for its audience, or it is archived or expired. All four
   *   produce the same response, so the endpoint cannot be used to discover that a restricted
   *   answer exists.
   * @throws {Error} When the repository rejects the read.
   */
  public async getFaq(context: FaqContext, id: string): Promise<Faq> {
    const faq = await this.faqs.findLatest(validateFaqId(id));
    if (
      faq === null
      || !isAudienceVisible(context.actor.clearance, faq.audience)
      || !isFaqRetrievable(faq, context.now)
    ) {
      throw notFound({ detail: 'FAQ not found.' });
    }
    return faq;
  }

  /**
   * Publish a new FAQ.
   *
   * @param context Actor, correlation identifier, and evaluation instant.
   * @param body Unvalidated JSON body from the request.
   * @returns The stored revision 1.
   * @throws {ProblemDetailsError} `badRequest()` (400) or `unprocessableContent()` (422) when the
   *   body is invalid; `forbidden()` (403) when the product is not in the actor's scope;
   *   `notFound()` (404) when the actor has no management role at all.
   * @throws {Error} When the repository rejects the write.
   */
  public async createFaq(context: FaqContext, body: unknown): Promise<Faq> {
    const input = validateCreateFaqInput(body);
    requireProductManagement(context.actor, input.productId);

    const timestamp = context.now.toISOString();
    const faq: Faq = {
      id: crypto.randomUUID(),
      revision: 1,
      question: input.question,
      answer: input.answer,
      productId: input.productId,
      ownerIdentityKey: context.actor.identityKey,
      audience: input.audience,
      // An absent `expiresAt` means "use the default"; an explicit `null` means the author
      // deliberately removed it. The distinction is the reason `CreateFaqInput.expiresAt` is an
      // optional property holding a nullable value.
      expiresAt: Object.hasOwn(input, 'expiresAt')
        ? (input.expiresAt ?? null)
        : defaultExpiry(context.now),
      status: 'active',
      sourceEscalationId: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    await this.faqs.insert(faq);
    await this.indexJobs.enqueue(faq.id, faq.revision, 'upsert');
    await this.audit.record({
      actorIdentityKey: context.actor.identityKey,
      action: 'faq.published',
      resource: `faq:${faq.id}`,
      reason: null,
      correlationId: context.correlationId
    });
    return faq;
  }

  /**
   * Publish a new revision of an existing FAQ.
   *
   * Editing never mutates a stored revision. The previous revision stays readable, its index job
   * history stays meaningful, and the new revision gets its own job — including a deletion job for
   * the old document when the edit archives the entry, so an archived answer stops being searchable
   * rather than merely stopping being listed.
   *
   * @param context Actor, correlation identifier, and evaluation instant.
   * @param id Unvalidated identifier from the request path.
   * @param body Unvalidated JSON body from the request.
   * @returns The newly stored revision.
   * @throws {ProblemDetailsError} `badRequest()` (400) or `unprocessableContent()` (422) when the
   *   body is invalid; `notFound()` (404) when the identifier is malformed or unknown;
   *   `forbidden()` (403) when the actor may manage knowledge but not this FAQ; `notFound()` (404)
   *   when the actor has no management role.
   * @throws {Error} When the repository rejects the read or write, including the uniqueness
   *   violation two concurrent edits of the same revision produce.
   */
  public async updateFaq(context: FaqContext, id: string, body: unknown): Promise<Faq> {
    const input = validateUpdateFaqInput(body);
    const existing = await this.faqs.findLatest(validateFaqId(id));
    if (existing === null) {
      throw notFound({ detail: 'FAQ not found.' });
    }
    requireFaqEdit(context.actor, existing);
    // Moving an FAQ into another product needs rights over the destination too, otherwise a PM
    // could reassign an entry into a product they do not cover and keep editing it there.
    if (input.productId !== undefined && input.productId !== existing.productId) {
      requireProductManagement(context.actor, input.productId);
    }

    const status = input.status ?? (existing.status === 'expired' ? 'active' : existing.status);
    const revision: Faq = {
      ...existing,
      revision: existing.revision + 1,
      question: input.question ?? existing.question,
      answer: input.answer ?? existing.answer,
      productId: input.productId === undefined ? existing.productId : input.productId,
      audience: input.audience ?? existing.audience,
      expiresAt: input.expiresAt === undefined ? existing.expiresAt : input.expiresAt,
      status,
      updatedAt: context.now.toISOString()
    };

    await this.faqs.insertRevision(revision);
    // One durable job exists per FAQ revision (the schema enforces that uniqueness). The search
    // document itself uses the stable FAQ id, so an upsert for this newer revision replaces the
    // old document; an archive queues deletion for *this* revision. We never enqueue a second
    // operation for the old revision, which would conflict with the idempotency constraint.
    await this.indexJobs.enqueue(
      revision.id,
      revision.revision,
      status === 'active' ? 'upsert' : 'delete'
    );
    await this.audit.record({
      actorIdentityKey: context.actor.identityKey,
      action: status === 'archived' ? 'faq.archived' : 'faq.revised',
      resource: `faq:${revision.id}`,
      reason: null,
      correlationId: context.correlationId
    });
    return revision;
  }

  /**
   * Archive an FAQ.
   *
   * Deliberately an archive rather than a row deletion. The specification requires that index
   * removal "cannot make D1 forget the FAQ lifecycle": the revision history and the audit trail
   * stay, a deletion job removes the search document, and retrieval stops returning it immediately
   * because `isFaqRetrievable` rejects an archived entry.
   *
   * @param context Actor, correlation identifier, and evaluation instant.
   * @param id Unvalidated identifier from the request path.
   * @returns A promise fulfilled once the archiving revision is durable and its index deletion is
   *   queued.
   * @throws {ProblemDetailsError} `notFound()` (404) when the identifier is malformed or unknown,
   *   or the actor has no management role; `forbidden()` (403) when the actor may manage knowledge
   *   but not this FAQ.
   * @throws {Error} When the repository rejects the read or write.
   */
  public async deleteFaq(context: FaqContext, id: string): Promise<void> {
    const existing = await this.faqs.findLatest(validateFaqId(id));
    if (existing === null) {
      throw notFound({ detail: 'FAQ not found.' });
    }
    requireFaqEdit(context.actor, existing);

    const archived: Faq = {
      ...existing,
      revision: existing.revision + 1,
      status: 'archived',
      updatedAt: context.now.toISOString()
    };
    await this.faqs.insertRevision(archived);
    await this.indexJobs.enqueue(archived.id, archived.revision, 'delete');
    await this.audit.record({
      actorIdentityKey: context.actor.identityKey,
      action: 'faq.deleted',
      resource: `faq:${existing.id}`,
      reason: null,
      correlationId: context.correlationId
    });
  }

  /**
   * Mark every FAQ whose expiry has passed and queue removal of its search documents.
   *
   * Run by scheduled maintenance, not by a request, so the actor is `null` in the audit trail.
   * Retrieval does not depend on this having run; it exists so the index does not keep serving
   * documents for answers that are no longer valid.
   *
   * @param now Instant to compare expiries against.
   * @param correlationId Correlation identifier for the maintenance run.
   * @returns The number of FAQs marked expired.
   * @throws {Error} When the repository rejects the read or write.
   */
  public async expireFaqs(now: Date, correlationId: string): Promise<number> {
    const expired = await this.faqs.markExpired(now.toISOString());
    for (const id of expired) {
      const faq = await this.faqs.findLatest(id);
      if (faq !== null) {
        await this.indexJobs.enqueue(faq.id, faq.revision, 'delete');
      }
      await this.audit.record({
        actorIdentityKey: null,
        action: 'faq.expired',
        resource: `faq:${id}`,
        reason: 'expiry_reached',
        correlationId
      });
    }
    return expired.length;
  }
}
