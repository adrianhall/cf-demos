/**
 * @file Business-health reports through the public data-service interface over the production
 *   repositories on in-memory SQLite: the pipeline report's owner and close-date filters (in the
 *   installation's time zone), the delivery report's totals, overdue counting, ordering, and row
 *   cap, invalid filters, forbidden callers, and storage failure. Also the pure time-zone helpers.
 */

import { describe, expect, it } from 'vitest';
import {
  calendarQuarter,
  closedWindow,
  parseQuarter,
  nextDate,
  openTasks,
  startOfLocalDay,
  sumTaskCounts
} from '../../../src/data-worker/domain/reports/reports.ts';
import {
  DELIVERY_REPORT_PROJECT_LIMIT,
  QUARTERLY_REPORT_DEAL_LIMIT
} from '../../../src/shared/api/reports.ts';
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
  return { idempotencyKey: `report-key-${++keyCounter}` };
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
 * A fake with one user per role and one contact.
 *
 * @returns The fixture.
 */
async function world() {
  const runtime = testRuntime(new Date('2026-10-11T09:00:00.000Z'));
  const { service, store } = createFakeDataService({ runtime });
  const actors = new Map<Role, ActorContext>();
  for (const role of ['owner', 'manager', 'sales', 'delivery', 'read-only'] as const) {
    const email = `${role}@example.com`;
    actors.set(role, {
      email,
      userId: store.addUser(email, role),
      requestId: role,
      channel: 'api'
    });
  }
  const actor = (role: Role): ActorContext => actors.get(role)!;
  const contact = await service.crm.createContact(
    actor('sales'),
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
  const deal = (owner: Role, amountMinor: number, title = 'Deal') =>
    service.crm.createDeal(
      actor(owner),
      {
        title,
        primaryContactId: contact.id,
        amountMinor,
        statusLine: null,
        nextActionText: null,
        nextActionDate: null,
        expectedCloseDate: null
      },
      key()
    );
  return { service, store, runtime, actor, deal };
}

describe('report time-zone helpers', () => {
  it('maps London calendar days to UTC across both daylight-saving changes', () => {
    expect(startOfLocalDay('2026-10-01', 'Europe/London')).toBe('2026-09-30T23:00:00.000Z');
    expect(startOfLocalDay('2026-12-01', 'Europe/London')).toBe('2026-12-01T00:00:00.000Z');
    expect(startOfLocalDay('2026-03-29', 'Europe/London')).toBe('2026-03-29T00:00:00.000Z');
    expect(startOfLocalDay('2026-10-25', 'Europe/London')).toBe('2026-10-24T23:00:00.000Z');
    expect(startOfLocalDay('2026-10-01', 'Asia/Kolkata')).toBe('2026-09-30T18:30:00.000Z');
    expect(nextDate('2026-12-31')).toBe('2027-01-01');
    expect(closedWindow('2026-10-01', '2026-10-31', 'Europe/London')).toEqual({
      from: '2026-09-30T23:00:00.000Z',
      before: '2026-11-01T00:00:00.000Z'
    });
    expect(closedWindow(undefined, undefined, 'Europe/London')).toEqual({
      from: null,
      before: null
    });
  });

  it('sums task counts', () => {
    const counts = sumTaskCounts([
      { todo: 1, in_progress: 2, in_review: 3, done: 4 },
      { todo: 1, in_progress: 0, in_review: 0, done: 1 }
    ]);
    expect(counts).toEqual({ todo: 2, in_progress: 2, in_review: 3, done: 5 });
    expect(openTasks(counts)).toBe(7);
  });
});

describe('calendarQuarter', () => {
  it('maps every month to its calendar quarter, including leap-year February', () => {
    expect(calendarQuarter('2026-01-01')).toEqual({
      from: '2026-01-01',
      to: '2026-03-31',
      label: 'Q1 2026',
      id: '2026-Q1'
    });
    expect(calendarQuarter('2028-02-29')).toMatchObject({ from: '2028-01-01', to: '2028-03-31' });
    expect(calendarQuarter('2026-06-30')).toEqual({
      from: '2026-04-01',
      to: '2026-06-30',
      label: 'Q2 2026',
      id: '2026-Q2'
    });
    expect(calendarQuarter('2026-07-01')).toMatchObject({ to: '2026-09-30', label: 'Q3 2026' });
    expect(calendarQuarter('2026-12-31')).toEqual({
      from: '2026-10-01',
      to: '2026-12-31',
      label: 'Q4 2026',
      id: '2026-Q4'
    });
    expect(parseQuarter('2028-Q1')).toEqual(calendarQuarter('2028-02-29'));
  });
});

describe('pipeline this quarter', () => {
  it('counts open deals expected to close in the local quarter, honouring the owner filter', async () => {
    const { service, store, runtime, actor, deal } = await world();
    const inQuarter = await deal('sales', 100, 'In Q4');
    const lastDay = await deal('manager', 200, 'Last day of Q4');
    const nextQuarter = await deal('sales', 400, 'Q1 next year');
    // Undated: no expected close date, so never in a quarter.
    await deal('sales', 800, 'No expected close');
    const won = await deal('sales', 1600, 'Won in Q4');
    for (const [row, date] of [
      [inQuarter, '2026-10-20'],
      [lastDay, '2026-12-31'],
      [nextQuarter, '2027-01-01'],
      [won, '2026-11-01']
    ] as const) {
      store.exec('UPDATE deals SET expected_close_date = ? WHERE id = ?', date, row.id);
    }
    await service.crm.updateDeal(actor('sales'), won.id, { status: 'won' }, 1, key());

    const summary = await service.crm.pipelineSummary(actor('read-only'));
    expect(summary.thisQuarter).toEqual({
      id: '2026-Q4',
      label: 'Q4 2026',
      from: '2026-10-01',
      to: '2026-12-31',
      count: 2,
      amountMinor: 300
    });
    const mine = await service.crm.pipelineReport(actor('manager'), {
      ownerId: actor('manager').userId
    });
    expect(mine.thisQuarter).toMatchObject({ count: 1, amountMinor: 200 });

    // The quarter follows the installation's calendar, not UTC: 23:30 UTC on 30 June is already
    // 00:30 on 1 July in London (British Summer Time), so it is Q3 there.
    runtime.set(new Date('2026-06-30T23:30:00.000Z'));
    expect((await service.crm.pipelineSummary(actor('owner'))).thisQuarter.label).toBe('Q3 2026');
  });
});

describe('quarterlyPipeline', () => {
  it('totals and lists open deals expected to close in the chosen quarter, by stage', async () => {
    const { service, store, actor, deal } = await world();
    const pipeline = await service.crm.getPipeline(actor('sales'));
    const rows = [
      ['B later', 'sales', '2026-12-31', 0],
      ['A early', 'manager', '2026-10-02', 1],
      ['Next quarter', 'sales', '2027-01-01', 0],
      ['Won in quarter', 'sales', '2026-11-01', 0]
    ] as const;
    const made = [];
    for (const [title, owner, date, stage] of rows) {
      const created = await deal(owner, 100, title);
      store.exec(
        'UPDATE deals SET expected_close_date = ?, stage_id = ? WHERE id = ?',
        date,
        pipeline.stages[stage]!.id,
        created.id
      );
      made.push(created);
    }
    await service.crm.updateDeal(actor('sales'), made[3]!.id, { status: 'won' }, 1, key());

    const current = await service.crm.quarterlyPipeline(actor('read-only'), {});
    expect(current.quarter).toEqual({
      id: '2026-Q4',
      label: 'Q4 2026',
      from: '2026-10-01',
      to: '2026-12-31'
    });
    expect(current.deals.map((item) => item.title)).toEqual(['A early', 'B later']);
    expect(current.stages.map((row) => row.count)).toEqual([1, 1, 0, 0]);
    expect(current.total).toEqual({ count: 2, amountMinor: 200 });
    expect(current).toMatchObject({ truncated: false, owner: null, currency: 'GBP' });

    const next = await service.crm.quarterlyPipeline(actor('owner'), { quarter: '2027-Q1' });
    expect(next.deals.map((item) => item.title)).toEqual(['Next quarter']);
    const mine = await service.crm.quarterlyPipeline(actor('manager'), {
      ownerId: actor('manager').userId
    });
    expect(mine.deals.map((item) => item.title)).toEqual(['A early']);
    expect(mine.owner).toEqual({ id: actor('manager').userId, displayName: 'manager' });
  });

  it('caps the listed deals while totals cover every match', async () => {
    const { service, store, actor, deal } = await world();
    for (let index = 0; index <= QUARTERLY_REPORT_DEAL_LIMIT; index++) {
      const created = await deal('sales', 1, `Deal ${String(index).padStart(3, '0')}`);
      store.exec('UPDATE deals SET expected_close_date = ? WHERE id = ?', '2026-11-15', created.id);
    }
    const report = await service.crm.quarterlyPipeline(actor('sales'), {});
    expect(report.deals).toHaveLength(QUARTERLY_REPORT_DEAL_LIMIT);
    expect(report.truncated).toBe(true);
    expect(report.total.count).toBe(QUARTERLY_REPORT_DEAL_LIMIT + 1);
  });

  it('refuses a malformed quarter or unknown owner, and needs report.read', async () => {
    const { service, store, actor } = await world();
    expect(
      await failure(service.crm.quarterlyPipeline(actor('sales'), { quarter: '2026-Q5' }))
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(
      await failure(service.crm.quarterlyPipeline(actor('sales'), { ownerId: crypto.randomUUID() }))
    ).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: { ownerId: 'That person is not on the team.' }
    });
    const nobody = actor('read-only');
    store.setRoles(nobody.userId, []);
    expect(await failure(service.crm.quarterlyPipeline(nobody, {}))).toMatchObject({
      code: 'FORBIDDEN'
    });
  });
});

describe('pipelineReport', () => {
  it('filters by owner and by close date in the installation time zone', async () => {
    const { service, store, actor, deal } = await world();
    await deal('sales', 100);
    await deal('manager', 200);
    const early = await deal('sales', 1000, 'Closed at 23:30 UTC on 30 Sep = 1 Oct in London');
    const late = await deal('sales', 5000, 'Closed in September');
    for (const won of [early, late]) {
      await service.crm.updateDeal(actor('sales'), won.id, { status: 'won' }, 1, key());
    }
    store.exec('UPDATE deals SET closed_at = ? WHERE id = ?', '2026-09-30T23:30:00.000Z', early.id);
    store.exec('UPDATE deals SET closed_at = ? WHERE id = ?', '2026-09-30T22:30:00.000Z', late.id);

    const all = await service.crm.pipelineReport(actor('read-only'), {});
    expect(all.open).toEqual({ count: 2, amountMinor: 300 });
    expect(all.won).toEqual({ count: 2, amountMinor: 6000 });
    expect(all.filter).toEqual({ owner: null, closedFrom: null, closedTo: null });

    const october = await service.crm.pipelineReport(actor('owner'), {
      closedFrom: '2026-10-01',
      closedTo: '2026-10-31'
    });
    // The window narrows won/lost only; open deals have no close date.
    expect(october.open).toEqual({ count: 2, amountMinor: 300 });
    expect(october.won).toEqual({ count: 1, amountMinor: 1000 });

    const mine = await service.crm.pipelineReport(actor('manager'), {
      ownerId: actor('manager').userId
    });
    expect(mine.open).toEqual({ count: 1, amountMinor: 200 });
    expect(mine.won).toEqual({ count: 0, amountMinor: 0 });
    expect(mine.filter.owner).toEqual({ id: actor('manager').userId, displayName: 'manager' });
  });

  it('rejects reversed, over-long, or unknown filters and denies callers without report.read', async () => {
    const { service, store, actor } = await world();
    const reader = actor('read-only');
    expect(
      await failure(
        service.crm.pipelineReport(reader, { closedFrom: '2026-10-02', closedTo: '2026-10-01' })
      )
    ).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: { closedTo: 'The end date must not be before the start date.' }
    });
    expect(
      (
        await failure(
          service.crm.pipelineReport(reader, { closedFrom: '2025-01-01', closedTo: '2026-10-01' })
        )
      ).fields
    ).toEqual({ closedTo: 'Choose a window of at most 366 days.' });
    expect(
      (
        await failure(
          service.crm.pipelineReport(reader, { ownerId: '00000000-0000-4000-8000-00000000ffff' })
        )
      ).fields
    ).toEqual({ ownerId: 'That person is not on the team.' });
    expect((await failure(service.crm.pipelineReport(reader, { secret: 1 } as never))).code).toBe(
      'VALIDATION_FAILED'
    );
    store.exec("DELETE FROM role_permissions WHERE permission = 'report.read'");
    expect((await failure(service.crm.pipelineReport(reader, {}))).code).toBe('FORBIDDEN');
  });

  it('fails closed as a retryable dependency failure when storage is down', async () => {
    const { service, store, actor } = await world();
    store.failing = true;
    expect(await failure(service.crm.pipelineReport(actor('owner'), {}))).toMatchObject({
      code: 'DEPENDENCY_FAILURE',
      retryable: true
    });
  });
});

describe('deliveryReport', () => {
  it('totals task counts across active projects, most open work first', async () => {
    const { service, actor, deal } = await world();
    const owner = actor('owner');
    const busy = await service.projects.convertDeal(
      owner,
      (await deal('sales', 0, 'Busy')).id,
      { markWon: true, name: 'Busy project' },
      1,
      key()
    );
    const quiet = await service.projects.convertDeal(
      owner,
      (await deal('sales', 0, 'Quiet')).id,
      { markWon: true, name: 'Quiet project' },
      1,
      key()
    );
    const task = (projectId: string, status: string, dueDate: string | null) =>
      service.projects.createTask(
        owner,
        projectId,
        {
          title: 'T',
          description: null,
          status: status as 'todo',
          priority: 'low',
          assigneeId: null,
          dueDate
        },
        key()
      );
    await task(busy.id, 'todo', null);
    await task(busy.id, 'in_progress', null);
    await task(busy.id, 'in_review', null);
    await task(quiet.id, 'done', null);
    await task(quiet.id, 'todo', null);
    await task(busy.id, 'done', '2026-10-11');

    const report = await service.projects.deliveryReport(actor('read-only'), {});
    expect(report.today).toBe('2026-10-11');
    expect(report.filter).toEqual({ projectStatus: 'active', lead: null });
    expect(report.projectCount).toBe(2);
    expect(report.taskCounts).toEqual({ todo: 2, in_progress: 1, in_review: 1, done: 2 });
    expect(report.overdue).toBe(0);
    expect(report.projects.map((row) => row.project.name)).toEqual([
      'Busy project',
      'Quiet project'
    ]);
    expect(report.truncated).toBe(false);

    const none = await service.projects.deliveryReport(actor('owner'), {
      projectStatus: 'completed'
    });
    expect(none).toMatchObject({ projectCount: 0, overdue: 0, projects: [] });
    const led = await service.projects.deliveryReport(actor('owner'), { leadId: owner.userId });
    expect(led.filter.lead?.id).toBe(owner.userId);
    expect(led.projectCount).toBe(2);
  });

  it('counts overdue unfinished tasks and caps the listed rows while totalling all', async () => {
    const { service, store, actor, deal } = await world();
    const owner = actor('owner');
    const project = await service.projects.convertDeal(
      owner,
      (await deal('sales', 0)).id,
      { markWon: true },
      1,
      key()
    );
    const make = (status: 'todo' | 'done') =>
      service.projects.createTask(
        owner,
        project.id,
        {
          title: 'T',
          description: null,
          status,
          priority: 'low',
          assigneeId: null,
          dueDate: '2026-10-11'
        },
        key()
      );
    const late = await make('todo');
    const finished = await make('done');
    store.exec("UPDATE tasks SET due_date = '2026-10-01' WHERE id IN (?, ?)", late.id, finished.id);
    const report = await service.projects.deliveryReport(owner, {});
    expect(report.overdue).toBe(1);
    expect(report.projects[0]?.overdue).toBe(1);

    // Many projects: totals cover all, rows are capped.
    const leadId = owner.userId;
    for (let index = 0; index < DELIVERY_REPORT_PROJECT_LIMIT + 2; index++) {
      store.exec(
        `INSERT INTO projects (id, name, status, lead_id, version, created_at, updated_at)
         VALUES (?, ?, 'active', ?, 1, 'x', 'x')`,
        crypto.randomUUID(),
        `Bulk ${index}`,
        leadId
      );
    }
    const big = await service.projects.deliveryReport(owner, {});
    expect(big.projectCount).toBe(DELIVERY_REPORT_PROJECT_LIMIT + 3);
    expect(big.projects).toHaveLength(DELIVERY_REPORT_PROJECT_LIMIT);
    expect(big.truncated).toBe(true);
    expect(big.projects[0]?.project.id).toBe(project.id);
  });

  it('rejects archived or unknown filters, an unknown lead, and callers without report.read', async () => {
    const { service, store, actor } = await world();
    const reader = actor('read-only');
    expect(
      (
        await failure(
          service.projects.deliveryReport(reader, { projectStatus: 'archived' } as never)
        )
      ).code
    ).toBe('VALIDATION_FAILED');
    expect(
      (
        await failure(
          service.projects.deliveryReport(reader, {
            projectStatus: 'active',
            leadId: '00000000-0000-4000-8000-00000000ffff'
          })
        )
      ).fields
    ).toEqual({ leadId: 'That person is not on the team.' });
    store.exec("DELETE FROM role_permissions WHERE permission = 'report.read'");
    expect((await failure(service.projects.deliveryReport(reader, {}))).code).toBe('FORBIDDEN');
    store.failing = true;
    expect((await failure(service.projects.deliveryReport(actor('owner'), {}))).code).toBe(
      'DEPENDENCY_FAILURE'
    );
  });
});
