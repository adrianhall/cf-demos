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
    // The stale record is ignored and purged in the same write set, so the retry is a new create.
    const second = await service.crm.createContact(actor, contactInput({ firstName: 'Old' }), {
      idempotencyKey: 'expire-0001'
    });
    expect(second.id).not.toBe(first.id);
    expect(store.count('contacts', "first_name = 'Old'")).toBe(2);
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
    store.beforeNextCommit((db) => {
      db.prepare("UPDATE companies SET version = 7, address = 'theirs' WHERE id = ?").run(
        company.id
      );
    });
    expect(
      (
        await failure(
          service.crm.updateCompany(actor, company.id, { address: 'x' }, 1, {
            idempotencyKey: 'race-0003'
          })
        )
      ).code
    ).toBe('VERSION_MISMATCH');
    // Their change stands; ours (and its audit and idempotency rows) rolled back.
    expect(store.count('companies', "id = ? AND address = 'theirs'", company.id)).toBe(1);
    expect(store.count('idempotency_records', "idempotency_key = 'race-0003'")).toBe(0);
  });
});

describe('updateContact', () => {
  it('edits names and details, recomputes the display name, and audits the changed fields', async () => {
    const { service, actor, store } = setup();
    const contact = await service.crm.createContact(
      actor,
      contactInput({ firstName: 'Ada', email: 'ada@example.com', companyName: 'Engines' }),
      { idempotencyKey: 'uc-create-key-1' }
    );
    const updated = await service.crm.updateContact(
      actor,
      contact.id,
      { lastName: 'Lovelace', email: ' ADA@ENGINES.EXAMPLE ', phone: '', jobTitle: 'CTO' },
      1,
      { idempotencyKey: 'uc-key-0001' }
    );
    expect(updated).toMatchObject({
      displayName: 'Ada Lovelace',
      email: 'ada@engines.example',
      phone: null,
      jobTitle: 'CTO',
      company: contact.company,
      version: 2
    });
    expect((await service.crm.getContact(actor, contact.id)).contact).toEqual(updated);
    expect(store.audit.at(-1)).toMatchObject({ action: 'updated' });
    expect(store.count('contacts', "display_name = 'Ada Lovelace'")).toBe(1);
  });

  it('moves between companies by name, reusing or creating one, and detaches', async () => {
    const { service, actor, store } = setup();
    const ada = await service.crm.createContact(
      actor,
      contactInput({ firstName: 'Ada', companyName: 'Engines' }),
      { idempotencyKey: 'mv-key-0001' }
    );
    await service.crm.createCompany(
      actor,
      { name: 'Looms', address: null, stockSymbol: null, companiesHouseUrl: null },
      { idempotencyKey: 'mv-key-0002' }
    );
    const reused = await service.crm.updateContact(actor, ada.id, { companyName: 'looms' }, 1, {
      idempotencyKey: 'mv-key-0003'
    });
    expect(reused.company?.name).toBe('Looms');
    const created = await service.crm.updateContact(
      actor,
      ada.id,
      { companyName: 'Analytical Co' },
      2,
      { idempotencyKey: 'mv-key-0004' }
    );
    expect(created.company?.name).toBe('Analytical Co');
    expect(store.count('companies')).toBe(3);
    const detached = await service.crm.updateContact(actor, ada.id, { companyId: null }, 3, {
      idempotencyKey: 'mv-key-0005'
    });
    expect(detached.company).toBeNull();
    // Choosing an existing company by id works too; an unknown id is a field error.
    const back = await service.crm.updateContact(
      actor,
      ada.id,
      { companyId: reused.company!.id },
      4,
      { idempotencyKey: 'mv-key-0006' }
    );
    expect(back.company?.name).toBe('Looms');
    expect(
      (
        await failure(
          service.crm.updateContact(actor, ada.id, { companyId: crypto.randomUUID() }, 5, {
            idempotencyKey: 'mv-key-0007'
          })
        )
      ).fields
    ).toHaveProperty('companyId');
    // Re-choosing the current company by name is a no-op move.
    const same = await service.crm.updateContact(actor, ada.id, { companyName: 'LOOMS' }, 5, {
      idempotencyKey: 'mv-key-0008'
    });
    expect(same.company?.id).toBe(reused.company!.id);
  });

  it('keeps a company-only lead named after its company, and refuses removing every name', async () => {
    const { service, actor } = setup();
    const lead = await service.crm.createContact(actor, contactInput({ companyName: 'Lead Co' }), {
      idempotencyKey: 'nm-key-0001'
    });
    expect(lead.displayName).toBe('Lead Co');
    const error = await failure(
      service.crm.updateContact(actor, lead.id, { companyId: null }, 1, {
        idempotencyKey: 'nm-key-0002'
      })
    );
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.fields).toHaveProperty('firstName');
    const renamed = await service.crm.updateContact(
      actor,
      lead.id,
      { companyName: 'Renamed Lead Co' },
      1,
      { idempotencyKey: 'nm-key-0003' }
    );
    expect(renamed.displayName).toBe('Renamed Lead Co');
  });

  it('clears the old company’s primary contact when its primary contact moves away', async () => {
    const { service, actor } = setup();
    const ada = await service.crm.createContact(
      actor,
      contactInput({ firstName: 'Ada', companyName: 'Primary Co' }),
      { idempotencyKey: 'pc-key-0001' }
    );
    const companyId = ada.company!.id;
    await service.crm.updateCompany(actor, companyId, { primaryContactId: ada.id }, 1, {
      idempotencyKey: 'pc-key-0002'
    });
    await service.crm.updateContact(actor, ada.id, { companyName: 'Elsewhere' }, 1, {
      idempotencyKey: 'pc-key-0003'
    });
    const { company } = await service.crm.getCompany(actor, companyId);
    expect(company).toMatchObject({ primaryContact: null, version: 3 });
  });

  it('keeps a primary contact someone else chose between our read and commit', async () => {
    const { service, actor, store } = setup();
    const ada = await service.crm.createContact(
      actor,
      contactInput({ firstName: 'Ada', companyName: 'Race Co' }),
      { idempotencyKey: 'rc-key-0001' }
    );
    const grace = await service.crm.createContact(
      actor,
      contactInput({ firstName: 'Grace', companyId: ada.company!.id }),
      { idempotencyKey: 'rc-key-0002' }
    );
    const companyId = ada.company!.id;
    await service.crm.updateCompany(actor, companyId, { primaryContactId: ada.id }, 1, {
      idempotencyKey: 'rc-key-0003'
    });
    store.beforeNextCommit((db) => {
      db.prepare('UPDATE companies SET primary_contact_id = ? WHERE id = ?').run(
        grace.id,
        companyId
      );
    });
    await service.crm.updateContact(actor, ada.id, { companyId: null }, 1, {
      idempotencyKey: 'rc-key-0004'
    });
    expect((await service.crm.getCompany(actor, companyId)).company.primaryContact?.id).toBe(
      grace.id
    );
  });

  it('reports absent contacts, stale versions, a version lost at commit, and empty edits', async () => {
    const { service, actor, store } = setup();
    expect(
      (
        await failure(
          service.crm.updateContact(actor, crypto.randomUUID(), { phone: '1' }, 1, {
            idempotencyKey: 'uce-key-0001'
          })
        )
      ).code
    ).toBe('NOT_FOUND');
    const contact = await service.crm.createContact(actor, contactInput({ firstName: 'V' }), {
      idempotencyKey: 'uce-key-0002'
    });
    expect(
      (
        await failure(
          service.crm.updateContact(actor, contact.id, { phone: '1' }, 2, {
            idempotencyKey: 'uce-key-0003'
          })
        )
      ).code
    ).toBe('VERSION_MISMATCH');
    expect(
      (
        await failure(
          service.crm.updateContact(actor, contact.id, {}, 1, { idempotencyKey: 'uce-key-0004' })
        )
      ).code
    ).toBe('VALIDATION_FAILED');
    expect(
      (
        await failure(
          service.crm.updateContact(
            actor,
            contact.id,
            { companyId: null, companyName: 'Both' },
            1,
            { idempotencyKey: 'uce-key-0005' }
          )
        )
      ).fields
    ).toHaveProperty('companyName');
    store.beforeNextCommit((db) => {
      db.prepare("UPDATE contacts SET version = 9, phone = 'theirs' WHERE id = ?").run(contact.id);
    });
    expect(
      (
        await failure(
          service.crm.updateContact(actor, contact.id, { phone: 'mine' }, 1, {
            idempotencyKey: 'uce-key-0006'
          })
        )
      ).code
    ).toBe('VERSION_MISMATCH');
    expect(store.count('contacts', "id = ? AND phone = 'theirs'", contact.id)).toBe(1);
    // A replay with the same key returns the original result.
    const once = await service.crm.updateContact(actor, contact.id, { jobTitle: 'Eng' }, 9, {
      idempotencyKey: 'uce-key-0007'
    });
    expect(
      await service.crm.updateContact(actor, contact.id, { jobTitle: 'Eng' }, 9, {
        idempotencyKey: 'uce-key-0007'
      })
    ).toEqual(once);
  });

  it('requires crm.write', async () => {
    const { service, actor, store } = setup();
    const contact = await service.crm.createContact(actor, contactInput({ firstName: 'W' }), {
      idempotencyKey: 'ucw-key-0001'
    });
    const reader = {
      ...actor,
      email: 'reader@example.com',
      userId: store.addUser('reader@example.com', 'read-only')
    };
    expect(
      (
        await failure(
          service.crm.updateContact(reader, contact.id, { phone: '1' }, 1, {
            idempotencyKey: 'ucw-key-0002'
          })
        )
      ).code
    ).toBe('FORBIDDEN');
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
    expect(store.count('companies')).toBe(0);
  });
});
