/**
 * @file The role-permission matrix as explicit tests. {@link MATRIX} is a hand-written fixture —
 *   deliberately not derived from `SEED_ROLE_PERMISSIONS` — naming which seeded roles may perform
 *   each critical CRM, project, notes, reporting, administration, and audit operation. Every
 *   operation is run as every role against a fresh store, through the public data-service
 *   interface, so both the allowed and the denied cell of each row is a real, observable test. A
 *   change to the seeded matrix that is not mirrored here fails loudly.
 */

import { describe, expect, it } from 'vitest';
import type { ActorContext, DataService } from '../../../src/shared/data-service/contract.ts';
import { type Role, ROLES } from '../../../src/shared/permissions.ts';
import {
  createFakeDataService,
  type FakeStore,
  testRuntime
} from '../../fakes/fake-data-service.ts';

let keyCounter = 0;

/**
 * A fresh idempotency key.
 *
 * @returns Mutation metadata.
 */
function key(): { idempotencyKey: string } {
  return { idempotencyKey: `matrix-key-${++keyCounter}` };
}

/**
 * Records every operation can act on, created by the owner.
 */
interface Fixture {
  readonly service: DataService;
  readonly store: FakeStore;
  readonly as: (role: Role) => ActorContext;
  readonly contactId: string;
  readonly companyId: string;
  readonly pendingDealId: string;
  readonly wonDealId: string;
  readonly projectId: string;
  readonly noteId: string;
  readonly targetUserId: string;
}

/**
 * A fresh store with one user per role and one of each record.
 *
 * @returns The fixture.
 */
async function fixture(): Promise<Fixture> {
  const { service, store } = createFakeDataService({
    runtime: testRuntime(new Date('2026-10-11T09:00:00.000Z'))
  });
  const actors = new Map<Role, ActorContext>();
  for (const role of ROLES) {
    const email = `${role}@example.com`;
    actors.set(role, {
      email,
      userId: store.addUser(email, role),
      requestId: role,
      channel: 'api'
    });
  }
  const as = (role: Role): ActorContext => actors.get(role)!;
  const targetUserId = store.addUser('target@example.com', 'read-only');
  const owner = as('owner');
  const contact = await service.crm.createContact(
    owner,
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
  const deal = (title: string) =>
    service.crm.createDeal(
      owner,
      {
        title,
        primaryContactId: contact.id,
        amountMinor: 100,
        statusLine: null,
        nextActionText: null,
        nextActionDate: null,
        expectedCloseDate: null
      },
      key()
    );
  const pending = await deal('Pending');
  const won = await service.crm.updateDeal(
    owner,
    (await deal('Won')).id,
    { status: 'won' },
    1,
    key()
  );
  const project = await service.projects.convertDeal(
    owner,
    (await deal('Delivered')).id,
    { markWon: true },
    1,
    key()
  );
  const note = await service.notes.createNote(
    owner,
    { title: 'Owner note', markdown: 'Body', links: [{ type: 'contact', id: contact.id }] },
    key()
  );
  return {
    service,
    store,
    as,
    contactId: contact.id,
    companyId: contact.company!.id,
    pendingDealId: pending.id,
    wonDealId: won.id,
    projectId: project.id,
    noteId: note.id,
    targetUserId
  };
}

/**
 * One row of the matrix.
 */
interface Row {
  /**
   * What is being attempted.
   */
  readonly name: string;
  /**
   * Roles that must succeed; every other role must get `FORBIDDEN`.
   */
  readonly allowed: readonly Role[];
  /**
   * The attempt.
   */
  readonly run: (f: Fixture, actor: ActorContext) => Promise<unknown>;
}

const EVERYONE = ROLES;
const WRITERS: readonly Role[] = ['owner', 'manager', 'sales'];

/**
 * The fixture: who may do what.
 */
const MATRIX: readonly Row[] = [
  // CRM
  {
    name: 'read a contact',
    allowed: EVERYONE,
    run: (f, a) => f.service.crm.getContact(a, f.contactId)
  },
  {
    name: 'create a contact',
    allowed: WRITERS,
    run: (f, a) =>
      f.service.crm.createContact(
        a,
        {
          firstName: 'Bo',
          lastName: null,
          email: null,
          phone: null,
          jobTitle: null,
          companyId: f.companyId,
          companyName: null
        },
        key()
      )
  },
  {
    name: 'move a deal',
    allowed: WRITERS,
    run: (f, a) => f.service.crm.updateDeal(a, f.pendingDealId, { title: 'Renamed' }, 1, key())
  },
  {
    name: 'assign a deal to someone else',
    allowed: ['owner', 'manager'],
    run: (f, a) =>
      f.service.crm.updateDeal(a, f.pendingDealId, { ownerId: f.as('sales').userId }, 1, key())
  },
  // Projects
  {
    name: 'convert a won deal',
    allowed: WRITERS,
    run: (f, a) => f.service.projects.convertDeal(a, f.wonDealId, {}, 2, key())
  },
  {
    name: 'read a project',
    allowed: EVERYONE,
    run: (f, a) => f.service.projects.getProject(a, f.projectId)
  },
  {
    name: 'create a task',
    allowed: ['owner', 'manager', 'delivery'],
    run: (f, a) =>
      f.service.projects.createTask(
        a,
        f.projectId,
        {
          title: 'T',
          description: null,
          status: 'todo',
          priority: 'low',
          assigneeId: null,
          dueDate: null
        },
        key()
      )
  },
  {
    name: 'archive a project',
    allowed: ['owner', 'manager'],
    run: (f, a) =>
      f.service.projects.updateProject(a, f.projectId, { status: 'archived' }, 1, key())
  },
  // Notes
  {
    name: 'search notes',
    allowed: EVERYONE,
    run: (f, a) => f.service.notes.searchNotes(a, 'body')
  },
  {
    name: 'write a note',
    allowed: ['owner', 'manager', 'sales', 'delivery'],
    run: (f, a) =>
      f.service.notes.createNote(
        a,
        { title: 'N', markdown: 'B', links: [{ type: 'contact', id: f.contactId }] },
        key()
      )
  },
  {
    name: "edit someone else's note",
    allowed: ['owner', 'manager'],
    run: (f, a) => f.service.notes.updateNote(a, f.noteId, { title: 'Edited' }, 1, key())
  },
  // Reporting
  {
    name: 'read the pipeline report',
    allowed: EVERYONE,
    run: (f, a) => f.service.crm.pipelineSummary(a)
  },
  // Administration
  {
    name: 'read the team directory',
    allowed: ['owner', 'manager'],
    run: (f, a) => f.service.permissions.listTeam(a, { limit: 5 })
  },
  {
    name: 'invite a teammate',
    allowed: ['owner'],
    run: (f, a) =>
      f.service.permissions.inviteUser(
        a,
        { email: 'invitee@example.com', displayName: 'Invitee', roles: ['sales'] },
        key()
      )
  },
  {
    name: 'change a role',
    allowed: ['owner'],
    run: (f, a) =>
      f.service.permissions.setUserRoles(a, f.targetUserId, { roles: ['sales'] }, 1, key())
  },
  {
    name: 'suspend a teammate',
    allowed: ['owner'],
    run: (f, a) =>
      f.service.permissions.setUserStatus(a, f.targetUserId, { status: 'suspended' }, 1, key())
  },
  // Audit
  {
    name: 'read the audit trail',
    allowed: ['owner', 'manager'],
    run: (f, a) => f.service.permissions.listAudit(a, { limit: 5 })
  }
];

describe.each(MATRIX)('$name', (row) => {
  it.each(ROLES.map((role) => [role, row.allowed.includes(role)] as const))(
    'as %s → allowed: %s',
    async (role, allowed) => {
      const f = await fixture();
      const outcome = await row.run(f, f.as(role)).then(
        () => 'ok',
        (error: { code?: string }) => error.code ?? 'thrown'
      );
      expect(outcome).toBe(allowed ? 'ok' : 'FORBIDDEN');
    }
  );
});

it('a changed role is enforced on the very next call', async () => {
  const f = await fixture();
  const reader = f.as('read-only');
  const attempt = () =>
    f.service.notes.createNote(
      reader,
      { title: 'N', markdown: 'B', links: [{ type: 'contact', id: f.contactId }] },
      key()
    );
  await expect(attempt()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await f.service.permissions.setUserRoles(
    f.as('owner'),
    reader.userId,
    { roles: ['read-only', 'delivery'] },
    1,
    key()
  );
  await expect(attempt()).resolves.toMatchObject({ title: 'N' });
  await f.service.permissions.setUserRoles(
    f.as('owner'),
    reader.userId,
    { roles: ['read-only'] },
    2,
    key()
  );
  await expect(attempt()).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
