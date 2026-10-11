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

    it('runs the sales loop: deal, next actions, multi-linked meeting, stream, report', async () => {
      const sales = await actor('contract-sales@example.com');
      const person = (firstName: string, key: string) =>
        harness.service.crm.createContact(
          sales,
          {
            firstName,
            lastName: null,
            email: null,
            phone: null,
            jobTitle: null,
            companyId: null,
            companyName: 'Sales Loop Co'
          },
          { idempotencyKey: key }
        );
      const first = await person('Loop One', 'contract-s-c1');
      const second = await person('Loop Two', 'contract-s-c2');
      const pipeline = await harness.service.crm.getPipeline(sales);
      expect(pipeline.stages).toHaveLength(4);

      // A next-action date far in the future keeps this suite independent of the real clock.
      const deal = await harness.service.crm.createDeal(
        sales,
        {
          title: 'Loop deal',
          primaryContactId: first.id,
          amountMinor: 4200,
          statusLine: null,
          nextActionText: 'Send proposal',
          nextActionDate: '2099-01-01',
          expectedCloseDate: null
        },
        { idempotencyKey: 'contract-s-deal' }
      );
      expect(deal).toMatchObject({ status: 'pending', company: { id: first.company?.id } });

      const meeting = await harness.service.crm.createActivity(
        sales,
        {
          type: 'meeting',
          subject: 'Loop meeting',
          summary: null,
          occurredAt: '2026-01-01T10:00:00.000Z',
          durationMinutes: null,
          contactIds: [first.id, second.id],
          companyId: first.company?.id ?? null,
          dealId: deal.id
        },
        { idempotencyKey: 'contract-s-activity' }
      );
      for (const contact of [first, second]) {
        const detail = await harness.service.crm.getContact(sales, contact.id);
        expect(detail.activities.map((item) => item.id)).toContain(meeting.id);
      }
      expect((await harness.service.crm.getDeal(sales, deal.id)).activities[0]?.id).toBe(
        meeting.id
      );
      expect(
        (await harness.service.crm.getCompany(sales, first.company?.id ?? '')).deals.map(
          (item) => item.id
        )
      ).toEqual([deal.id]);

      await harness.service.crm.setContactNextAction(
        sales,
        second.id,
        { text: 'Chase Loop Two', dueDate: null },
        null,
        { idempotencyKey: 'contract-s-next' }
      );
      const stream = await harness.service.crm.actionStream(sales);
      expect(stream.items.map((item) => [item.kind, item.text])).toEqual([
        ['contact', 'Chase Loop Two'],
        ['deal', 'Send proposal']
      ]);

      const won = await harness.service.crm.updateDeal(sales, deal.id, { status: 'won' }, 1, {
        idempotencyKey: 'contract-s-won'
      });
      expect(won).toMatchObject({ status: 'won', nextActionText: null, version: 2 });
      expect(
        await codeOf(
          harness.service.crm.updateDeal(sales, deal.id, { title: 'Stale' }, 1, {
            idempotencyKey: 'contract-s-stale'
          })
        )
      ).toBe('VERSION_MISMATCH');

      const report = await harness.service.crm.pipelineSummary(sales);
      expect(report.won.count).toBeGreaterThanOrEqual(1);
      expect(report.won.amountMinor).toBeGreaterThanOrEqual(4200);
    });

    it('denies sales writes to a read-only user and rejects an invalid activity atomically', async () => {
      const reader = await actor('contract-reader@example.com');
      const sales = await actor('contract-sales@example.com');
      const page = await harness.service.crm.listContacts(sales, { q: 'loop one', limit: 1 });
      const contactId = page.items[0]?.id ?? '';
      expect(
        await codeOf(
          harness.service.crm.createDeal(
            reader,
            {
              title: 'Denied',
              primaryContactId: contactId,
              amountMinor: 0,
              statusLine: null,
              nextActionText: null,
              nextActionDate: null,
              expectedCloseDate: null
            },
            { idempotencyKey: 'contract-s-denied' }
          )
        )
      ).toBe('FORBIDDEN');
      expect(
        await codeOf(
          harness.service.crm.createActivity(
            sales,
            {
              type: 'call',
              subject: 'Ghost',
              summary: null,
              occurredAt: '2026-01-01T10:00:00.000Z',
              durationMinutes: null,
              contactIds: [contactId, crypto.randomUUID()],
              companyId: null,
              dealId: null
            },
            { idempotencyKey: 'contract-s-ghost' }
          )
        )
      ).toBe('VALIDATION_FAILED');
      const detail = await harness.service.crm.getContact(sales, contactId);
      expect(detail.activities.some((item) => item.subject === 'Ghost')).toBe(false);
    });

    it('converts a won deal into one linked project atomically, then runs a task to done', async () => {
      const sales = await actor('contract-sales@example.com');
      const contact = await harness.service.crm.createContact(
        sales,
        {
          firstName: 'Convert',
          lastName: 'Me',
          email: null,
          phone: null,
          jobTitle: null,
          companyId: null,
          companyName: 'Conversion Co'
        },
        { idempotencyKey: 'contract-dl-contact' }
      );
      const deal = await harness.service.crm.createDeal(
        sales,
        {
          title: 'Conversion deal',
          primaryContactId: contact.id,
          amountMinor: 100,
          statusLine: null,
          nextActionText: null,
          nextActionDate: null,
          expectedCloseDate: null
        },
        { idempotencyKey: 'contract-dl-deal' }
      );
      // A pending deal is not convertible.
      expect(
        await codeOf(
          harness.service.projects.convertDeal(sales, deal.id, {}, 1, {
            idempotencyKey: 'contract-dl-early'
          })
        )
      ).toBe('CONFLICT');
      const won = await harness.service.crm.updateDeal(sales, deal.id, { status: 'won' }, 1, {
        idempotencyKey: 'contract-dl-won'
      });
      expect(
        await codeOf(
          harness.service.projects.convertDeal(sales, deal.id, {}, 1, {
            idempotencyKey: 'contract-dl-stale'
          })
        )
      ).toBe('VERSION_MISMATCH');
      const project = await harness.service.projects.convertDeal(sales, deal.id, {}, won.version, {
        idempotencyKey: 'contract-dl-convert'
      });
      expect(project).toMatchObject({
        sourceDeal: { id: deal.id },
        company: { id: contact.company?.id },
        primaryContact: { id: contact.id },
        status: 'active'
      });
      expect((await harness.service.crm.getDeal(sales, deal.id)).deal.project?.id).toBe(project.id);
      expect(
        await codeOf(
          harness.service.projects.convertDeal(sales, deal.id, {}, won.version + 1, {
            idempotencyKey: 'contract-dl-twice'
          })
        )
      ).toBe('CONFLICT');
      // A sales user may convert but not run delivery work; a delivery user may.
      expect(
        await codeOf(
          harness.service.projects.createTask(
            sales,
            project.id,
            {
              title: 'Nope',
              description: null,
              status: 'todo',
              priority: 'low',
              assigneeId: null,
              dueDate: null
            },
            { idempotencyKey: 'contract-dl-sales-task' }
          )
        )
      ).toBe('FORBIDDEN');
      await harness.addUser('contract-delivery@example.com', 'delivery');
      const delivery = await actor('contract-delivery@example.com');
      const task = await harness.service.projects.createTask(
        delivery,
        project.id,
        {
          title: 'Kickoff',
          description: null,
          status: 'todo',
          priority: 'high',
          assigneeId: delivery.userId,
          dueDate: null
        },
        { idempotencyKey: 'contract-dl-task' }
      );
      expect((await harness.service.projects.myWork(delivery)).items.map((t) => t.id)).toContain(
        task.id
      );
      const done = await harness.service.projects.updateTask(
        delivery,
        task.id,
        { status: 'done' },
        1,
        { idempotencyKey: 'contract-dl-done' }
      );
      expect(done.completedAt).not.toBeNull();
      const detail = await harness.service.projects.getProject(sales, project.id);
      expect(detail.project.taskCounts.done).toBe(1);
      expect((await harness.service.projects.myWork(delivery)).items).toEqual([]);
      expect(
        (await harness.service.crm.getCompany(sales, contact.company?.id ?? '')).projects.map(
          (item) => item.id
        )
      ).toEqual([project.id]);
    });

    it('creates one multi-linked note, finds it by search and from each record, and edits it', async () => {
      const sales = await actor('contract-sales@example.com');
      const reader = await actor('contract-reader@example.com');
      const contact = await harness.service.crm.createContact(
        sales,
        {
          firstName: 'Noted',
          lastName: 'Person',
          email: null,
          phone: null,
          jobTitle: null,
          companyId: null,
          companyName: 'Notes Co'
        },
        { idempotencyKey: 'contract-note-contact' }
      );
      const companyId = contact.company?.id ?? '';
      const links = [
        { type: 'contact' as const, id: contact.id },
        { type: 'company' as const, id: companyId }
      ];
      // No links, and a missing target, are refused before anything is written.
      expect(
        await codeOf(
          harness.service.notes.createNote(
            sales,
            { title: 'Empty', markdown: 'Body', links: [] },
            { idempotencyKey: 'contract-note-empty' }
          )
        )
      ).toBe('VALIDATION_FAILED');
      expect(
        await codeOf(
          harness.service.notes.createNote(
            sales,
            {
              title: 'Missing',
              markdown: 'Body',
              links: [{ type: 'deal', id: '00000000-0000-4000-8000-00000000fffe' }]
            },
            { idempotencyKey: 'contract-note-missing' }
          )
        )
      ).toBe('VALIDATION_FAILED');
      expect(
        await codeOf(
          harness.service.notes.createNote(
            reader,
            { title: 'Reader', markdown: 'Body', links },
            { idempotencyKey: 'contract-note-reader' }
          )
        )
      ).toBe('FORBIDDEN');

      const note = await harness.service.notes.createNote(
        sales,
        { title: 'Quarterly zephyr review', markdown: 'Discussed the **zephyr** rollout.', links },
        { idempotencyKey: 'contract-note-create' }
      );
      expect(note.links.map((link) => [link.type, link.available])).toEqual([
        ['contact', true],
        ['company', true]
      ]);
      for (const link of links) {
        const feed = await harness.service.notes.listNotes(reader, {
          linkType: link.type,
          linkId: link.id,
          limit: 10
        });
        expect(feed.items.map((item) => item.id)).toEqual([note.id]);
      }
      const hits = await harness.service.notes.searchNotes(reader, 'zeph');
      expect(hits.items.map((hit) => hit.note.id)).toEqual([note.id]);
      expect(hits.items[0]?.snippet.some((segment) => segment.match)).toBe(true);
      expect(await codeOf(harness.service.notes.searchNotes(reader, 'z'))).toBe(
        'VALIDATION_FAILED'
      );

      const updated = await harness.service.notes.updateNote(
        sales,
        note.id,
        { markdown: 'Now about the mistral rollout.', links: [links[0]!] },
        1,
        { idempotencyKey: 'contract-note-update' }
      );
      expect(updated).toMatchObject({ version: 2, links: [{ type: 'contact' }] });
      expect((await harness.service.notes.searchNotes(reader, 'mistral')).items).toHaveLength(1);
      expect(
        (await harness.service.notes.searchNotes(reader, 'zephyr rollout discussed')).items
      ).toHaveLength(0);
      expect(
        await codeOf(
          harness.service.notes.updateNote(sales, note.id, { title: 'Stale' }, 1, {
            idempotencyKey: 'contract-note-stale'
          })
        )
      ).toBe('VERSION_MISMATCH');
      const detail = await harness.service.notes.getNote(reader, note.id);
      expect(detail.history.map((entry) => entry.action)).toEqual(['updated', 'created']);
    });

    it('reports dashboard counts', async () => {
      const reader = await actor('contract-reader@example.com');
      const dashboard = await harness.service.crm.dashboard(reader);
      expect(dashboard.contacts).toBeGreaterThanOrEqual(2);
      expect(dashboard.recentContacts.length).toBeLessThanOrEqual(5);
    });
  });
}
