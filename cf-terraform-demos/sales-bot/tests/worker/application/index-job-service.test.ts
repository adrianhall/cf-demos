import { describe, expect, it } from 'vitest';
import { IndexJobService, documentIdFor } from '../../../src/worker/application/index-job-service';
import type { Faq } from '../../../src/worker/domain/faq';
import {
  MemoryAuditRepository,
  MemoryFaqRepository,
  MemoryIndexJobRepository,
  MemorySearchIndex
} from '../support/fake-repositories';

/**
 * Store a revision ready for an index-job test.
 *
 * @param repository FAQ repository to write through.
 * @returns The stored FAQ.
 */
async function storeFaq(repository: MemoryFaqRepository): Promise<Faq> {
  const faq: Faq = {
    id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    revision: 1,
    question: 'What is D1?',
    answer: 'A SQL database.',
    productId: 'd1',
    ownerIdentityKey: 'pm-key',
    audience: 'internal',
    expiresAt: null,
    status: 'active',
    sourceEscalationId: null,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z'
  };
  await repository.insert(faq);
  return faq;
}

/**
 * Build the service and expose its dependencies for assertions.
 *
 * @returns The service and the in-memory ports it writes through.
 */
function buildService(): {
  service: IndexJobService;
  faqs: MemoryFaqRepository;
  jobs: MemoryIndexJobRepository;
  index: MemorySearchIndex;
  audit: MemoryAuditRepository;
} {
  const faqs = new MemoryFaqRepository();
  const jobs = new MemoryIndexJobRepository();
  const index = new MemorySearchIndex();
  const audit = new MemoryAuditRepository();
  return { service: new IndexJobService(jobs, faqs, index, audit), faqs, jobs, index, audit };
}

describe('IndexJobService', () => {
  it('indexes a pending FAQ revision', async () => {
    const { service, faqs, jobs, index } = buildService();
    const faq = await storeFaq(faqs);
    await jobs.enqueue(faq.id, faq.revision, 'upsert');
    await expect(service.runPending('run-1')).resolves.toEqual({
      indexed: 1,
      retrying: 0,
      failed: 0
    });
    expect(index.documents.get(documentIdFor(faq.id, faq.revision))).toMatchObject({
      faqId: faq.id,
      content: 'What is D1?\n\nA SQL database.'
    });
    expect(jobs.jobs[0]).toMatchObject({ status: 'indexed', attempts: 0 });
  });

  it('retries a transient indexing failure', async () => {
    const { service, faqs, jobs, index } = buildService();
    const faq = await storeFaq(faqs);
    await jobs.enqueue(faq.id, faq.revision, 'upsert');
    index.failUpserts = 1;
    await expect(service.runPending('run-1')).resolves.toEqual({
      indexed: 0,
      retrying: 1,
      failed: 0
    });
    expect(jobs.jobs[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'Simulated index outage'
    });
    await expect(service.runPending('run-2')).resolves.toEqual({
      indexed: 1,
      retrying: 0,
      failed: 0
    });
    expect(jobs.jobs[0]).toMatchObject({ status: 'indexed', attempts: 1 });
  });

  it('parks a job after the retry budget and records an audit event', async () => {
    const { service, faqs, jobs, index, audit } = buildService();
    const faq = await storeFaq(faqs);
    await jobs.enqueue(faq.id, faq.revision, 'upsert');
    index.failUpserts = 3;
    await service.runPending('run-1');
    await service.runPending('run-2');
    await expect(service.runPending('run-3')).resolves.toEqual({
      indexed: 0,
      retrying: 0,
      failed: 1
    });
    expect(jobs.jobs[0]).toMatchObject({ status: 'failed', attempts: 3 });
    expect(audit.events).toMatchObject([
      { action: 'documentation.index_failed', resource: `faq:${faq.id}` }
    ]);
  });

  it('does not duplicate a job when enqueue is repeated', async () => {
    const { faqs, jobs } = buildService();
    const faq = await storeFaq(faqs);
    const first = await jobs.enqueue(faq.id, faq.revision, 'upsert');
    const second = await jobs.enqueue(faq.id, faq.revision, 'upsert');
    expect(second.id).toBe(first.id);
    expect(jobs.jobs).toHaveLength(1);
  });

  it('treats a stale upsert job as complete instead of retrying forever', async () => {
    const { service, faqs, jobs } = buildService();
    const faq = await storeFaq(faqs);
    await jobs.enqueue(faq.id, faq.revision, 'upsert');
    await faqs.insertRevision({ ...faq, revision: 2, answer: 'New answer.' });
    await expect(service.runPending('run-1')).resolves.toEqual({
      indexed: 1,
      retrying: 0,
      failed: 0
    });
    expect(jobs.jobs[0]).toMatchObject({ status: 'indexed' });
  });

  it('deletes an index document', async () => {
    const { service, jobs, index } = buildService();
    index.documents.set('item-1', {
      id: 'item-1',
      faqId: 'faq',
      revision: 1,
      productId: null,
      audience: 'internal',
      content: 'old'
    });
    const job = await jobs.enqueue('faq', 1, 'delete');
    job.searchDocumentId = 'item-1';
    await expect(service.runPending('run-1')).resolves.toEqual({
      indexed: 1,
      retrying: 0,
      failed: 0
    });
    expect(index.documents.has('item-1')).toBe(false);
  });

  it('uses a distinct logical document identifier per revision', () =>
    expect(documentIdFor('faq-id', 1)).not.toBe(documentIdFor('faq-id', 2)));
});
