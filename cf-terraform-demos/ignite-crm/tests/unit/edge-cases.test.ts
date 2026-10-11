/**
 * @file Phase 7 corner-case sweep through the public data-service interface (production services
 *   and repositories over SQLite) and the Application Worker's RPC client:
 *
 *   - cursor edges: a cursor whose row was deleted, a final page that is exactly full, and limit
 *     bounds;
 *   - Unicode: names compared and paged across accents and astral characters;
 *   - simultaneous stale writes: two writers holding the same version, only one wins;
 *   - idempotency: a replay returns the original result even after the record changed, and reuse of a
 *     key with a different body is refused;
 *   - company primary-contact reassignment, including a contact moved to another company between the
 *     read and the commit;
 *   - transaction error paths: a failure part-way through a write set leaves no partial rows;
 *   - service-error serialization across RPC, including field errors, and a partial RPC timeout.
 */

import { describe, expect, it, vi } from 'vitest';
import { createDataClient, type DataRpc } from '../../src/application-worker/data-client.ts';
import { encodeCursor } from '../../src/data-worker/application/shared/paging.ts';
import { isServiceError, serviceError } from '../../src/shared/common/errors.ts';
import type { ActorContext } from '../../src/shared/data-service/contract.ts';
import { createFakeDataService, testRuntime } from '../fakes/fake-data-service.ts';

let counter = 0;

/**
 * A fresh idempotency key.
 *
 * @returns Mutation metadata.
 */
function key(): { idempotencyKey: string } {
  return { idempotencyKey: `edge-case-${++counter}` };
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
 * A fake with an owner and a sales user.
 *
 * @returns Service, store, and actors.
 */
function world() {
  const fake = createFakeDataService({
    runtime: testRuntime(new Date('2026-10-11T09:00:00.000Z'))
  });
  const actor = (email: string, role: 'owner' | 'sales'): ActorContext => ({
    email,
    userId: fake.store.addUser(email, role),
    requestId: `req-${role}`,
    channel: 'api'
  });
  return {
    ...fake,
    owner: actor('owner@example.com', 'owner'),
    sales: actor('s@example.com', 'sales')
  };
}

/**
 * Create-contact input.
 *
 * @param firstName First name.
 * @param companyName Company, if any.
 * @returns The input.
 */
function contact(firstName: string, companyName: string | null = null) {
  return {
    firstName,
    lastName: null,
    email: null,
    phone: null,
    jobTitle: null,
    companyId: null,
    companyName
  };
}

describe('cursor and paging edges', () => {
  it('continues past a deleted cursor row, ends cleanly on an exactly full page, and bounds limits', async () => {
    const { service, store, sales } = world();
    for (const name of ['Ana', 'Ben', 'Cy', 'Di']) {
      await service.crm.createContact(sales, contact(name), key());
    }
    const first = await service.crm.listContacts(sales, { limit: 2 });
    expect(first.items.map((item) => item.displayName)).toEqual(['Ana', 'Ben']);
    // The row the cursor points at disappears before the next page is requested.
    store.exec("UPDATE contacts SET deleted_at = 'x' WHERE first_name = 'Ben'");
    const second = await service.crm.listContacts(sales, {
      limit: 2,
      cursor: first.nextCursor!
    });
    expect(second.items.map((item) => item.displayName)).toEqual(['Cy', 'Di']);
    // Exactly `limit` rows remained, so there is no phantom next page.
    expect(second.nextCursor).toBeNull();
    // A syntactically valid cursor beyond the end yields an empty last page.
    expect(
      await service.crm.listContacts(sales, { limit: 2, cursor: encodeCursor('zzz', 'z') })
    ).toEqual({ items: [], nextCursor: null });
    for (const limit of [0, 101, 2.5]) {
      expect((await failure(service.crm.listContacts(sales, { limit }))).code).toBe(
        'VALIDATION_FAILED'
      );
    }
    expect((await service.crm.listContacts(sales, { limit: 100 })).items).toHaveLength(3);
  });

  it('pages Unicode names in a stable order and searches them case-insensitively', async () => {
    const { service, sales } = world();
    for (const name of ['Émile', 'zoë', '🚀 Rocket', 'Ångström']) {
      await service.crm.createContact(sales, contact(name), key());
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.crm.listContacts(sales, {
        limit: 1,
        ...(cursor ? { cursor } : {})
      });
      seen.push(...page.items.map((item) => item.displayName));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect([...seen].sort()).toEqual(['zoë', 'Ångström', 'Émile', '🚀 Rocket'].sort());
    expect(new Set(seen).size).toBe(4);
    expect(
      (await service.crm.listContacts(sales, { q: 'ZOË', limit: 10 })).items.map(
        (i) => i.displayName
      )
    ).toEqual(['zoë']);
  });
});

describe('concurrency and idempotency', () => {
  it('lets exactly one of two writers holding the same version win', async () => {
    const { service, owner, sales } = world();
    const created = await service.crm.createContact(sales, contact('Race', 'Race Co'), key());
    const companyId = created.company!.id;
    const results = await Promise.allSettled([
      service.crm.updateCompany(owner, companyId, { address: 'Owner' }, 1, key()),
      service.crm.updateCompany(sales, companyId, { address: 'Sales' }, 1, key())
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((result) => result.status === 'rejected');
    expect(isServiceError(loser?.reason) && loser.reason.code).toBe('VERSION_MISMATCH');
    expect((await service.crm.getCompany(owner, companyId)).company.version).toBe(2);
  });

  it('replays the original response after later edits, and refuses a reused key with a new body', async () => {
    const { service, sales } = world();
    const meta = key();
    const created = await service.crm.createContact(sales, contact('Idem', 'Idem Co'), meta);
    await service.crm.updateCompany(sales, created.company!.id, { address: 'Later' }, 1, key());
    const replay = await service.crm.createContact(sales, contact('Idem', 'Idem Co'), meta);
    expect(replay).toEqual(created);
    expect((await failure(service.crm.createContact(sales, contact('Different'), meta))).code).toBe(
      'IDEMPOTENCY_KEY_REUSED'
    );
  });
});

describe('company primary-contact reassignment', () => {
  it('reassigns, refuses a contact from elsewhere, and catches a move between read and commit', async () => {
    const { service, store, sales } = world();
    const ada = await service.crm.createContact(sales, contact('Ada', 'Engines'), key());
    const companyId = ada.company!.id;
    const grace = await service.crm.createContact(sales, { ...contact('Grace'), companyId }, key());
    const outsider = await service.crm.createContact(sales, contact('Out', 'Elsewhere'), key());
    const first = await service.crm.updateCompany(
      sales,
      companyId,
      { primaryContactId: ada.id },
      1,
      key()
    );
    expect(first.primaryContact?.id).toBe(ada.id);
    const second = await service.crm.updateCompany(
      sales,
      companyId,
      { primaryContactId: grace.id },
      2,
      key()
    );
    expect(second.primaryContact).toEqual({ id: grace.id, displayName: 'Grace' });
    expect(
      (
        await failure(
          service.crm.updateCompany(sales, companyId, { primaryContactId: outsider.id }, 3, key())
        )
      ).fields
    ).toHaveProperty('primaryContactId');
    // Ada moves to another company after the service validated her but before the commit.
    store.beforeNextCommit((db) => {
      db.prepare('UPDATE contacts SET company_id = ? WHERE id = ?').run(
        outsider.company!.id,
        ada.id
      );
    });
    expect(
      (
        await failure(
          service.crm.updateCompany(sales, companyId, { primaryContactId: ada.id }, 3, key())
        )
      ).code
    ).toBe('NOT_FOUND');
    expect((await service.crm.getCompany(sales, companyId)).company).toMatchObject({
      version: 3,
      primaryContact: { id: grace.id }
    });
    // A soft-deleted primary contact is shown as none rather than as a dangling link.
    store.exec("UPDATE contacts SET deleted_at = 'x' WHERE id = ?", grace.id);
    expect((await service.crm.getCompany(sales, companyId)).company.primaryContact).toBeNull();
  });
});

describe('transaction error paths', () => {
  it('leaves no partial rows when any statement of a create fails', async () => {
    const { service, store, sales } = world();
    for (let index = 0; index < 4; index++) {
      const before = {
        contacts: store.count('contacts'),
        companies: store.count('companies'),
        audit: store.count('audit_events'),
        idempotency: store.count('idempotency_records')
      };
      store.failNextWriteAt(index);
      const error = await failure(
        service.crm.createContact(sales, contact(`Tx${index}`, `Tx Co ${index}`), key())
      );
      expect(error).toMatchObject({ code: 'DEPENDENCY_FAILURE', retryable: true });
      expect({
        contacts: store.count('contacts'),
        companies: store.count('companies'),
        audit: store.count('audit_events'),
        idempotency: store.count('idempotency_records')
      }).toEqual(before);
    }
  });
});

describe('RPC error serialization and partial timeouts', () => {
  it('carries code, message, request id, retryability, and field errors across the envelope', async () => {
    // The Data Worker's envelope (built by `envelope()` in `src/data-worker/entrypoint.ts`, which
    // the workerd integration suite exercises) is plain data, so it survives structured cloning —
    // an Error subclass would lose its own properties on the way across RPC.
    const source = serviceError('VALIDATION_FAILED', 'The request contains invalid fields.', {
      requestId: 'req-9',
      fields: { email: 'Enter a valid e-mail address.' }
    });
    const cloned = structuredClone({
      ok: false,
      error: {
        name: 'ServiceError',
        code: source.code,
        message: source.message,
        retryable: source.retryable,
        requestId: source.requestId,
        fields: { ...source.fields }
      }
    });
    const rpc = {
      crm: () => ({ createContact: () => Promise.resolve(cloned) })
    } as unknown as DataRpc;
    const client = createDataClient(rpc);
    const error = await failure(
      client.crm.createContact({} as ActorContext, contact('x'), { idempotencyKey: 'abcdefgh' })
    );
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      requestId: 'req-9',
      retryable: false,
      fields: { email: 'Enter a valid e-mail address.' }
    });
    expect(isServiceError(error)).toBe(true);
  });

  it('times out one slow call without affecting a concurrent fast one', async () => {
    vi.useFakeTimers();
    try {
      const transport = vi.fn();
      const rpc = {
        crm: () => ({
          getContact: () => new Promise(() => undefined),
          listContacts: () => Promise.resolve({ ok: true, value: { items: [], nextCursor: null } })
        })
      } as unknown as DataRpc;
      const client = createDataClient(rpc, { timeoutMs: 50, onTransportError: transport });
      const slow = failure(client.crm.getContact({} as ActorContext, 'x'));
      const fast = client.crm.listContacts({} as ActorContext, { limit: 1 });
      await expect(fast).resolves.toEqual({ items: [], nextCursor: null });
      await vi.advanceTimersByTimeAsync(60);
      expect(await slow).toMatchObject({ code: 'DEPENDENCY_FAILURE', retryable: true });
      expect(transport).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
