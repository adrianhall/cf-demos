/**
 * @file CRM use cases through the public service interface, over in-memory ports.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  encodeCursor
} from '../../../src/data-worker/application/crm/crm-service.ts';
import {
  canonicalJson,
  IDEMPOTENCY_RETENTION_MS
} from '../../../src/data-worker/application/shared/mutations.ts';
import { contactDisplayName, likeContains } from '../../../src/data-worker/domain/crm/contacts.ts';
import type { ActorContext } from '../../../src/shared/data-service/contract.ts';
import { createFakeDataService, testRuntime } from '../../fakes/fake-data-service.ts';

/**
 * Build a fake with a sales user.
 *
 * @returns The service, store, runtime, and actor.
 */
function setup() {
  const runtime = testRuntime();
  const fake = createFakeDataService({ runtime });
  const userId = fake.store.addUser('sales@example.com', 'sales');
  const actor: ActorContext = {
    email: 'sales@example.com',
    userId,
    requestId: 'req-1',
    channel: 'api'
  };
  return { ...fake, runtime, actor };
}

/**
 * Minimal create-contact input.
 *
 * @param overrides Fields to set.
 * @returns The input.
 */
function contactInput(overrides: Record<string, unknown> = {}) {
  return {
    firstName: null,
    lastName: null,
    email: null,
    phone: null,
    jobTitle: null,
    companyId: null,
    companyName: null,
    ...overrides
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
): Promise<{ code: string; fields?: Record<string, string>; requestId: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; requestId: string };
  }
  throw new Error('expected failure');
}

describe('domain helpers', () => {
  it('names a company-only lead after its company', () => {
    expect(contactDisplayName('Ada', null, 'X')).toBe('Ada');
    expect(contactDisplayName(null, 'Lovelace', null)).toBe('Lovelace');
    expect(contactDisplayName(null, null, 'Engines')).toBe('Engines');
    expect(() => contactDisplayName(null, null, null)).toThrow();
  });

  it('escapes LIKE wildcards so they match literally', () => {
    expect(likeContains('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });

  it('round-trips cursors and rejects foreign ones', () => {
    const cursor = encodeCursor('zoë', 'id-1');
    expect(decodeCursor(cursor, 'r')).toEqual({ key: 'zoë', id: 'id-1' });
    expect(() => decodeCursor('bm90LWpzb24', 'r')).toThrow('The cursor is invalid.');
    expect(() => decodeCursor(encodeCursor('a', 'b').slice(0, 4), 'r')).toThrow();
    expect(() => decodeCursor(btoa('[1,2]'), 'r')).toThrow();
  });

  it('hashes canonical JSON independent of key order', () => {
    expect(canonicalJson({ b: 1, a: [true, null, { d: undefined, c: 'x' }] })).toBe(
      '{"a":[true,null,{"c":"x"}],"b":1}'
    );
  });
});

describe('createContact', () => {
  it('creates a company the first time and audits both records', async () => {
    const { service, store, actor } = setup();
    const contact = await service.crm.createContact(
      actor,
      contactInput({ firstName: 'Ada', companyName: 'Engines' }),
      { idempotencyKey: 'create-0001' }
    );
    expect(contact.company?.name).toBe('Engines');
    expect(contact.owner).toEqual({ id: actor.userId, displayName: 'sales' });
    expect(store.audit.map((event) => `${event.entityType}:${event.action}`)).toEqual([
      'company:created',
      'contact:created'
    ]);
  });

  it('attaches to an existing company by id, and rejects an unknown id as a field error', async () => {
    const { service, actor } = setup();
    const company = await service.crm.createCompany(
      actor,
      { name: 'Known', address: null, stockSymbol: null, companiesHouseUrl: null },
      { idempotencyKey: 'company-0001' }
    );
    const contact = await service.crm.createContact(
      actor,
      contactInput({ lastName: 'Smith', companyId: company.id }),
      { idempotencyKey: 'create-0002' }
    );
    expect(contact.company).toEqual({ id: company.id, name: 'Known' });
    const error = await failure(
      service.crm.createContact(
        actor,
        contactInput({ lastName: 'X', companyId: crypto.randomUUID() }),
        { idempotencyKey: 'create-0003' }
      )
    );
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: { companyId: 'The selected company does not exist.' },
      requestId: 'req-1'
    });
  });

  it('rejects invalid input with per-field messages before authorizing', async () => {
    const { service, actor } = setup();
    const error = await failure(
      service.crm.createContact(actor, contactInput({ email: 'nope', firstName: 'A' }), {
        idempotencyKey: 'create-0004'
      })
    );
    expect(error.fields).toHaveProperty('email');
    expect(
      (
        await failure(
          service.crm.createContact(actor, contactInput({ firstName: 'A' }), {
            idempotencyKey: 'x'
          })
        )
      ).code
    ).toBe('VALIDATION_FAILED');
    expect(
      (
        await failure(
          service.crm.createContact(actor, contactInput({ firstName: 'A' }), undefined as never)
        )
      ).code
    ).toBe('VALIDATION_FAILED');
  });

  it('treats an expired idempotency record as absent', async () => {
    const { service, actor, runtime, store } = setup();
    const first = await service.crm.createContact(actor, contactInput({ firstName: 'Old' }), {
      idempotencyKey: 'expire-0001'
    });
    runtime.set(
      new Date(Date.parse('2026-10-01T09:00:00.000Z') + IDEMPOTENCY_RETENTION_MS + 60_000)
    );
    // The stale record is ignored, so the retry is a new create; the store's own key check then
    // reports the clash, proving the replay lookup did not short-circuit it.
    const error = await failure(
      service.crm.createContact(actor, contactInput({ firstName: 'Old' }), {
        idempotencyKey: 'expire-0001'
      })
    );
    expect(error.code).toBe('CONFLICT');
    expect(store.contacts.has(first.id)).toBe(true);
  });
});

describe('reads', () => {
  it('lists, searches, and pages contacts by name', async () => {
    const { service, actor } = setup();
    for (const name of ['Charlie', 'alice', 'Bob']) {
      await service.crm.createContact(actor, contactInput({ firstName: name }), {
        idempotencyKey: `list-${name}-01`
      });
    }
    const first = await service.crm.listContacts(actor, { limit: 2 });
    expect(first.items.map((item) => item.displayName)).toEqual(['alice', 'Bob']);
    const second = await service.crm.listContacts(actor, {
      limit: 2,
      cursor: first.nextCursor ?? ''
    });
    expect(second).toMatchObject({ items: [{ displayName: 'Charlie' }], nextCursor: null });
    const search = await service.crm.listContacts(actor, { q: 'BO', limit: 10 });
    expect(search.items.map((item) => item.displayName)).toEqual(['Bob']);
    expect((await failure(service.crm.listContacts(actor, { limit: 500 }))).code).toBe(
      'VALIDATION_FAILED'
    );
  });

  it('applies the default page size when options are absent', async () => {
    const { service, actor } = setup();
    expect(await service.crm.listCompanies(actor, undefined as never)).toEqual({
      items: [],
      nextCursor: null
    });
  });

  it('reports missing companies and contacts', async () => {
    const { service, actor } = setup();
    expect((await failure(service.crm.getCompany(actor, crypto.randomUUID()))).code).toBe(
      'NOT_FOUND'
    );
    expect((await failure(service.crm.getContact(actor, crypto.randomUUID()))).code).toBe(
      'NOT_FOUND'
    );
  });
});

describe('updateCompany', () => {
  it('changes fields, bumps the version, and records which fields changed', async () => {
    const { service, actor, store } = setup();
    const company = await service.crm.createCompany(
      actor,
      { name: 'Acme', address: null, stockSymbol: null, companiesHouseUrl: null },
      { idempotencyKey: 'upd-create-1' }
    );
    const updated = await service.crm.updateCompany(
      actor,
      company.id,
      { name: 'Acme Ltd', stockSymbol: null },
      1,
      { idempotencyKey: 'upd-0001' }
    );
    expect(updated).toMatchObject({ name: 'Acme Ltd', version: 2 });
    expect(store.audit.at(-1)).toMatchObject({ action: 'updated' });
  });

  it('clears the primary contact', async () => {
    const { service, actor } = setup();
    const contact = await service.crm.createContact(
      actor,
      contactInput({ firstName: 'P', companyName: 'Clear Co' }),
      { idempotencyKey: 'clr-0001' }
    );
    const id = contact.company?.id ?? '';
    await service.crm.updateCompany(actor, id, { primaryContactId: contact.id }, 1, {
      idempotencyKey: 'clr-0002'
    });
    const cleared = await service.crm.updateCompany(actor, id, { primaryContactId: null }, 2, {
      idempotencyKey: 'clr-0003'
    });
    expect(cleared.primaryContact).toBeNull();
  });

  it('refuses a rename onto another company’s name', async () => {
    const { service, actor } = setup();
    await service.crm.createCompany(
      actor,
      { name: 'Taken', address: null, stockSymbol: null, companiesHouseUrl: null },
      { idempotencyKey: 'ren-0001' }
    );
    const other = await service.crm.createCompany(
      actor,
      { name: 'Other', address: null, stockSymbol: null, companiesHouseUrl: null },
      { idempotencyKey: 'ren-0002' }
    );
    expect(
      (
        await failure(
          service.crm.updateCompany(actor, other.id, { name: 'taken' }, 1, {
            idempotencyKey: 'ren-0003'
          })
        )
      ).code
    ).toBe('CONFLICT');
    // Renaming to a different case of its own name is allowed.
    expect(
      (
        await service.crm.updateCompany(actor, other.id, { name: 'OTHER' }, 1, {
          idempotencyKey: 'ren-0004'
        })
      ).name
    ).toBe('OTHER');
  });

  it('reports absent companies, stale versions, and a version lost at commit time', async () => {
    const { service, actor, store } = setup();
    expect(
      (
        await failure(
          service.crm.updateCompany(actor, crypto.randomUUID(), { address: 'x' }, 1, {
            idempotencyKey: 'abs-0001'
          })
        )
      ).code
    ).toBe('NOT_FOUND');
    const company = await service.crm.createCompany(
      actor,
      { name: 'Race', address: null, stockSymbol: null, companiesHouseUrl: null },
      { idempotencyKey: 'race-0001' }
    );
    expect(
      (
        await failure(
          service.crm.updateCompany(actor, company.id, { address: 'x' }, 0, {
            idempotencyKey: 'race-0002'
          })
        )
      ).code
    ).toBe('VALIDATION_FAILED');
    // Simulate a concurrent writer committing between the version read and our commit.
    const stored = store.companies.get(company.id);
    const original = store.companies.get.bind(store.companies);
    let reads = 0;
    store.companies.get = (key: string) => {
      const value = original(key);
      return value !== undefined && key === company.id && ++reads > 1
        ? { ...value, version: 7 }
        : value;
    };
    expect(
      (
        await failure(
          service.crm.updateCompany(actor, company.id, { address: 'x' }, 1, {
            idempotencyKey: 'race-0003'
          })
        )
      ).code
    ).toBe('VERSION_MISMATCH');
    store.companies.get = original;
    expect(store.companies.get(company.id)).toEqual(stored);
  });
});

describe('authorization', () => {
  it('denies writes to read-only users with the request id', async () => {
    const { service, store } = setup();
    const userId = store.addUser('reader@example.com', 'read-only');
    const reader: ActorContext = {
      email: 'reader@example.com',
      userId,
      requestId: 'req-ro',
      channel: 'api'
    };
    const error = await failure(
      service.crm.createCompany(
        reader,
        { name: 'No', address: null, stockSymbol: null, companiesHouseUrl: null },
        { idempotencyKey: 'deny-0001' }
      )
    );
    expect(error).toMatchObject({ code: 'FORBIDDEN', requestId: 'req-ro' });
    expect(store.companies.size).toBe(0);
  });
});
