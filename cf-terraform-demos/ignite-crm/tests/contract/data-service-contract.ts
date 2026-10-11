/**
 * @file The shared Data Worker contract suite. One suite, two implementations:
 *   `tests/contract/fake.test.ts` runs it against the in-memory fake and
 *   `tests/integration/data-worker/contract.test.ts` runs it against the real `DataEntrypoint` over
 *   a service binding and D1. If the fake drifts from the real service, one of the two runs fails,
 *   so Application Worker tests that rely on the fake stay honest.
 */

import { describe, expect, it } from 'vitest';
import type { ActorContext, DataService } from '../../src/shared/data-service/contract.ts';

/**
 * What a contract run needs from its harness.
 */
export interface ContractHarness {
  /**
   * The implementation under test.
   */
  readonly service: DataService;
  /**
   * Create an active user with one role.
   *
   * @param email E-mail.
   * @param role Role id.
   * @returns Once created.
   */
  readonly addUser: (email: string, role: string) => Promise<void>;
}

/**
 * Register the contract suite.
 *
 * @param name Implementation name for the describe block.
 * @param setup Builds a fresh harness (called once).
 */
export function dataServiceContractTests(
  name: string,
  setup: () => Promise<ContractHarness>
): void {
  describe(`DataService contract: ${name}`, () => {
    let harness: ContractHarness;
    let counter = 0;

    /**
     * Resolve an actor for a fresh request.
     *
     * @param email E-mail.
     * @returns The actor.
     */
    async function actor(email: string): Promise<ActorContext> {
      const requestId = `req-${++counter}`;
      const resolved = await harness.service.resolveActor(email, requestId);
      return { email: resolved.email, userId: resolved.userId, requestId, channel: 'api' };
    }

    /**
     * Capture a rejection's code.
     *
     * @param promise The operation.
     * @returns The service error code.
     */
    async function codeOf(promise: Promise<unknown>): Promise<string> {
      try {
        await promise;
      } catch (error) {
        return (error as { code: string }).code;
      }
      throw new Error('expected the operation to fail');
    }

    it('sets up', async () => {
      harness = await setup();
      await harness.addUser('contract-sales@example.com', 'sales');
      await harness.addUser('contract-reader@example.com', 'read-only');
    });

    it('reports health', async () => {
      expect(await harness.service.health()).toMatchObject({ status: 'ok' });
    });

    it('resolves a known user and provisions an unknown one as read-only', async () => {
      const sales = await harness.service.resolveActor('Contract-Sales@Example.com', 'r1');
      expect(sales).toMatchObject({ email: 'contract-sales@example.com', status: 'active' });
      const fresh = await actor('contract-new@example.com');
      const session = await harness.service.permissions.getSession(fresh);
      expect(session.roles.map((role) => role.id)).toEqual(['read-only']);
    });

    it('rejects a malformed e-mail', async () => {
      expect(await codeOf(harness.service.resolveActor('not-an-email', 'r2'))).toBe(
        'VALIDATION_FAILED'
      );
    });

    it('answers authorization questions as values', async () => {
      const reader = await actor('contract-reader@example.com');
      expect(
        await harness.service.authorize({ userId: reader.userId, permission: 'crm.read' })
      ).toEqual({ allowed: true, reason: 'allowed' });
      expect(
        await harness.service.authorize({ userId: reader.userId, permission: 'crm.write' })
      ).toEqual({ allowed: false, reason: 'missing-permission' });
      expect(
        await harness.service.authorize({ userId: crypto.randomUUID(), permission: 'crm.read' })
      ).toEqual({ allowed: false, reason: 'inactive-user' });
    });

    it('resolves users by id and reports absent ones', async () => {
      const reader = await actor('contract-reader@example.com');
      expect(await harness.service.resolveUser(reader.userId)).toMatchObject({ status: 'active' });
      expect(await codeOf(harness.service.resolveUser(crypto.randomUUID()))).toBe('NOT_FOUND');
      expect(await codeOf(harness.service.resolveUser('NOT-A-UUID'))).toBe('VALIDATION_FAILED');
    });

    it('creates, lists, searches, and reads a contact with its company', async () => {
      const sales = await actor('contract-sales@example.com');
      const contact = await harness.service.crm.createContact(
        sales,
        {
          firstName: 'Contract',
          lastName: 'Person',
          email: null,
          phone: null,
          jobTitle: null,
          companyId: null,
          companyName: 'Contract Co'
        },
        { idempotencyKey: 'contract-create-1' }
      );
      expect(contact).toMatchObject({
        displayName: 'Contract Person',
        version: 1,
        company: { name: 'Contract Co' }
      });

      const page = await harness.service.crm.listContacts(sales, { q: 'contract p', limit: 10 });
      expect(page.items.map((item) => item.id)).toContain(contact.id);

      const detail = await harness.service.crm.getContact(sales, contact.id);
      expect(detail.contact.id).toBe(contact.id);
      expect(detail.history[0]?.action).toBe('created');

      const company = await harness.service.crm.getCompany(sales, contact.company?.id ?? '');
      expect(company.contacts.map((item) => item.id)).toEqual([contact.id]);
    });

    it('pages with an opaque cursor', async () => {
      const sales = await actor('contract-sales@example.com');
      for (const company of ['Page A', 'Page B', 'Page C']) {
        await harness.service.crm.createCompany(
          sales,
          { name: company, address: null, stockSymbol: null, companiesHouseUrl: null },
          { idempotencyKey: `contract-page-${company.replace(' ', '-')}` }
        );
      }
      const first = await harness.service.crm.listCompanies(sales, { q: 'page ', limit: 2 });
      expect(first.items.map((item) => item.name)).toEqual(['Page A', 'Page B']);
      expect(first.nextCursor).not.toBeNull();
      const second = await harness.service.crm.listCompanies(sales, {
        q: 'page ',
        limit: 2,
        cursor: first.nextCursor ?? ''
      });
      expect(second.items.map((item) => item.name)).toEqual(['Page C']);
      expect(second.nextCursor).toBeNull();
      expect(
        await codeOf(harness.service.crm.listCompanies(sales, { limit: 2, cursor: 'garbage' }))
      ).toBe('VALIDATION_FAILED');
    });

    it('denies writes to a read-only user', async () => {
      const reader = await actor('contract-reader@example.com');
      expect(
        await codeOf(
          harness.service.crm.createCompany(
            reader,
            { name: 'Denied', address: null, stockSymbol: null, companiesHouseUrl: null },
            { idempotencyKey: 'contract-denied' }
          )
        )
      ).toBe('FORBIDDEN');
    });

    it('reports missing records and rejects malformed ids', async () => {
      const sales = await actor('contract-sales@example.com');
      expect(await codeOf(harness.service.crm.getContact(sales, crypto.randomUUID()))).toBe(
        'NOT_FOUND'
      );
      expect(await codeOf(harness.service.crm.getCompany(sales, 'nope'))).toBe('VALIDATION_FAILED');
    });

    it('replays idempotent retries and rejects a reused key', async () => {
      const sales = await actor('contract-sales@example.com');
      const input = { name: 'Idem Ltd', address: null, stockSymbol: null, companiesHouseUrl: null };
      const first = await harness.service.crm.createCompany(sales, input, {
        idempotencyKey: 'contract-idem'
      });
      const again = await harness.service.crm.createCompany(
        await actor('contract-sales@example.com'),
        input,
        { idempotencyKey: 'contract-idem' }
      );
      expect(again).toEqual(first);
      expect(
        await codeOf(
          harness.service.crm.createCompany(
            sales,
            { ...input, name: 'Other Ltd' },
            { idempotencyKey: 'contract-idem' }
          )
        )
      ).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('rejects a duplicate company name as a conflict', async () => {
      const sales = await actor('contract-sales@example.com');
      expect(
        await codeOf(
          harness.service.crm.createCompany(
            sales,
            { name: 'IDEM LTD', address: null, stockSymbol: null, companiesHouseUrl: null },
            { idempotencyKey: 'contract-dup' }
          )
        )
      ).toBe('CONFLICT');
    });

    it('updates a company with optimistic versioning and replays a lost-response retry', async () => {
      const sales = await actor('contract-sales@example.com');
      const company = await harness.service.crm.createCompany(
        sales,
        { name: 'Versioned', address: null, stockSymbol: null, companiesHouseUrl: null },
        { idempotencyKey: 'contract-v-create' }
      );
      const updated = await harness.service.crm.updateCompany(
        sales,
        company.id,
        { address: 'Here' },
        1,
        { idempotencyKey: 'contract-v-1' }
      );
      expect(updated).toMatchObject({ version: 2, address: 'Here' });
      // Same key, same request, now-stale version: the original result is returned.
      expect(
        await harness.service.crm.updateCompany(sales, company.id, { address: 'Here' }, 1, {
          idempotencyKey: 'contract-v-1'
        })
      ).toEqual(updated);
      expect(
        await codeOf(
          harness.service.crm.updateCompany(sales, company.id, { address: 'There' }, 1, {
            idempotencyKey: 'contract-v-2'
          })
        )
      ).toBe('VERSION_MISMATCH');
    });

    it('sets a primary contact only from the company’s own contacts', async () => {
      const sales = await actor('contract-sales@example.com');
      const contact = await harness.service.crm.createContact(
        sales,
        {
          firstName: 'Primary',
          lastName: null,
          email: null,
          phone: null,
          jobTitle: null,
          companyId: null,
          companyName: 'Primary Co'
        },
        { idempotencyKey: 'contract-p-contact' }
      );
      const outsider = await harness.service.crm.createContact(
        sales,
        {
          firstName: 'Outsider',
          lastName: null,
          email: null,
          phone: null,
          jobTitle: null,
          companyId: null,
          companyName: null
        },
        { idempotencyKey: 'contract-p-outsider' }
      );
      const companyId = contact.company?.id ?? '';
      const updated = await harness.service.crm.updateCompany(
        sales,
        companyId,
        { primaryContactId: contact.id },
        1,
        { idempotencyKey: 'contract-p-1' }
      );
      expect(updated.primaryContact).toEqual({ id: contact.id, displayName: 'Primary' });
      expect(
        await codeOf(
          harness.service.crm.updateCompany(
            sales,
            companyId,
            { primaryContactId: outsider.id },
            2,
            { idempotencyKey: 'contract-p-2' }
          )
        )
      ).toBe('VALIDATION_FAILED');
    });

    it('reports dashboard counts', async () => {
      const reader = await actor('contract-reader@example.com');
      const dashboard = await harness.service.crm.dashboard(reader);
      expect(dashboard.contacts).toBeGreaterThanOrEqual(2);
      expect(dashboard.recentContacts.length).toBeLessThanOrEqual(5);
    });
  });
}
