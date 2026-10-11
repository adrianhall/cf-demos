/**
 * @file Sales use cases through the public data-service interface, over the production repositories
 *   on in-memory SQLite. Happy and error paths for every main mutation: validation, authorization,
 *   absent records, version conflicts, idempotency, and dependency failure.
 */

import { describe, expect, it } from 'vitest';
import type { ActorContext, DataService } from '../../../src/shared/data-service/contract.ts';
import type { Role } from '../../../src/shared/permissions.ts';
import {
  createFakeDataService,
  type FakeStore,
  testRuntime
} from '../../fakes/fake-data-service.ts';

/**
 * The seeded pipeline's stage ids (migrations/data/0002_sales.sql).
 */
const STAGE = {
  lead: '10000000-0000-4000-8000-000000000011',
  qualified: '10000000-0000-4000-8000-000000000012',
  proposal: '10000000-0000-4000-8000-000000000013'
} as const;

/**
 * Today in the test runtime (09:00 UTC on 11 Oct 2026 is 10:00 in London).
 */
const NOW = new Date('2026-10-11T09:00:00.000Z');

/**
 * Everything a test needs.
 */
interface World {
  service: DataService;
  store: FakeStore;
  runtime: ReturnType<typeof testRuntime>;
  actor(role: Role): ActorContext;
  ids: { ada: string; grace: string; outsider: string; engines: string; other: string };
}

let keyCounter = 0;

/**
 * A fresh idempotency key.
 *
 * @returns Mutation metadata.
 */
function key(): { idempotencyKey: string } {
  return { idempotencyKey: `sales-key-${++keyCounter}` };
}

/**
 * A fake with one user per role, a company with two contacts, and an unrelated contact/company.
 *
 * @returns The world.
 */
async function world(): Promise<World> {
  const runtime = testRuntime(NOW);
  const { service, store } = createFakeDataService({ runtime });
  const actors = new Map<Role, ActorContext>();
  for (const role of ['owner', 'manager', 'sales', 'delivery', 'read-only'] as const) {
    const email = `${role}@example.com`;
    actors.set(role, {
      email,
      userId: store.addUser(email, role),
      requestId: `req-${role}`,
      channel: 'api'
    });
  }
  const sales = actors.get('sales')!;
  const contact = (firstName: string, companyName: string | null) =>
    service.crm.createContact(
      sales,
      {
        firstName,
        lastName: null,
        email: null,
        phone: null,
        jobTitle: null,
        companyId: null,
        companyName
      },
      key()
    );
  const ada = await contact('Ada', 'Engines');
  const grace = await contact('Grace', 'Engines');
  const outsider = await contact('Outsider', 'Other Co');
  return {
    service,
    store,
    runtime,
    actor: (role) => actors.get(role)!,
    ids: {
      ada: ada.id,
      grace: grace.id,
      outsider: outsider.id,
      engines: ada.company!.id,
      other: outsider.company!.id
    }
  };
}

/**
 * Capture a rejection.
 *
 * @param promise The operation.
 * @returns The error.
 */
async function failure(
  promise: Promise<unknown>
): Promise<{ code: string; fields?: Record<string, string>; retryable?: boolean }> {
  try {
    await promise;
  } catch (error) {
    return error as { code: string };
  }
  throw new Error('expected failure');
}

/**
 * Minimal create-deal input.
 *
 * @param contactId Primary contact.
 * @param overrides Fields to set.
 * @returns The input.
 */
function dealInput(contactId: string, overrides: Record<string, unknown> = {}) {
  return {
    title: 'Renewal',
    primaryContactId: contactId,
    amountMinor: 0,
    statusLine: null,
    nextActionText: null,
    nextActionDate: null,
    expectedCloseDate: null,
    ...overrides
  };
}

describe('pipeline', () => {
  it('exposes the seeded four-stage pipeline to any reader', async () => {
    const { service, actor } = await world();
    const pipeline = await service.crm.getPipeline(actor('read-only'));
    expect(pipeline.stages.map((stage) => stage.key)).toEqual([
      'lead',
      'qualified',
      'proposal',
      'negotiation'
    ]);
    const assignees = await service.crm.listAssignees(actor('read-only'));
    expect(assignees.map((user) => user.displayName)).toContain('sales');
  });

  it('fails closed when storage is unavailable', async () => {
    const { service, store, actor } = await world();
    store.failing = true;
    expect(await failure(service.crm.getPipeline(actor('sales')))).toMatchObject({
      code: 'DEPENDENCY_FAILURE',
      retryable: true
    });
  });

  it('reports an unconfigured pipeline as a dependency failure', async () => {
    const { service, store, actor } = await world();
    store.exec('PRAGMA foreign_keys = OFF');
    store.exec('DELETE FROM pipeline_stages');
    expect((await failure(service.crm.getPipeline(actor('sales')))).code).toBe(
      'DEPENDENCY_FAILURE'
    );
  });
});

describe('createDeal', () => {
  it('creates a pending deal at the first stage, under the contact’s company, owned by the caller', async () => {
    const { service, store, actor, ids } = await world();
    const deal = await service.crm.createDeal(
      actor('sales'),
      dealInput(ids.ada, {
        amountMinor: 1_250_000,
        statusLine: 'Waiting for contract sign',
        nextActionText: 'Send proposal',
        nextActionDate: '2026-10-12'
      }),
      key()
    );
    expect(deal).toMatchObject({
      status: 'pending',
      stage: { key: 'lead' },
      company: { id: ids.engines, name: 'Engines' },
      primaryContact: { id: ids.ada, displayName: 'Ada' },
      owner: { id: actor('sales').userId },
      amountMinor: 1_250_000,
      currency: 'GBP',
      closedAt: null,
      version: 1
    });
    expect(store.audit.at(-1)).toMatchObject({ entityType: 'deal', action: 'created' });
    expect((await service.crm.getDeal(actor('read-only'), deal.id)).deal).toEqual(deal);
  });

  it('allows an explicit company-less deal and an explicit stage', async () => {
    const { service, actor, ids } = await world();
    const deal = await service.crm.createDeal(
      actor('sales'),
      dealInput(ids.ada, { companyId: null, stageId: STAGE.proposal }),
      key()
    );
    expect(deal).toMatchObject({ company: null, stage: { key: 'proposal' } });
  });

  it('rejects invalid input, a past next action, half a next action, and unknown references', async () => {
    const { service, actor, ids } = await world();
    const sales = actor('sales');
    expect(
      (await failure(service.crm.createDeal(sales, dealInput(ids.ada, { amountMinor: -1 }), key())))
        .fields
    ).toHaveProperty('amountMinor');
    expect(
      (
        await failure(
          service.crm.createDeal(
            sales,
            dealInput(ids.ada, { nextActionText: 'x', nextActionDate: null }),
            key()
          )
        )
      ).fields
    ).toHaveProperty('nextActionDate');
    expect(
      (
        await failure(
          service.crm.createDeal(
            sales,
            dealInput(ids.ada, { nextActionText: 'x', nextActionDate: '2026-10-10' }),
            key()
          )
        )
      ).fields
    ).toEqual({ nextActionDate: 'The next action date cannot be in the past.' });
    expect(
      (await failure(service.crm.createDeal(sales, dealInput(crypto.randomUUID()), key()))).fields
    ).toHaveProperty('primaryContactId');
    expect(
      (
        await failure(
          service.crm.createDeal(sales, dealInput(ids.ada, { stageId: crypto.randomUUID() }), key())
        )
      ).fields
    ).toHaveProperty('stageId');
    expect(
      (
        await failure(
          service.crm.createDeal(
            sales,
            dealInput(ids.ada, { companyId: crypto.randomUUID() }),
            key()
          )
        )
      ).fields
    ).toHaveProperty('companyId');
    // The primary contact must work at the deal's company.
    expect(
      (
        await failure(
          service.crm.createDeal(sales, dealInput(ids.outsider, { companyId: ids.engines }), key())
        )
      ).fields
    ).toHaveProperty('primaryContactId');
    // A body cannot smuggle server-owned fields.
    expect(
      (
        await failure(
          service.crm.createDeal(sales, { ...dealInput(ids.ada), status: 'won' } as never, key())
        )
      ).code
    ).toBe('VALIDATION_FAILED');
  });

  it('denies read-only and delivery users, and reassignment without crm.assign', async () => {
    const { service, store, actor, ids } = await world();
    for (const role of ['read-only', 'delivery'] as const) {
      expect(
        (await failure(service.crm.createDeal(actor(role), dealInput(ids.ada), key()))).code
      ).toBe('FORBIDDEN');
    }
    expect(
      (
        await failure(
          service.crm.createDeal(
            actor('sales'),
            dealInput(ids.ada, { ownerId: actor('manager').userId }),
            key()
          )
        )
      ).code
    ).toBe('FORBIDDEN');
    expect(store.count('deals')).toBe(0);
    const assigned = await service.crm.createDeal(
      actor('manager'),
      dealInput(ids.ada, { ownerId: actor('sales').userId }),
      key()
    );
    expect(assigned.owner.id).toBe(actor('sales').userId);
    // A suspended or unknown owner is a field error.
    expect(
      (
        await failure(
          service.crm.createDeal(
            actor('manager'),
            dealInput(ids.ada, { ownerId: crypto.randomUUID() }),
            key()
          )
        )
      ).fields
    ).toHaveProperty('ownerId');
  });

  it('rejects a contact moved to another company between validation and commit', async () => {
    const { service, store, actor, ids } = await world();
    store.beforeNextCommit((db) => {
      db.prepare('UPDATE contacts SET company_id = ? WHERE id = ?').run(ids.other, ids.ada);
    });
    expect(
      (await failure(service.crm.createDeal(actor('sales'), dealInput(ids.ada), key()))).code
    ).toBe('NOT_FOUND');
    expect(store.count('deals')).toBe(0);
  });

  it('replays a retried key and rejects the same key with different input', async () => {
    const { service, store, actor, ids } = await world();
    const meta = key();
    const first = await service.crm.createDeal(actor('sales'), dealInput(ids.ada), meta);
    expect(await service.crm.createDeal(actor('sales'), dealInput(ids.ada), meta)).toEqual(first);
    expect(
      (
        await failure(
          service.crm.createDeal(actor('sales'), dealInput(ids.ada, { title: 'Other' }), meta)
        )
      ).code
    ).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(store.count('deals')).toBe(1);
  });

  it('rolls back when the primary contact is deleted between validation and commit', async () => {
    const { service, store, actor, ids } = await world();
    store.beforeNextCommit((db) => {
      db.prepare("UPDATE contacts SET deleted_at = '2026-10-11T09:00:00.000Z' WHERE id = ?").run(
        ids.ada
      );
    });
    expect(
      (await failure(service.crm.createDeal(actor('sales'), dealInput(ids.ada), key()))).code
    ).toBe('NOT_FOUND');
    expect(store.count('deals')).toBe(0);
    expect(store.count('audit_events', "entity_type = 'deal'")).toBe(0);
  });
});

describe('updateDeal', () => {
  /**
   * A world with one pending deal.
   *
   * @returns The world and deal.
   */
  async function withDeal() {
    const w = await world();
    const deal = await w.service.crm.createDeal(
      w.actor('sales'),
      dealInput(w.ids.ada, { nextActionText: 'Call', nextActionDate: '2026-10-12' }),
      key()
    );
    return { ...w, deal };
  }

  it('moves stage, edits fields, and bumps the version', async () => {
    const { service, actor, deal } = await withDeal();
    const updated = await service.crm.updateDeal(
      actor('sales'),
      deal.id,
      { stageId: STAGE.qualified, statusLine: 'Legal review', amountMinor: 500 },
      1,
      key()
    );
    expect(updated).toMatchObject({
      stage: { key: 'qualified' },
      statusLine: 'Legal review',
      amountMinor: 500,
      version: 2
    });
  });

  it('winning clears the next action and expected close date; reopening clears closedAt', async () => {
    const { service, store, actor, deal } = await withDeal();
    const won = await service.crm.updateDeal(actor('sales'), deal.id, { status: 'won' }, 1, key());
    expect(won).toMatchObject({
      status: 'won',
      nextActionText: null,
      nextActionDate: null,
      expectedCloseDate: null,
      closedAt: expect.stringMatching(/^2026-10-11T/u) as unknown
    });
    expect(store.audit.at(-1)?.action).toBe('won');
    const reopened = await service.crm.updateDeal(
      actor('sales'),
      deal.id,
      { status: 'pending' },
      2,
      key()
    );
    expect(reopened).toMatchObject({ status: 'pending', closedAt: null });
    expect(store.audit.at(-1)?.action).toBe('reopened');
  });

  it('rejects a next action on a closed deal and invalid stage/status values', async () => {
    const { service, actor, deal } = await withDeal();
    expect(
      (
        await failure(
          service.crm.updateDeal(
            actor('sales'),
            deal.id,
            { status: 'lost', nextActionText: 'Chase', nextActionDate: '2026-10-20' },
            1,
            key()
          )
        )
      ).fields
    ).toHaveProperty('nextActionText');
    await service.crm.updateDeal(actor('sales'), deal.id, { status: 'lost' }, 1, key());
    expect(
      (
        await failure(
          service.crm.updateDeal(
            actor('sales'),
            deal.id,
            { nextActionText: 'Chase', nextActionDate: '2026-10-20' },
            2,
            key()
          )
        )
      ).fields
    ).toHaveProperty('nextActionText');
    expect(
      (
        await failure(
          service.crm.updateDeal(actor('sales'), deal.id, { status: 'closed' } as never, 2, key())
        )
      ).code
    ).toBe('VALIDATION_FAILED');
    expect(
      (
        await failure(
          service.crm.updateDeal(
            actor('sales'),
            deal.id,
            { stageId: crypto.randomUUID() },
            2,
            key()
          )
        )
      ).fields
    ).toHaveProperty('stageId');
    expect(
      (await failure(service.crm.updateDeal(actor('sales'), deal.id, {}, 2, key()))).code
    ).toBe('VALIDATION_FAILED');
  });

  it('changes the primary contact independently of the company primary contact', async () => {
    const { service, actor, ids, deal } = await withDeal();
    await service.crm.updateCompany(
      actor('sales'),
      ids.engines,
      { primaryContactId: ids.ada },
      1,
      key()
    );
    const updated = await service.crm.updateDeal(
      actor('sales'),
      deal.id,
      { primaryContactId: ids.grace },
      1,
      key()
    );
    expect(updated.primaryContact.id).toBe(ids.grace);
    const company = await service.crm.getCompany(actor('sales'), ids.engines);
    expect(company.company.primaryContact?.id).toBe(ids.ada);
    // Moving to a contact at another company without changing the company is rejected.
    expect(
      (
        await failure(
          service.crm.updateDeal(
            actor('sales'),
            deal.id,
            { primaryContactId: ids.outsider },
            2,
            key()
          )
        )
      ).fields
    ).toHaveProperty('primaryContactId');
    // Changing both together is fine.
    const moved = await service.crm.updateDeal(
      actor('sales'),
      deal.id,
      { primaryContactId: ids.outsider, companyId: ids.other },
      2,
      key()
    );
    expect(moved.company?.id).toBe(ids.other);
  });

  it('reports absent deals, stale versions, and a lost-response retry', async () => {
    const { service, actor, deal } = await withDeal();
    expect(
      (
        await failure(
          service.crm.updateDeal(actor('sales'), crypto.randomUUID(), { title: 'x' }, 1, key())
        )
      ).code
    ).toBe('NOT_FOUND');
    const meta = key();
    const updated = await service.crm.updateDeal(
      actor('sales'),
      deal.id,
      { title: 'New' },
      1,
      meta
    );
    expect(
      await service.crm.updateDeal(actor('sales'), deal.id, { title: 'New' }, 1, meta)
    ).toEqual(updated);
    expect(
      (await failure(service.crm.updateDeal(actor('sales'), deal.id, { title: 'Newer' }, 1, key())))
        .code
    ).toBe('VERSION_MISMATCH');
  });

  it('detects a version lost at commit time and writes nothing', async () => {
    const { service, store, actor, deal } = await withDeal();
    store.beforeNextCommit((db) => {
      db.prepare("UPDATE deals SET version = 9, title = 'Theirs' WHERE id = ?").run(deal.id);
    });
    expect(
      (await failure(service.crm.updateDeal(actor('sales'), deal.id, { title: 'Ours' }, 1, key())))
        .code
    ).toBe('VERSION_MISMATCH');
    expect(store.count('deals', "title = 'Theirs'")).toBe(1);
  });

  it('requires crm.assign to reassign, and crm.write at all', async () => {
    const { service, actor, deal } = await withDeal();
    expect(
      (
        await failure(
          service.crm.updateDeal(
            actor('sales'),
            deal.id,
            { ownerId: actor('owner').userId },
            1,
            key()
          )
        )
      ).code
    ).toBe('FORBIDDEN');
    // Explicit ownership assignment, even to yourself, is a manager/owner action. Sales users
    // leave ownerId absent when editing their own deals.
    expect(
      (
        await failure(
          service.crm.updateDeal(
            actor('sales'),
            deal.id,
            { ownerId: actor('sales').userId },
            1,
            key()
          )
        )
      ).code
    ).toBe('FORBIDDEN');
    expect(
      (await failure(service.crm.updateDeal(actor('read-only'), deal.id, { title: 'x' }, 1, key())))
        .code
    ).toBe('FORBIDDEN');
    const reassigned = await service.crm.updateDeal(
      actor('manager'),
      deal.id,
      { ownerId: actor('owner').userId },
      1,
      key()
    );
    expect(reassigned.owner.id).toBe(actor('owner').userId);
  });
});

describe('listDeals', () => {
  it('searches by title, company, or contact; filters by status; pages by title', async () => {
    const { service, actor, ids } = await world();
    for (const title of ['Charlie deal', 'alpha deal', 'Bravo deal']) {
      await service.crm.createDeal(actor('sales'), dealInput(ids.ada, { title }), key());
    }
    await service.crm.createDeal(actor('sales'), dealInput(ids.outsider, { title: 'Zulu' }), key());
    const first = await service.crm.listDeals(actor('read-only'), { limit: 2 });
    expect(first.items.map((deal) => deal.title)).toEqual(['alpha deal', 'Bravo deal']);
    const second = await service.crm.listDeals(actor('read-only'), {
      limit: 2,
      cursor: first.nextCursor ?? ''
    });
    expect(second.items.map((deal) => deal.title)).toEqual(['Charlie deal', 'Zulu']);
    expect(second.nextCursor).toBeNull();
    expect(
      (await service.crm.listDeals(actor('sales'), { q: 'other co', limit: 10 })).items.map(
        (deal) => deal.title
      )
    ).toEqual(['Zulu']);
    expect(
      (await service.crm.listDeals(actor('sales'), { q: 'ada', limit: 10 })).items
    ).toHaveLength(3);
    expect(
      (await service.crm.listDeals(actor('sales'), { status: 'won', limit: 10 })).items
    ).toEqual([]);
    expect(await service.crm.listDeals(actor('sales'), undefined as never)).toMatchObject({
      nextCursor: null
    });
    expect(
      (await failure(service.crm.listDeals(actor('sales'), { status: 'open' as never, limit: 5 })))
        .code
    ).toBe('VALIDATION_FAILED');
  });

  it('reports a missing deal', async () => {
    const { service, actor } = await world();
    expect((await failure(service.crm.getDeal(actor('sales'), crypto.randomUUID()))).code).toBe(
      'NOT_FOUND'
    );
  });
});

describe('createActivity', () => {
  /**
   * Minimal create-activity input.
   *
   * @param contactIds Linked contacts.
   * @param overrides Fields to set.
   * @returns The input.
   */
  function activityInput(contactIds: string[], overrides: Record<string, unknown> = {}) {
    return {
      type: 'meeting' as const,
      subject: 'Renewal kickoff',
      summary: null,
      occurredAt: '2026-10-11T08:00:00.000Z',
      durationMinutes: 45,
      contactIds,
      companyId: null,
      dealId: null,
      ...overrides
    };
  }

  it('links one meeting to two people, their company, and a deal — visible from every context', async () => {
    const { service, store, actor, ids } = await world();
    const deal = await service.crm.createDeal(actor('sales'), dealInput(ids.ada), key());
    const activity = await service.crm.createActivity(
      actor('sales'),
      activityInput([ids.ada, ids.grace], { companyId: ids.engines, dealId: deal.id }),
      key()
    );
    expect(activity).toMatchObject({
      type: 'meeting',
      author: { id: actor('sales').userId },
      company: { id: ids.engines },
      deal: { id: deal.id, title: 'Renewal' }
    });
    expect(store.count('activities')).toBe(1);
    expect(store.count('activity_contacts')).toBe(2);
    const reader = actor('read-only');
    for (const contactId of [ids.ada, ids.grace]) {
      expect((await service.crm.getContact(reader, contactId)).activities.map((a) => a.id)).toEqual(
        [activity.id]
      );
    }
    expect((await service.crm.getCompany(reader, ids.engines)).activities.map((a) => a.id)).toEqual(
      [activity.id]
    );
    const detail = await service.crm.getDeal(reader, deal.id);
    expect(detail.activities[0]?.contacts.map((c) => c.displayName)).toEqual(['Ada', 'Grace']);
  });

  it('reaches the company through its contacts even when the company is not linked directly', async () => {
    const { service, actor, ids } = await world();
    const activity = await service.crm.createActivity(
      actor('sales'),
      activityInput([ids.grace]),
      key()
    );
    expect(
      (await service.crm.getCompany(actor('sales'), ids.engines)).activities.map((a) => a.id)
    ).toEqual([activity.id]);
    expect((await service.crm.getCompany(actor('sales'), ids.other)).activities).toEqual([]);
  });

  it('rejects a missing contact list, duplicates, future times, and invalid targets — writing nothing', async () => {
    const { service, store, actor, ids } = await world();
    const sales = actor('sales');
    const deal = await service.crm.createDeal(sales, dealInput(ids.outsider), key());
    const cases: Array<[Record<string, unknown>, string]> = [
      [activityInput([]), 'contactIds'],
      [activityInput([ids.ada, ids.ada]), 'contactIds'],
      [activityInput([ids.ada], { occurredAt: '2026-10-11T12:00:00.000Z' }), 'occurredAt'],
      [activityInput([ids.ada, crypto.randomUUID()]), 'contactIds'],
      [activityInput([ids.ada], { companyId: crypto.randomUUID() }), 'companyId'],
      [activityInput([ids.ada], { dealId: crypto.randomUUID() }), 'dealId'],
      // The deal belongs to Other Co, not Engines.
      [activityInput([ids.ada], { companyId: ids.engines, dealId: deal.id }), 'dealId']
    ];
    for (const [input, field] of cases) {
      const error = await failure(service.crm.createActivity(sales, input as never, key()));
      expect(error.code, field).toBe('VALIDATION_FAILED');
      expect(error.fields, field).toHaveProperty(field);
    }
    expect(store.count('activities')).toBe(0);
  });

  it('rolls back everything when a linked contact is deleted at commit time', async () => {
    const { service, store, actor, ids } = await world();
    store.beforeNextCommit((db) => {
      db.prepare("UPDATE contacts SET deleted_at = '2026-10-11T09:00:00.000Z' WHERE id = ?").run(
        ids.grace
      );
    });
    expect(
      (
        await failure(
          service.crm.createActivity(actor('sales'), activityInput([ids.ada, ids.grace]), key())
        )
      ).code
    ).toBe('NOT_FOUND');
    expect(store.count('activities')).toBe(0);
    expect(store.count('activity_contacts')).toBe(0);
    expect(store.count('audit_events', "entity_type = 'activity'")).toBe(0);
  });

  it('keeps a deleted contact on past activities as a tombstone', async () => {
    const { service, store, actor, ids } = await world();
    await service.crm.createActivity(actor('sales'), activityInput([ids.ada, ids.grace]), key());
    store.exec(
      "UPDATE contacts SET deleted_at = '2026-10-11T09:30:00.000Z' WHERE id = ?",
      ids.grace
    );
    const [activity] = (await service.crm.getContact(actor('sales'), ids.ada)).activities;
    expect(activity?.contacts).toEqual([
      { id: ids.ada, displayName: 'Ada', deleted: false },
      { id: ids.grace, displayName: 'Grace', deleted: true }
    ]);
  });

  it('denies read-only users and replays retries', async () => {
    const { service, store, actor, ids } = await world();
    expect(
      (
        await failure(
          service.crm.createActivity(actor('read-only'), activityInput([ids.ada]), key())
        )
      ).code
    ).toBe('FORBIDDEN');
    const meta = key();
    const first = await service.crm.createActivity(actor('sales'), activityInput([ids.ada]), meta);
    expect(
      await service.crm.createActivity(actor('sales'), activityInput([ids.ada]), meta)
    ).toEqual(first);
    expect(store.count('activities')).toBe(1);
  });
});

describe('contact next actions and the action stream', () => {
  it('sets, replaces, and completes one next action per contact with versioning', async () => {
    const { service, store, actor, ids } = await world();
    const sales = actor('sales');
    const set = await service.crm.setContactNextAction(
      sales,
      ids.ada,
      { text: 'Send pricing', dueDate: '2026-10-12' },
      null,
      key()
    );
    expect(set).toMatchObject({ text: 'Send pricing', version: 1, assignee: { id: sales.userId } });
    expect(
      (
        await failure(
          service.crm.setContactNextAction(
            sales,
            ids.ada,
            { text: 'Dup', dueDate: null },
            null,
            key()
          )
        )
      ).code
    ).toBe('VERSION_MISMATCH');
    const replaced = await service.crm.setContactNextAction(
      sales,
      ids.ada,
      { text: 'Call', dueDate: null },
      1,
      key()
    );
    expect(replaced).toMatchObject({ id: set.id, version: 2, dueDate: null });
    expect((await service.crm.getContact(sales, ids.ada)).nextAction?.text).toBe('Call');
    expect(
      (await failure(service.crm.completeContactNextAction(sales, ids.ada, 1, key()))).code
    ).toBe('VERSION_MISMATCH');
    await service.crm.completeContactNextAction(sales, ids.ada, 2, key());
    expect((await service.crm.getContact(sales, ids.ada)).nextAction).toBeNull();
    expect(
      (await failure(service.crm.completeContactNextAction(sales, ids.ada, 3, key()))).code
    ).toBe('NOT_FOUND');
    expect(store.count('follow_ups', "status = 'done'")).toBe(1);
  });

  it('rejects past dates, unknown contacts, and read-only users', async () => {
    const { service, actor, ids } = await world();
    expect(
      (
        await failure(
          service.crm.setContactNextAction(
            actor('sales'),
            ids.ada,
            { text: 'Late', dueDate: '2026-10-01' },
            null,
            key()
          )
        )
      ).fields
    ).toHaveProperty('dueDate');
    expect(
      (
        await failure(
          service.crm.setContactNextAction(
            actor('sales'),
            crypto.randomUUID(),
            { text: 'x', dueDate: null },
            null,
            key()
          )
        )
      ).code
    ).toBe('NOT_FOUND');
    expect(
      (
        await failure(
          service.crm.setContactNextAction(
            actor('read-only'),
            ids.ada,
            { text: 'x', dueDate: null },
            null,
            key()
          )
        )
      ).code
    ).toBe('FORBIDDEN');
    expect(
      (
        await failure(
          service.crm.completeContactNextAction(actor('sales'), crypto.randomUUID(), 1, key())
        )
      ).code
    ).toBe('NOT_FOUND');
  });

  it('a concurrent second insert is a conflict, not two open actions', async () => {
    const { service, store, actor, ids } = await world();
    store.beforeNextCommit((db) => {
      db.prepare(
        `INSERT INTO follow_ups (id, contact_id, assignee_id, text, due_date, status, version, created_at, updated_at)
         VALUES (?, ?, ?, 'Theirs', NULL, 'open', 1, 'x', 'x')`
      ).run(crypto.randomUUID(), ids.ada, actor('manager').userId);
    });
    expect(
      (
        await failure(
          service.crm.setContactNextAction(
            actor('sales'),
            ids.ada,
            { text: 'Ours', dueDate: null },
            null,
            key()
          )
        )
      ).code
    ).toBe('CONFLICT');
    expect(store.count('follow_ups', "status = 'open'")).toBe(1);
  });

  it('orders the actor’s contact and deal actions with urgencies, and excludes others’ and closed deals', async () => {
    const { service, runtime, actor, ids } = await world();
    const sales = actor('sales');
    await service.crm.setContactNextAction(
      sales,
      ids.grace,
      { text: 'ASAP call', dueDate: null },
      null,
      key()
    );
    await service.crm.setContactNextAction(
      sales,
      ids.ada,
      { text: 'Tomorrow', dueDate: '2026-10-12' },
      null,
      key()
    );
    const dueToday = await service.crm.createDeal(
      sales,
      dealInput(ids.ada, {
        title: 'Due today',
        nextActionText: 'Chase',
        nextActionDate: '2026-10-11'
      }),
      key()
    );
    const soonOverdue = await service.crm.createDeal(
      sales,
      dealInput(ids.ada, {
        title: 'Overdue soon',
        nextActionText: 'Sign',
        nextActionDate: '2026-10-11'
      }),
      key()
    );
    const closed = await service.crm.createDeal(
      sales,
      dealInput(ids.ada, { title: 'Closed', nextActionText: 'x', nextActionDate: '2026-10-11' }),
      key()
    );
    await service.crm.updateDeal(sales, closed.id, { status: 'won' }, 1, key());
    await service.crm.setContactNextAction(
      actor('manager'),
      ids.outsider,
      { text: 'Not mine', dueDate: null },
      null,
      key()
    );

    // Two days later, the deal actions are overdue and the contact action is due "today"+1.
    runtime.set(new Date('2026-10-12T09:00:00.000Z'));
    const stream = await service.crm.actionStream(sales);
    expect(stream.today).toBe('2026-10-12');
    expect(stream.items.map((item) => [item.kind, item.text, item.urgency])).toEqual([
      ['contact', 'ASAP call', 'asap'],
      ...[dueToday, soonOverdue]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((deal) => ['deal', deal.nextActionText, 'overdue']),
      ['contact', 'Tomorrow', 'today']
    ]);
    expect(stream.items[1]?.deal).not.toBeNull();
    expect(stream.items[0]?.company?.name).toBe('Engines');
    expect(
      (await service.crm.actionStream(actor('manager'))).items.map((item) => item.text)
    ).toEqual(['Not mine']);
  });

  it('honours the installation time zone for "today"', async () => {
    const { service, runtime, actor, ids } = await world();
    await service.crm.setContactNextAction(
      actor('sales'),
      ids.ada,
      { text: 'Midnight', dueDate: '2026-10-12' },
      null,
      key()
    );
    // 23:30 UTC on the 11th is 00:30 on the 12th in London.
    runtime.set(new Date('2026-10-11T23:30:00.000Z'));
    const stream = await service.crm.actionStream(actor('sales'));
    expect(stream).toMatchObject({ today: '2026-10-12', items: [{ urgency: 'today' }] });
  });
});

describe('pipelineSummary', () => {
  it('totals open deals by stage, including empty stages, plus won and lost', async () => {
    const { service, actor, ids } = await world();
    const sales = actor('sales');
    await service.crm.createDeal(sales, dealInput(ids.ada, { amountMinor: 100 }), key());
    await service.crm.createDeal(
      sales,
      dealInput(ids.ada, { amountMinor: 250, stageId: STAGE.proposal }),
      key()
    );
    const won = await service.crm.createDeal(
      sales,
      dealInput(ids.ada, { amountMinor: 1000 }),
      key()
    );
    await service.crm.updateDeal(sales, won.id, { status: 'won' }, 1, key());
    const summary = await service.crm.pipelineSummary(actor('read-only'));
    expect(summary.currency).toBe('GBP');
    expect(summary.stages.map((row) => [row.stage.key, row.count, row.amountMinor])).toEqual([
      ['lead', 1, 100],
      ['qualified', 0, 0],
      ['proposal', 1, 250],
      ['negotiation', 0, 0]
    ]);
    expect(summary.open).toEqual({ count: 2, amountMinor: 350 });
    expect(summary.won).toEqual({ count: 1, amountMinor: 1000 });
    expect(summary.lost).toEqual({ count: 0, amountMinor: 0 });
  });

  it('is empty for a new installation and denied without report.read', async () => {
    const { service, store, actor } = await world();
    const summary = await service.crm.pipelineSummary(actor('owner'));
    expect(summary.open).toEqual({ count: 0, amountMinor: 0 });
    store.exec(
      "DELETE FROM role_permissions WHERE role_id = 'read-only' AND permission = 'report.read'"
    );
    expect((await failure(service.crm.pipelineSummary(actor('read-only')))).code).toBe('FORBIDDEN');
  });
});
