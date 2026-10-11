/**
 * @file Team administration and the audit trail through the public data-service interface, over the
 *   production repositories on in-memory SQLite: owner-only invite and role/status changes
 *   (unknown, duplicate, invalid, stale, and missing cases), the final-owner invariant including a
 *   concurrent race, a role change taking effect on the very next request, idempotency, rollback,
 *   and the audit projection's filters, paging, and redaction (a note digest, never its body).
 */

import { describe, expect, it } from 'vitest';
import type { ActorContext } from '../../../src/shared/data-service/contract.ts';
import type { Role } from '../../../src/shared/permissions.ts';
import { createFakeDataService, testRuntime } from '../../fakes/fake-data-service.ts';

let keyCounter = 0;

/**
 * A fresh idempotency key.
 *
 * @returns Mutation metadata.
 */
function key(): { idempotencyKey: string } {
  return { idempotencyKey: `team-key-${++keyCounter}` };
}

/**
 * Capture a rejection.
 *
 * @param promise The operation.
 * @returns The error.
 */
async function failure(promise: Promise<unknown>): Promise<{
  code: string;
  message: string;
  fields?: Record<string, string>;
  retryable?: boolean;
}> {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error('expected failure');
}

/**
 * A fake with one user per role.
 *
 * @returns The service, store, and actors.
 */
function world() {
  const { service, store } = createFakeDataService({
    runtime: testRuntime(new Date('2026-10-11T09:00:00.000Z'))
  });
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
  return { service, store, actor: (role: Role) => actors.get(role)! };
}

describe('inviteUser', () => {
  it('lets an owner add a teammate whose first sign-in already has the roles', async () => {
    const { service, store, actor } = world();
    const member = await service.permissions.inviteUser(
      actor('owner'),
      {
        email: '  New.Person@Example.com ',
        displayName: 'New Person',
        roles: ['delivery', 'sales']
      },
      key()
    );
    expect(member).toMatchObject({
      email: 'new.person@example.com',
      displayName: 'New Person',
      status: 'active',
      version: 1,
      roles: [
        { id: 'sales', label: 'Sales representative' },
        { id: 'delivery', label: 'Delivery contributor' }
      ]
    });
    // The invitee signs in: no auto-provision, the invited roles apply.
    const resolved = await service.resolveActor('new.person@example.com', 'req-new');
    expect(resolved.userId).toBe(member.id);
    const session = await service.permissions.getSession({
      email: resolved.email,
      userId: resolved.userId,
      requestId: 'req-new',
      channel: 'api'
    });
    expect(session.permissions).toEqual(expect.arrayContaining(['crm.write', 'project.write']));
    expect(store.count('audit_events', "action = 'invited'")).toBe(1);
    expect(
      store.count('user_roles', 'user_id = ? AND granted_by = ?', member.id, actor('owner').userId)
    ).toBe(2);
  });

  it('refuses everyone but owners', async () => {
    const { service, actor } = world();
    for (const role of ['manager', 'sales', 'delivery', 'read-only'] as const) {
      expect(
        (
          await failure(
            service.permissions.inviteUser(
              actor(role),
              { email: `x-${role}@example.com`, displayName: 'X', roles: ['sales'] },
              key()
            )
          )
        ).code,
        role
      ).toBe('FORBIDDEN');
    }
  });

  it('rejects duplicates, invalid roles, bad e-mail, and smuggled fields', async () => {
    const { service, store, actor } = world();
    const invite = (input: unknown) =>
      failure(service.permissions.inviteUser(actor('owner'), input as never, key()));
    expect(
      await invite({ email: 'SALES@example.com', displayName: 'Dup', roles: ['sales'] })
    ).toMatchObject({ code: 'CONFLICT', fields: { email: 'That e-mail is already on the team.' } });
    expect(
      (await invite({ email: 'a@example.com', displayName: 'A', roles: ['admin'] })).fields
    ).toHaveProperty('roles.0');
    expect((await invite({ email: 'a@example.com', displayName: 'A', roles: [] })).fields).toEqual({
      roles: 'Choose at least one role.'
    });
    expect(
      (await invite({ email: 'a@example.com', displayName: 'A', roles: ['sales', 'sales'] })).fields
    ).toEqual({ roles: 'Each role may be chosen only once.' });
    expect(
      (await invite({ email: 'not-an-email', displayName: 'A', roles: ['sales'] })).fields
    ).toEqual({
      email: 'Must be a valid e-mail address.'
    });
    expect(
      (
        await invite({
          email: 'a@example.com',
          displayName: 'A',
          roles: ['sales'],
          status: 'suspended'
        })
      ).code
    ).toBe('VALIDATION_FAILED');
    expect(store.count('users')).toBe(5);
  });

  it('replays a retried invite and turns a concurrent duplicate into CONFLICT with nothing written', async () => {
    const { service, store, actor } = world();
    const meta = key();
    const input = { email: 'twice@example.com', displayName: 'Twice', roles: ['sales'] as Role[] };
    const first = await service.permissions.inviteUser(actor('owner'), input, meta);
    expect(await service.permissions.inviteUser(actor('owner'), input, meta)).toEqual(first);
    expect(store.count('users', 'email = ?', 'twice@example.com')).toBe(1);

    store.beforeNextCommit((db) => {
      db.prepare(
        "INSERT INTO users (id, email, display_name, status, version, created_at, updated_at) VALUES (?, 'race@example.com', 'Race', 'active', 1, 'x', 'x')"
      ).run(crypto.randomUUID());
    });
    expect(
      (
        await failure(
          service.permissions.inviteUser(
            actor('owner'),
            { email: 'race@example.com', displayName: 'Race', roles: ['sales'] },
            key()
          )
        )
      ).code
    ).toBe('CONFLICT');
    expect(store.count('audit_events', "action = 'invited'")).toBe(1);
  });
});

describe('setUserRoles and setUserStatus', () => {
  it('changes roles, versions the record, and the next request sees the change', async () => {
    const { service, store, actor } = world();
    const sales = actor('sales');
    // Before: sales cannot read the audit trail.
    expect((await failure(service.permissions.listAudit(sales, { limit: 5 }))).code).toBe(
      'FORBIDDEN'
    );
    const updated = await service.permissions.setUserRoles(
      actor('owner'),
      sales.userId,
      { roles: ['manager'] },
      1,
      key()
    );
    expect(updated).toMatchObject({ version: 2, roles: [{ id: 'manager' }] });
    // Immediately after, with no new sign-in: allowed.
    await expect(service.permissions.listAudit(sales, { limit: 5 })).resolves.toBeDefined();
    const audit = store.port.db
      .prepare("SELECT metadata_json FROM audit_events WHERE action = 'roles-changed'")
      .get() as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toEqual({
      rolesBefore: 'sales',
      rolesAfter: 'manager'
    });
  });

  it('suspends and reactivates, refusing the suspended user on the very next request', async () => {
    const { service, actor } = world();
    const delivery = actor('delivery');
    await service.permissions.setUserStatus(
      actor('owner'),
      delivery.userId,
      { status: 'suspended' },
      1,
      key()
    );
    expect((await failure(service.resolveActor('delivery@example.com', 'r'))).code).toBe(
      'FORBIDDEN'
    );
    expect((await failure(service.projects.myWork(delivery))).code).toBe('FORBIDDEN');
    const back = await service.permissions.setUserStatus(
      actor('owner'),
      delivery.userId,
      { status: 'active' },
      2,
      key()
    );
    expect(back).toMatchObject({ status: 'active', version: 3 });
    await expect(service.projects.myWork(delivery)).resolves.toBeDefined();
  });

  it('keeps at least one active owner and refuses self-suspension', async () => {
    const { service, store, actor } = world();
    const owner = actor('owner');
    expect(
      await failure(
        service.permissions.setUserRoles(owner, owner.userId, { roles: ['manager'] }, 1, key())
      )
    ).toMatchObject({ code: 'CONFLICT', message: 'The team must keep at least one active owner.' });
    expect(
      (
        await failure(
          service.permissions.setUserStatus(owner, owner.userId, { status: 'suspended' }, 1, key())
        )
      ).message
    ).toBe('You cannot suspend your own account.');
    // With a second owner, the first may step down.
    await service.permissions.setUserRoles(
      owner,
      actor('manager').userId,
      { roles: ['owner'] },
      1,
      key()
    );
    await service.permissions.setUserRoles(owner, owner.userId, { roles: ['manager'] }, 1, key());
    expect(store.count('user_roles', "role_id = 'owner'")).toBe(1);
  });

  it('refuses a demotion that races with another, at commit time', async () => {
    const { service, store, actor } = world();
    const owner = actor('owner');
    const manager = actor('manager');
    await service.permissions.setUserRoles(owner, manager.userId, { roles: ['owner'] }, 1, key());
    // The early check sees two owners; a concurrent writer demotes the other one before commit.
    store.beforeNextCommit((db) => {
      db.prepare("DELETE FROM user_roles WHERE user_id = ? AND role_id = 'owner'").run(
        manager.userId
      );
      db.prepare(
        "INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, 'manager', 'x')"
      ).run(manager.userId);
    });
    expect(
      (
        await failure(
          service.permissions.setUserRoles(owner, owner.userId, { roles: ['sales'] }, 1, key())
        )
      ).code
    ).toBe('CONFLICT');
    // The rolled-back write set left the owner an owner.
    expect(store.count('user_roles', "user_id = ? AND role_id = 'owner'", owner.userId)).toBe(1);
  });

  it('reports stale versions, missing users, and invalid input; non-owners are refused', async () => {
    const { service, store, actor } = world();
    const owner = actor('owner');
    const target = actor('sales').userId;
    await service.permissions.setUserRoles(owner, target, { roles: ['delivery'] }, 1, key());
    expect(
      (
        await failure(
          service.permissions.setUserRoles(owner, target, { roles: ['sales'] }, 1, key())
        )
      ).code
    ).toBe('VERSION_MISMATCH');
    expect(
      (
        await failure(
          service.permissions.setUserRoles(
            owner,
            '00000000-0000-4000-8000-00000000ffff',
            { roles: ['sales'] },
            1,
            key()
          )
        )
      ).code
    ).toBe('NOT_FOUND');
    expect(
      (await failure(service.permissions.setUserRoles(owner, target, { roles: [] }, 2, key()))).code
    ).toBe('VALIDATION_FAILED');
    expect(
      (
        await failure(
          service.permissions.setUserStatus(owner, target, { status: 'deleted' } as never, 2, key())
        )
      ).code
    ).toBe('VALIDATION_FAILED');
    expect(
      (
        await failure(
          service.permissions.setUserRoles(actor('manager'), target, { roles: ['owner'] }, 2, key())
        )
      ).code
    ).toBe('FORBIDDEN');
    expect(
      (
        await failure(
          service.permissions.setUserStatus(
            actor('manager'),
            target,
            { status: 'suspended' },
            2,
            key()
          )
        )
      ).code
    ).toBe('FORBIDDEN');
    // A concurrent change between read and commit loses cleanly.
    store.beforeNextCommit((db) => {
      db.prepare('UPDATE users SET version = version + 1 WHERE id = ?').run(target);
    });
    expect(
      (
        await failure(
          service.permissions.setUserStatus(owner, target, { status: 'suspended' }, 2, key())
        )
      ).code
    ).toBe('VERSION_MISMATCH');
  });

  it('rolls back every row when the write set fails at any statement', async () => {
    const { service, store, actor } = world();
    const owner = actor('owner');
    const target = actor('read-only').userId;
    await service.permissions.setUserRoles(owner, target, { roles: ['sales'] }, 1, key());
    const size = store.lastWriteSetSize;
    const rows = () => ({
      roles: store.count('user_roles', 'user_id = ?', target),
      version: store.count('users', 'id = ? AND version = 2', target),
      audit: store.count('audit_events', "action = 'roles-changed'")
    });
    const before = rows();
    for (let index = 0; index < size; index++) {
      store.failNextWriteAt(index);
      expect(
        (
          await failure(
            service.permissions.setUserRoles(
              owner,
              target,
              { roles: ['delivery', 'manager'] },
              2,
              key()
            )
          )
        ).code
      ).toBe('DEPENDENCY_FAILURE');
      expect(rows()).toEqual(before);
    }
  });

  it('replays a retried change with a stale version instead of conflicting', async () => {
    const { service, actor } = world();
    const meta = key();
    const target = actor('sales').userId;
    const first = await service.permissions.setUserRoles(
      actor('owner'),
      target,
      { roles: ['manager'] },
      1,
      meta
    );
    expect(
      await service.permissions.setUserRoles(
        actor('owner'),
        target,
        { roles: ['manager'] },
        1,
        meta
      )
    ).toEqual(first);
  });
});

describe('team directory and roles', () => {
  it('lists, searches, and pages members for owners and managers only', async () => {
    const { service, actor } = world();
    const page = await service.permissions.listTeam(actor('manager'), { limit: 2 });
    expect(page.items.map((member) => member.email)).toEqual([
      'delivery@example.com',
      'manager@example.com'
    ]);
    const next = await service.permissions.listTeam(actor('manager'), {
      limit: 2,
      cursor: page.nextCursor!
    });
    expect(next.items.map((member) => member.email)).toEqual([
      'owner@example.com',
      'read-only@example.com'
    ]);
    expect(
      (await service.permissions.listTeam(actor('owner'), { limit: 10, q: 'SALES' })).items.map(
        (m) => m.email
      )
    ).toEqual(['sales@example.com']);
    for (const role of ['sales', 'delivery', 'read-only'] as const) {
      expect((await failure(service.permissions.listTeam(actor(role), { limit: 5 }))).code).toBe(
        'FORBIDDEN'
      );
      expect((await failure(service.permissions.listRoles(actor(role)))).code).toBe('FORBIDDEN');
    }
    expect(
      (await failure(service.permissions.listTeam(actor('owner'), { limit: 5, cursor: 'nope!' })))
        .code
    ).toBe('VALIDATION_FAILED');
  });

  it('returns the fixed role catalogue in display order with each role’s permissions', async () => {
    const { service, actor } = world();
    const roles = await service.permissions.listRoles(actor('owner'));
    expect(roles.map((role) => role.id)).toEqual([
      'owner',
      'manager',
      'sales',
      'delivery',
      'read-only'
    ]);
    expect(roles.find((role) => role.id === 'manager')?.permissions).toContain('users.read');
    expect(roles.find((role) => role.id === 'manager')?.permissions).not.toContain('users.manage');
  });

  it('fails closed when storage is unavailable', async () => {
    const { service, store, actor } = world();
    store.failing = true;
    expect(await failure(service.permissions.listTeam(actor('owner'), { limit: 5 }))).toMatchObject(
      {
        code: 'DEPENDENCY_FAILURE',
        retryable: true
      }
    );
  });
});

describe('listAudit', () => {
  it('shows contact, deal, project, and note changes with a note digest and never the body', async () => {
    const { service, store, actor } = world();
    const sales = actor('sales');
    const contact = await service.crm.createContact(
      sales,
      {
        firstName: 'Ada',
        lastName: null,
        email: null,
        phone: null,
        jobTitle: null,
        companyId: null,
        companyName: 'Engines'
      },
      key()
    );
    const deal = await service.crm.createDeal(
      sales,
      {
        title: 'Renewal',
        primaryContactId: contact.id,
        amountMinor: 100,
        statusLine: 'Confidential pricing remark',
        nextActionText: null,
        nextActionDate: null,
        expectedCloseDate: null
      },
      key()
    );
    const project = await service.projects.convertDeal(sales, deal.id, { markWon: true }, 1, key());
    const note = await service.notes.createNote(
      sales,
      {
        title: 'Secret meeting',
        markdown: 'The customer told us their budget is £1.2m',
        links: [{ type: 'contact', id: contact.id }]
      },
      key()
    );
    // A future writer that slips a body into metadata is redacted at the boundary.
    store.exec(
      `INSERT INTO audit_events (id, module, entity_type, entity_id, action, actor_id, request_id, metadata_json, occurred_at)
       VALUES (?, 'notes', 'note', ?, 'leaky', ?, 'r', ?, '2026-10-11T10:00:00.000Z')`,
      crypto.randomUUID(),
      note.id,
      sales.userId,
      JSON.stringify({ markdown: 'The customer told us their budget is £1.2m', linkCount: 1 })
    );

    const page = await service.permissions.listAudit(actor('manager'), { limit: 100 });
    const serialised = JSON.stringify(page);
    expect(serialised).not.toContain('budget');
    expect(serialised).not.toContain('Confidential pricing');
    const types = new Set(page.items.map((event) => event.entityType));
    for (const type of ['contact', 'deal', 'project', 'note']) {
      expect(types, type).toContain(type);
    }
    const created = page.items.find(
      (event) => event.entityType === 'note' && event.action === 'created'
    )!;
    expect(created).toMatchObject({
      entityLabel: 'Secret meeting',
      redacted: false,
      module: 'notes'
    });
    expect(created.metadata.digest).toMatch(/^[0-9a-f]{64}$/u);
    const leaky = page.items.find((event) => event.action === 'leaky')!;
    expect(leaky).toMatchObject({ redacted: true, metadata: { linkCount: 1 } });
    expect(page.items.some((event) => event.entityId === project.id)).toBe(true);
  });

  it('filters by module, entity, and actor, and pages newest first without gaps', async () => {
    const { service, actor } = world();
    const owner = actor('owner');
    for (const role of ['sales', 'delivery', 'read-only'] as const) {
      await service.permissions.setUserRoles(
        owner,
        actor(role).userId,
        { roles: ['manager'] },
        1,
        key()
      );
    }
    const all = await service.permissions.listAudit(owner, { limit: 100, module: 'permissions' });
    expect(all.items.map((event) => event.action)).toEqual([
      'roles-changed',
      'roles-changed',
      'roles-changed'
    ]);
    const first = await service.permissions.listAudit(owner, { limit: 2, module: 'permissions' });
    const second = await service.permissions.listAudit(owner, {
      limit: 2,
      module: 'permissions',
      cursor: first.nextCursor!
    });
    expect([...first.items, ...second.items].map((event) => event.id)).toEqual(
      all.items.map((event) => event.id)
    );
    expect(second.nextCursor).toBeNull();
    const one = await service.permissions.listAudit(owner, {
      limit: 10,
      entityType: 'user',
      entityId: actor('sales').userId
    });
    expect(one.items).toHaveLength(1);
    expect(one.items[0]).toMatchObject({ entityLabel: 'sales', actor: { id: owner.userId } });
    expect(
      (await service.permissions.listAudit(owner, { limit: 10, actorId: actor('sales').userId }))
        .items
    ).toEqual([]);
    expect(
      (
        await failure(
          service.permissions.listAudit(owner, { limit: 10, entityType: 'secret' } as never)
        )
      ).code
    ).toBe('VALIDATION_FAILED');
  });

  it('is limited to roles with audit.read', async () => {
    const { service, actor } = world();
    for (const role of ['sales', 'delivery', 'read-only'] as const) {
      expect(
        (await failure(service.permissions.listAudit(actor(role), { limit: 5 }))).code,
        role
      ).toBe('FORBIDDEN');
    }
  });
});
