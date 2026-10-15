import { describe, expect, it } from 'vitest';
import { FaqService, type FaqContext } from '../../../src/worker/application/faq-service';
import type { Faq } from '../../../src/worker/domain/faq';
import { actorOf } from '../support/actors';
import {
  allWithinClearance,
  MemoryAuditRepository,
  MemoryFaqRepository,
  MemoryIndexJobRepository
} from '../support/fake-repositories';

const NOW = new Date('2026-10-15T12:00:00.000Z');

/**
 * Build a request context for a service test.
 *
 * @param role Actor role.
 * @param overrides Actor fields to override.
 * @returns A context with a stable clock and correlation identifier.
 */
function context(role: 'salesperson' | 'pm' | 'administrator', overrides = {}): FaqContext {
  return { actor: actorOf(role, overrides), correlationId: 'test-correlation', now: NOW };
}

/**
 * Build the service and expose its in-memory dependencies for assertions.
 *
 * @returns The service and the persistence doubles it writes through.
 */
function buildService(): {
  service: FaqService;
  faqs: MemoryFaqRepository;
  jobs: MemoryIndexJobRepository;
  audit: MemoryAuditRepository;
} {
  const faqs = new MemoryFaqRepository();
  const jobs = new MemoryIndexJobRepository();
  const audit = new MemoryAuditRepository();
  return { service: new FaqService(faqs, jobs, audit), faqs, jobs, audit };
}

/**
 * Publish an FAQ as an in-scope PM.
 *
 * @param service Service under test.
 * @param productId Product to own.
 * @param body Extra body fields.
 * @returns The stored FAQ.
 */
async function publish(
  service: FaqService,
  productId: string,
  body: Record<string, unknown> = {}
): Promise<Faq> {
  return service.createFaq(context('pm', { productScopes: [productId] }), {
    question: 'What is D1?',
    answer: 'A SQL database.',
    productId,
    audience: 'internal',
    ...body
  });
}

describe('FaqService', () => {
  it('defaults a new FAQ to a 90-day expiry, queues it once, and audits publication', async () => {
    const { service, jobs, audit } = buildService();
    const faq = await publish(service, 'd1');
    expect(faq.expiresAt).toBe('2027-01-13T12:00:00.000Z');
    expect(jobs.jobs).toMatchObject([{ faqId: faq.id, faqRevision: 1, operation: 'upsert' }]);
    expect(audit.events).toMatchObject([{ action: 'faq.published', resource: `faq:${faq.id}` }]);
  });

  it('preserves an explicitly removed expiry', async () => {
    const { service } = buildService();
    await expect(publish(service, 'd1', { expiresAt: null })).resolves.toMatchObject({
      expiresAt: null
    });
  });

  it('requires PM ownership scope to create an FAQ', async () => {
    const { service } = buildService();
    await expect(
      service.createFaq(context('pm', { productScopes: ['stream'] }), {
        question: 'What is D1?',
        answer: 'A SQL database.',
        productId: 'd1',
        audience: 'internal'
      })
    ).rejects.toThrow('This product is not in your scope.');
  });

  it('allows an administrator override for a product outside every PM scope', async () => {
    const { service } = buildService();
    await expect(
      service.createFaq(context('administrator'), {
        question: 'What is Gadgets?',
        answer: 'An internal product.',
        productId: 'gadgets',
        audience: 'internal'
      })
    ).resolves.toMatchObject({ productId: 'gadgets' });
  });

  it('filters restricted FAQ audiences before returning them', async () => {
    const { service } = buildService();
    await publish(service, 'd1', { audience: 'internal' });
    await publish(service, 'd1', { audience: 'customer', question: 'Customer question' });
    const visible = await service.listFaqs(context('salesperson'));
    expect(visible.map((faq) => faq.question)).toEqual(['Customer question']);
    expect(allWithinClearance(visible, 'customer')).toBe(true);
  });

  it('excludes an expired active FAQ before index cleanup runs', async () => {
    const { service } = buildService();
    await publish(service, 'd1', { expiresAt: '2026-10-15T11:59:59.999Z' });
    await expect(service.listFaqs(context('pm', { productScopes: ['d1'] }))).resolves.toEqual([]);
  });

  it('makes an edit a new revision and queues old-document deletion', async () => {
    const { service, jobs, audit } = buildService();
    const original = await publish(service, 'd1');
    const revised = await service.updateFaq(context('pm', { productScopes: ['d1'] }), original.id, {
      answer: 'A strongly consistent SQL database.'
    });
    expect(revised.revision).toBe(2);
    expect(revised.answer).toBe('A strongly consistent SQL database.');
    expect(jobs.jobs).toMatchObject([
      { faqRevision: 1, operation: 'upsert' },
      { faqRevision: 2, operation: 'upsert' }
    ]);
    // Both jobs address the same stable search document, so the newer revision replaces the old
    // text instead of creating a duplicate.
    expect(jobs.jobs).toHaveLength(2);
    expect(audit.events.at(-1)).toMatchObject({ action: 'faq.revised' });
  });

  it('enforces revision uniqueness in the persistence port', async () => {
    const { faqs } = buildService();
    const original: Faq = {
      id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      revision: 1,
      question: 'Question',
      answer: 'Answer',
      productId: 'd1',
      ownerIdentityKey: 'pm-key',
      audience: 'internal',
      expiresAt: null,
      status: 'active',
      sourceEscalationId: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString()
    };
    await faqs.insert(original);
    await expect(faqs.insertRevision({ ...original, answer: 'Competing answer' })).rejects.toThrow(
      'UNIQUE constraint failed'
    );
  });

  it('allows a PM to revise their own FAQ after losing product scope', async () => {
    const { service } = buildService();
    const original = await publish(service, 'd1');
    await expect(
      service.updateFaq(context('pm'), original.id, { audience: 'nda' })
    ).resolves.toMatchObject({ audience: 'nda', revision: 2 });
  });

  it('archives rather than erasing an FAQ and audits the action', async () => {
    const { service, faqs, audit } = buildService();
    const original = await publish(service, 'd1');
    await service.deleteFaq(context('pm', { productScopes: ['d1'] }), original.id);
    await expect(faqs.findLatest(original.id)).resolves.toMatchObject({
      status: 'archived',
      revision: 2
    });
    await expect(service.listFaqs(context('pm', { productScopes: ['d1'] }))).resolves.toEqual([]);
    expect(audit.events.at(-1)).toMatchObject({ action: 'faq.deleted' });
  });

  it('marks expiry and queues index cleanup without relying on cleanup for retrieval safety', async () => {
    const { service, faqs, jobs, audit } = buildService();
    const original = await publish(service, 'd1', { expiresAt: '2026-10-15T11:59:59.999Z' });
    await expect(service.expireFaqs(NOW, 'maintenance')).resolves.toBe(1);
    await expect(faqs.findLatest(original.id)).resolves.toMatchObject({ status: 'expired' });
    expect(jobs.jobs).toMatchObject([
      { faqRevision: 1, operation: 'upsert' },
      { faqRevision: 1, operation: 'delete' }
    ]);
    expect(audit.events.at(-1)).toMatchObject({ action: 'faq.expired', actorIdentityKey: null });
  });
});
