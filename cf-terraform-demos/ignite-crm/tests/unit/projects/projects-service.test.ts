/**
 * @file Projects use cases through the public data-service interface, over the production
 *   repositories on in-memory SQLite. Covers the atomic won-deal conversion contract — including a
 *   rollback proof that fails the write set at every statement — plus project edits, tasks, the
 *   board ordering, and the personal worklist, each with validation, authorization, absence,
 *   conflict, idempotency, and dependency-failure paths.
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
 * "Now" for every test: 09:00 UTC on 11 Oct 2026 (10:00 in London).
 */
const NOW = new Date('2026-10-11T09:00:00.000Z');

let keyCounter = 0;

/**
 * A fresh idempotency key.
 *
 * @returns Mutation metadata.
 */
function key(): { idempotencyKey: string } {
  return { idempotencyKey: `projects-key-${++keyCounter}` };
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
 * Everything a test needs.
 */
interface World {
  service: DataService;
  store: FakeStore;
  runtime: ReturnType<typeof testRuntime>;
  actor(role: Role): ActorContext;
  contactId: string;
  companyId: string;
  /**
   * Create a deal (pending, or won with `won: true`).
   */
  deal(options?: { won?: boolean; title?: string }): Promise<{ id: string; version: number }>;
}

/**
 * A fake with one user per role and a contact at a company.
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
  return {
    service,
    store,
    runtime,
    actor: (role) => actors.get(role)!,
    contactId: contact.id,
    companyId: contact.company!.id,
    deal: async ({ won = true, title = 'Renewal' } = {}) => {
      const created = await service.crm.createDeal(
        sales,
        {
          title,
          primaryContactId: contact.id,
          amountMinor: 1000,
          statusLine: null,
          nextActionText: null,
          nextActionDate: null,
          expectedCloseDate: null
        },
        key()
      );
      if (!won) {
        return created;
      }
      return service.crm.updateDeal(sales, created.id, { status: 'won' }, 1, key());
    }
  };
}

/**
 * Count the rows every conversion writes.
 *
 * @param store The fake's store.
 * @returns Row counts.
 */
function conversionRows(store: FakeStore) {
  return {
    projects: store.count('projects'),
    conversions: store.count('conversion_attempts'),
    linkedDeals: store.count('deals', 'project_id IS NOT NULL'),
    audit: store.count('audit_events', "action IN ('created-from-deal', 'converted')"),
    idempotency: store.count('idempotency_records', "operation = 'projects.convertDeal'")
  };
}

describe('convertDeal', () => {
  it('turns a won deal into one linked project, with the customer copied from the deal', async () => {
    const { service, store, actor, deal, contactId, companyId } = await world();
    const won = await deal();
    const project = await service.projects.convertDeal(
      actor('sales'),
      won.id,
      {},
      won.version,
      key()
    );
    expect(project).toMatchObject({
      name: 'Renewal',
      status: 'active',
      sourceDeal: { id: won.id, title: 'Renewal' },
      company: { id: companyId, name: 'Engines' },
      primaryContact: { id: contactId, displayName: 'Ada' },
      lead: { id: actor('sales').userId },
      taskCounts: { todo: 0, in_progress: 0, in_review: 0, done: 0 },
      version: 1
    });
    expect(conversionRows(store)).toEqual({
      projects: 1,
      conversions: 1,
      linkedDeals: 1,
      audit: 2,
      idempotency: 1
    });
    // The deal shows the link, the project reads back identically, and both customer timelines list it.
    const reader = actor('read-only');
    expect((await service.crm.getDeal(reader, won.id)).deal.project).toEqual({
      id: project.id,
      name: 'Renewal'
    });
    expect((await service.projects.getProject(reader, project.id)).project).toEqual(project);
    expect((await service.crm.getContact(reader, contactId)).projects.map((p) => p.id)).toEqual([
      project.id
    ]);
    expect((await service.crm.getCompany(reader, companyId)).projects.map((p) => p.id)).toEqual([
      project.id
    ]);
  });

  it('accepts a name, another lead, and a target date', async () => {
    const { service, actor, deal } = await world();
    const won = await deal();
    const project = await service.projects.convertDeal(
      actor('sales'),
      won.id,
      { name: 'Renewal delivery', leadId: actor('delivery').userId, targetDate: '2026-12-01' },
      won.version,
      key()
    );
    expect(project).toMatchObject({
      name: 'Renewal delivery',
      lead: { id: actor('delivery').userId },
      targetDate: '2026-12-01'
    });
  });

  it('rejects pending, lost, and already-converted deals with CONFLICT', async () => {
    const { service, store, actor, deal } = await world();
    const pending = await deal({ won: false });
    expect(
      await failure(service.projects.convertDeal(actor('sales'), pending.id, {}, 1, key()))
    ).toMatchObject({
      code: 'CONFLICT',
      message: 'Only a won deal can be converted into a project.'
    });
    const lost = await service.crm.updateDeal(
      actor('sales'),
      pending.id,
      { status: 'lost' },
      1,
      key()
    );
    expect(
      (
        await failure(
          service.projects.convertDeal(actor('sales'), lost.id, {}, lost.version, key())
        )
      ).code
    ).toBe('CONFLICT');

    const won = await deal();
    await service.projects.convertDeal(actor('sales'), won.id, {}, won.version, key());
    // The caller still holds the pre-conversion version; "already converted" wins over "stale".
    expect(
      await failure(service.projects.convertDeal(actor('sales'), won.id, {}, won.version, key()))
    ).toMatchObject({ code: 'CONFLICT', message: /already been converted/u });
    expect(store.count('projects')).toBe(1);
  });

  it('rejects a stale version, an absent deal, invalid input, and a forbidden caller', async () => {
    const { service, store, actor, deal } = await world();
    const won = await deal();
    expect(
      (await failure(service.projects.convertDeal(actor('sales'), won.id, {}, 1, key()))).code
    ).toBe('VERSION_MISMATCH');
    expect(
      (
        await failure(
          service.projects.convertDeal(actor('sales'), crypto.randomUUID(), {}, 1, key())
        )
      ).code
    ).toBe('NOT_FOUND');
    expect(
      (
        await failure(
          service.projects.convertDeal(
            actor('sales'),
            won.id,
            { targetDate: '2026-10-01' },
            won.version,
            key()
          )
        )
      ).fields
    ).toHaveProperty('targetDate');
    expect(
      (
        await failure(
          service.projects.convertDeal(
            actor('sales'),
            won.id,
            { leadId: crypto.randomUUID() },
            won.version,
            key()
          )
        )
      ).fields
    ).toHaveProperty('leadId');
    expect(
      (
        await failure(
          service.projects.convertDeal(
            actor('sales'),
            won.id,
            { sourceDealId: won.id } as never,
            won.version,
            key()
          )
        )
      ).code
    ).toBe('VALIDATION_FAILED');
    for (const role of ['delivery', 'read-only'] as const) {
      expect(
        (await failure(service.projects.convertDeal(actor(role), won.id, {}, won.version, key())))
          .code
      ).toBe('FORBIDDEN');
    }
    expect(store.count('projects')).toBe(0);
  });

  it('replays a lost-response retry and refuses the key for a different request', async () => {
    const { service, store, actor, deal } = await world();
    const won = await deal();
    const meta = key();
    const first = await service.projects.convertDeal(actor('sales'), won.id, {}, won.version, meta);
    // The retry still carries the pre-conversion version; the replay ignores it.
    expect(
      await service.projects.convertDeal(actor('sales'), won.id, {}, won.version, meta)
    ).toEqual(first);
    expect(
      (
        await failure(
          service.projects.convertDeal(actor('sales'), won.id, { name: 'Else' }, won.version, meta)
        )
      ).code
    ).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(store.count('projects')).toBe(1);
  });

  it('keeps a converted deal won, so delivery cannot be detached later', async () => {
    const { service, actor, deal } = await world();
    const won = await deal();
    const project = await service.projects.convertDeal(
      actor('sales'),
      won.id,
      {},
      won.version,
      key()
    );
    expect(
      (
        await failure(
          service.crm.updateDeal(
            actor('sales'),
            won.id,
            { status: 'pending' },
            won.version + 1,
            key()
          )
        )
      ).code
    ).toBe('CONFLICT');
    expect((await service.crm.getDeal(actor('sales'), won.id)).deal.project?.id).toBe(project.id);
  });

  it('rolls back every row when the write set fails at any statement', async () => {
    const { service, store, actor, deal } = await world();
    const won = await deal();
    const before = conversionRows(store);
    // Learn the write set's size by committing one conversion of another deal, then remove nothing:
    // the probe deal is separate, so the counts below are compared against `before` plus the probe.
    const probe = await deal({ title: 'Probe' });
    await service.projects.convertDeal(actor('sales'), probe.id, {}, probe.version, key());
    const statements = store.lastWriteSetSize;
    expect(statements).toBeGreaterThanOrEqual(7);
    const afterProbe = conversionRows(store);
    expect(afterProbe.projects).toBe(before.projects + 1);

    for (let index = 0; index < statements; index++) {
      store.failNextWriteAt(index);
      const error = await failure(
        service.projects.convertDeal(actor('sales'), won.id, {}, won.version, key())
      );
      expect(error.code, `statement ${index}`).toBe('DEPENDENCY_FAILURE');
      expect(conversionRows(store), `statement ${index}`).toEqual(afterProbe);
    }
    // After all of that, the deal is still convertible exactly once.
    const project = await service.projects.convertDeal(
      actor('sales'),
      won.id,
      {},
      won.version,
      key()
    );
    expect((await service.crm.getDeal(actor('sales'), won.id)).deal.project?.id).toBe(project.id);
  });

  it('rolls back when a concurrent conversion or reopen wins between read and commit', async () => {
    const { service, store, actor, deal } = await world();
    const won = await deal();
    store.beforeNextCommit((db) => {
      db.prepare(
        "UPDATE deals SET status = 'pending', closed_at = NULL, version = version + 1 WHERE id = ?"
      ).run(won.id);
    });
    expect(
      (await failure(service.projects.convertDeal(actor('sales'), won.id, {}, won.version, key())))
        .code
    ).toBe('VERSION_MISMATCH');
    expect(conversionRows(store)).toMatchObject({ projects: 0, conversions: 0, linkedDeals: 0 });

    const other = await deal({ title: 'Raced' });
    store.beforeNextCommit((db) => {
      // Another request converted it first: the unique source-deal index rejects our project.
      const now = '2026-10-11T09:00:00.000Z';
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO projects (id, name, status, source_deal_id, lead_id, version, created_at, updated_at)
         VALUES (?, 'Theirs', 'active', ?, ?, 1, ?, ?)`
      ).run(id, other.id, actor('manager').userId, now, now);
    });
    expect(
      (
        await failure(
          service.projects.convertDeal(actor('sales'), other.id, {}, other.version, key())
        )
      ).code
    ).toBe('CONFLICT');
    expect(store.count('projects', "name = 'Theirs'")).toBe(1);
    expect(store.count('conversion_attempts')).toBe(0);
  });

  it('fails closed when storage is unavailable', async () => {
    const { service, store, actor, deal } = await world();
    const won = await deal();
    store.failing = true;
    expect(
      await failure(service.projects.convertDeal(actor('sales'), won.id, {}, won.version, key()))
    ).toMatchObject({ code: 'DEPENDENCY_FAILURE', retryable: true });
  });
});

/**
 * A world with one converted project.
 *
 * @returns The world and the project.
 */
async function withProject() {
  const w = await world();
  const won = await w.deal();
  const project = await w.service.projects.convertDeal(
    w.actor('sales'),
    won.id,
    {},
    won.version,
    key()
  );
  return { ...w, project };
}

describe('projects', () => {
  it('lists, searches, filters, and pages by name', async () => {
    const { service, actor, deal } = await world();
    for (const title of ['charlie', 'Alpha', 'bravo']) {
      const won = await deal({ title });
      await service.projects.convertDeal(actor('sales'), won.id, {}, won.version, key());
    }
    const first = await service.projects.listProjects(actor('read-only'), { limit: 2 });
    expect(first.items.map((p) => p.name)).toEqual(['Alpha', 'bravo']);
    const second = await service.projects.listProjects(actor('read-only'), {
      limit: 2,
      cursor: first.nextCursor ?? ''
    });
    expect(second).toMatchObject({ items: [{ name: 'charlie' }], nextCursor: null });
    expect(
      (await service.projects.listProjects(actor('sales'), { q: 'engines', limit: 10 })).items
    ).toHaveLength(3);
    expect(
      (await service.projects.listProjects(actor('sales'), { status: 'archived', limit: 10 })).items
    ).toEqual([]);
    expect(await service.projects.listProjects(actor('sales'), undefined as never)).toMatchObject({
      nextCursor: null
    });
    expect(
      (
        await failure(
          service.projects.listProjects(actor('sales'), { status: 'open' as never, limit: 5 })
        )
      ).code
    ).toBe('VALIDATION_FAILED');
  });

  it('reports a missing project', async () => {
    const { service, actor } = await world();
    expect(
      (await failure(service.projects.getProject(actor('sales'), crypto.randomUUID()))).code
    ).toBe('NOT_FOUND');
  });

  it('lets delivery edit ordinary fields but requires manage to archive or change the lead', async () => {
    const { service, store, actor, project } = await withProject();
    const edited = await service.projects.updateProject(
      actor('delivery'),
      project.id,
      { description: 'Phase one', status: 'on_hold', targetDate: '2026-11-30' },
      1,
      key()
    );
    expect(edited).toMatchObject({ description: 'Phase one', status: 'on_hold', version: 2 });
    expect(store.audit.at(-1)?.action).toBe('status-on_hold');
    for (const change of [{ status: 'archived' as const }, { leadId: actor('delivery').userId }]) {
      expect(
        (
          await failure(
            service.projects.updateProject(actor('delivery'), project.id, change, 2, key())
          )
        ).code
      ).toBe('FORBIDDEN');
    }
    const archived = await service.projects.updateProject(
      actor('manager'),
      project.id,
      { status: 'archived' },
      2,
      key()
    );
    expect(store.audit.at(-1)?.action).toBe('archived');
    // An archived project is read-only until a manager unarchives it.
    expect(
      (
        await failure(
          service.projects.updateProject(actor('manager'), project.id, { name: 'x' }, 3, key())
        )
      ).code
    ).toBe('CONFLICT');
    const restored = await service.projects.updateProject(
      actor('manager'),
      project.id,
      { status: 'active', leadId: actor('delivery').userId },
      archived.version,
      key()
    );
    expect(restored).toMatchObject({ status: 'active', lead: { id: actor('delivery').userId } });
    expect(store.audit.at(-1)?.action).toBe('unarchived');
  });

  it('rejects stale versions, absent projects, invalid fields, sales writers, and lost races', async () => {
    const { service, store, actor, project } = await withProject();
    expect(
      (
        await failure(
          service.projects.updateProject(actor('sales'), project.id, { name: 'x' }, 1, key())
        )
      ).code
    ).toBe('FORBIDDEN');
    expect(
      (
        await failure(
          service.projects.updateProject(
            actor('delivery'),
            crypto.randomUUID(),
            { name: 'x' },
            1,
            key()
          )
        )
      ).code
    ).toBe('NOT_FOUND');
    expect(
      (await failure(service.projects.updateProject(actor('delivery'), project.id, {}, 1, key())))
        .code
    ).toBe('VALIDATION_FAILED');
    expect(
      (
        await failure(
          service.projects.updateProject(
            actor('delivery'),
            project.id,
            { targetDate: '2026-01-01' },
            1,
            key()
          )
        )
      ).fields
    ).toHaveProperty('targetDate');
    expect(
      (
        await failure(
          service.projects.updateProject(
            actor('manager'),
            project.id,
            { leadId: crypto.randomUUID() },
            1,
            key()
          )
        )
      ).fields
    ).toHaveProperty('leadId');
    const meta = key();
    const renamed = await service.projects.updateProject(
      actor('delivery'),
      project.id,
      { name: 'Renamed' },
      1,
      meta
    );
    expect(
      await service.projects.updateProject(
        actor('delivery'),
        project.id,
        { name: 'Renamed' },
        1,
        meta
      )
    ).toEqual(renamed);
    expect(
      (
        await failure(
          service.projects.updateProject(actor('delivery'), project.id, { name: 'Again' }, 1, key())
        )
      ).code
    ).toBe('VERSION_MISMATCH');
    store.beforeNextCommit((db) => {
      db.prepare("UPDATE projects SET version = 9, name = 'Theirs' WHERE id = ?").run(project.id);
    });
    expect(
      (
        await failure(
          service.projects.updateProject(actor('delivery'), project.id, { name: 'Ours' }, 2, key())
        )
      ).code
    ).toBe('VERSION_MISMATCH');
    expect(store.count('projects', "name = 'Theirs'")).toBe(1);
  });
});

describe('tasks', () => {
  it('creates tasks at the end of their column and returns them in board order', async () => {
    const { service, actor, project } = await withProject();
    const delivery = actor('delivery');
    const first = await service.projects.createTask(
      delivery,
      project.id,
      {
        title: 'Kickoff',
        description: null,
        status: 'todo',
        priority: 'high',
        assigneeId: delivery.userId,
        dueDate: '2026-10-12'
      },
      key()
    );
    const second = await service.projects.createTask(
      delivery,
      project.id,
      {
        title: 'Plan',
        description: 'Outline',
        status: 'todo',
        priority: 'no_priority',
        assigneeId: null,
        dueDate: null
      },
      key()
    );
    const doing = await service.projects.createTask(
      delivery,
      project.id,
      {
        title: 'Build',
        description: null,
        status: 'in_progress',
        priority: 'urgent',
        assigneeId: null,
        dueDate: null
      },
      key()
    );
    const finished = await service.projects.createTask(
      delivery,
      project.id,
      {
        title: 'Contract',
        description: null,
        status: 'done',
        priority: 'low',
        assigneeId: null,
        dueDate: null
      },
      key()
    );
    expect(first).toMatchObject({
      position: 0,
      assignee: { id: delivery.userId },
      createdBy: { id: delivery.userId },
      completedAt: null,
      project: { id: project.id, name: project.name }
    });
    expect(second.position).toBeGreaterThan(first.position);
    expect(finished.completedAt).toMatch(/^2026-10-11T/u);
    const detail = await service.projects.getProject(actor('read-only'), project.id);
    expect(detail.tasks.map((task) => task.id)).toEqual([
      first.id,
      second.id,
      doing.id,
      finished.id
    ]);
    expect(detail.project.taskCounts).toEqual({ todo: 2, in_progress: 1, in_review: 0, done: 1 });
    expect(detail.history.length).toBeGreaterThan(0);
  });

  it('moves a task between columns, stamping and clearing completion', async () => {
    const { service, store, actor, project } = await withProject();
    const delivery = actor('delivery');
    const task = await service.projects.createTask(
      delivery,
      project.id,
      {
        title: 'Ship',
        description: null,
        status: 'todo',
        priority: 'medium',
        assigneeId: null,
        dueDate: null
      },
      key()
    );
    const done = await service.projects.updateTask(delivery, task.id, { status: 'done' }, 1, key());
    expect(done).toMatchObject({ status: 'done', version: 2, position: 0 });
    expect(done.completedAt).toMatch(/^2026-10-11T/u);
    expect(store.audit.at(-1)?.action).toBe('moved-done');
    const retitled = await service.projects.updateTask(
      delivery,
      task.id,
      { title: 'Shipped' },
      2,
      key()
    );
    expect(retitled.completedAt).toBe(done.completedAt);
    expect(store.audit.at(-1)?.action).toBe('updated');
    const reopened = await service.projects.updateTask(
      delivery,
      task.id,
      {
        status: 'in_review',
        priority: 'urgent',
        assigneeId: delivery.userId,
        dueDate: '2026-10-20',
        description: 'Check'
      },
      3,
      key()
    );
    expect(reopened).toMatchObject({
      status: 'in_review',
      completedAt: null,
      priority: 'urgent',
      assignee: { id: delivery.userId },
      description: 'Check'
    });
    const unassigned = await service.projects.updateTask(
      delivery,
      task.id,
      { assigneeId: null },
      4,
      key()
    );
    expect(unassigned.assignee).toBeNull();
  });

  it('rejects invalid input, past dates, unknown assignees, absent records, and stale versions', async () => {
    const { service, actor, project } = await withProject();
    const delivery = actor('delivery');
    const base = {
      title: 'x',
      description: null,
      status: 'todo' as const,
      priority: 'low' as const,
      assigneeId: null,
      dueDate: null
    };
    expect(
      (
        await failure(
          service.projects.createTask(
            delivery,
            project.id,
            { ...base, priority: 'p1' } as never,
            key()
          )
        )
      ).fields
    ).toHaveProperty('priority');
    expect(
      (
        await failure(
          service.projects.createTask(delivery, project.id, { ...base, title: '' }, key())
        )
      ).fields
    ).toHaveProperty('title');
    expect(
      (
        await failure(
          service.projects.createTask(
            delivery,
            project.id,
            { ...base, dueDate: '2026-10-01' },
            key()
          )
        )
      ).fields
    ).toHaveProperty('dueDate');
    expect(
      (
        await failure(
          service.projects.createTask(
            delivery,
            project.id,
            { ...base, assigneeId: crypto.randomUUID() },
            key()
          )
        )
      ).fields
    ).toHaveProperty('assigneeId');
    expect(
      (await failure(service.projects.createTask(delivery, crypto.randomUUID(), base, key()))).code
    ).toBe('NOT_FOUND');
    const task = await service.projects.createTask(delivery, project.id, base, key());
    expect(
      (
        await failure(
          service.projects.updateTask(delivery, task.id, { status: 'blocked' } as never, 1, key())
        )
      ).code
    ).toBe('VALIDATION_FAILED');
    expect(
      (
        await failure(
          service.projects.updateTask(delivery, task.id, { dueDate: '2026-10-01' }, 1, key())
        )
      ).fields
    ).toHaveProperty('dueDate');
    expect(
      (
        await failure(
          service.projects.updateTask(
            delivery,
            task.id,
            { assigneeId: crypto.randomUUID() },
            1,
            key()
          )
        )
      ).fields
    ).toHaveProperty('assigneeId');
    expect(
      (
        await failure(
          service.projects.updateTask(delivery, crypto.randomUUID(), { title: 'y' }, 1, key())
        )
      ).code
    ).toBe('NOT_FOUND');
    await service.projects.updateTask(delivery, task.id, { title: 'y' }, 1, key());
    expect(
      (await failure(service.projects.updateTask(delivery, task.id, { title: 'z' }, 1, key()))).code
    ).toBe('VERSION_MISMATCH');
  });

  it('denies sales and read-only writers, and refuses tasks on an archived project', async () => {
    const { service, actor, project } = await withProject();
    const base = {
      title: 'x',
      description: null,
      status: 'todo' as const,
      priority: 'low' as const,
      assigneeId: null,
      dueDate: null
    };
    for (const role of ['sales', 'read-only'] as const) {
      expect(
        (await failure(service.projects.createTask(actor(role), project.id, base, key()))).code
      ).toBe('FORBIDDEN');
    }
    const task = await service.projects.createTask(actor('delivery'), project.id, base, key());
    expect(
      (
        await failure(
          service.projects.updateTask(actor('read-only'), task.id, { title: 'y' }, 1, key())
        )
      ).code
    ).toBe('FORBIDDEN');
    await service.projects.updateProject(
      actor('manager'),
      project.id,
      { status: 'archived' },
      1,
      key()
    );
    expect(
      (await failure(service.projects.createTask(actor('delivery'), project.id, base, key()))).code
    ).toBe('CONFLICT');
    expect(
      (
        await failure(
          service.projects.updateTask(actor('delivery'), task.id, { title: 'y' }, 1, key())
        )
      ).code
    ).toBe('CONFLICT');
  });

  it('rolls back a task when its project is archived between read and commit, and replays retries', async () => {
    const { service, store, actor, project } = await withProject();
    const base = {
      title: 'Raced',
      description: null,
      status: 'todo' as const,
      priority: 'low' as const,
      assigneeId: null,
      dueDate: null
    };
    store.beforeNextCommit((db) => {
      db.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(project.id);
    });
    expect(
      (await failure(service.projects.createTask(actor('delivery'), project.id, base, key()))).code
    ).toBe('CONFLICT');
    expect(store.count('tasks')).toBe(0);
    store.exec("UPDATE projects SET status = 'active' WHERE id = ?", project.id);
    const meta = key();
    const created = await service.projects.createTask(actor('delivery'), project.id, base, meta);
    expect(await service.projects.createTask(actor('delivery'), project.id, base, meta)).toEqual(
      created
    );
    const updateMeta = key();
    const updated = await service.projects.updateTask(
      actor('delivery'),
      created.id,
      { title: 'Two' },
      1,
      updateMeta
    );
    expect(
      await service.projects.updateTask(
        actor('delivery'),
        created.id,
        { title: 'Two' },
        1,
        updateMeta
      )
    ).toEqual(updated);
    expect(store.count('tasks')).toBe(1);
  });
});

describe('myWork', () => {
  it('lists my open tasks: dated by date then priority, undated last, excluding done and archived', async () => {
    const { service, runtime, actor, project, deal } = await withProject();
    const delivery = actor('delivery');
    const make = (title: string, overrides: Record<string, unknown>, projectId = project.id) =>
      service.projects.createTask(
        delivery,
        projectId,
        {
          title,
          description: null,
          status: 'todo',
          priority: 'no_priority',
          assigneeId: delivery.userId,
          dueDate: null,
          ...overrides
        },
        key()
      );
    await make('Undated urgent', { priority: 'urgent' });
    await make('Tomorrow low', { dueDate: '2026-10-12', priority: 'low' });
    await make('Tomorrow high', { dueDate: '2026-10-12', priority: 'high' });
    await make('Today', { dueDate: '2026-10-11' });
    await make('Finished', { status: 'done', dueDate: '2026-10-11' });
    await make('Someone else', { assigneeId: actor('manager').userId });
    const otherDeal = await deal({ title: 'Archived later' });
    const other = await service.projects.convertDeal(
      actor('sales'),
      otherDeal.id,
      {},
      otherDeal.version,
      key()
    );
    await make('In archived project', { dueDate: '2026-10-11' }, other.id);
    await service.projects.updateProject(
      actor('manager'),
      other.id,
      { status: 'archived' },
      1,
      key()
    );

    runtime.set(new Date('2026-10-12T09:00:00.000Z'));
    const work = await service.projects.myWork(delivery);
    expect(work.today).toBe('2026-10-12');
    expect(work.items.map((task) => task.title)).toEqual([
      'Today',
      'Tomorrow high',
      'Tomorrow low',
      'Undated urgent'
    ]);
    expect((await service.projects.myWork(actor('read-only'))).items).toEqual([]);
  });
});
