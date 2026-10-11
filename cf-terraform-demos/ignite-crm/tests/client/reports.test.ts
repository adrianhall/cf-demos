/**
 * @file The Reports page and the customer overview timeline in the DOM, against the real API app
 *   and the SQLite-backed fake Data Worker: pipeline and delivery figures, URL-backed filters, a
 *   server validation error on the date field, independent failure of one report, the navigation
 *   entry, and the overview's merged timeline on contact and company pages.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VueWrapper } from '@vue/test-utils';
import App from '../../src/client/App.vue';
import { resetSession } from '../../src/client/composables/useSession.ts';
import type { ActorContext } from '../../src/shared/data-service/contract.ts';
import { createFakeDataService, testRuntime } from '../fakes/fake-data-service.ts';
import { mountWithApp, settle, useApi } from './support.ts';

let keyCounter = 0;

/**
 * A fresh idempotency key for seeding.
 *
 * @returns Mutation metadata.
 */
function key(): { idempotencyKey: string } {
  return { idempotencyKey: `reports-ui-${++keyCounter}` };
}

/**
 * A fake with a reader, a sales user, a contact, an open deal, and a won deal converted to a
 * project with tasks.
 *
 * @returns The fake and ids.
 */
async function seeded() {
  const fake = createFakeDataService({
    runtime: testRuntime(new Date('2026-10-11T09:00:00.000Z'))
  });
  fake.store.addUser('readonly@example.com', 'read-only');
  const sales: ActorContext = {
    email: 'sales@example.com',
    userId: fake.store.addUser('sales@example.com', 'sales'),
    requestId: 'seed',
    channel: 'api'
  };
  const owner: ActorContext = {
    email: 'owner@example.com',
    userId: fake.store.addUser('owner@example.com', 'owner'),
    requestId: 'seed',
    channel: 'api'
  };
  const contact = await fake.service.crm.createContact(
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
  const deal = (title: string, amountMinor: number, expectedCloseDate: string | null = null) =>
    fake.service.crm.createDeal(
      sales,
      {
        title,
        primaryContactId: contact.id,
        amountMinor,
        statusLine: null,
        nextActionText: null,
        nextActionDate: null,
        expectedCloseDate
      },
      key()
    );
  await deal('Open deal', 12_300);
  const project = await fake.service.projects.convertDeal(
    sales,
    (await deal('Won deal', 50_000)).id,
    { markWon: true, name: 'Engines rollout' },
    1,
    key()
  );
  for (const status of ['todo', 'in_progress', 'done'] as const) {
    await fake.service.projects.createTask(
      owner,
      project.id,
      {
        title: `Task ${status}`,
        description: null,
        status,
        priority: 'low',
        assigneeId: null,
        dueDate: null
      },
      key()
    );
  }
  return { ...fake, contact, project, sales, deal };
}

/**
 * Find an element by `aria-label`.
 *
 * @param label The label.
 * @returns The element.
 */
function labelled(label: string): HTMLElement {
  const element = document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (element === null) {
    throw new Error(`No element labelled "${label}"`);
  }
  return element;
}

/**
 * The Vuetify select with a given label.
 *
 * @param wrapper The app.
 * @param label Field label.
 * @returns The component wrapper.
 */
function select(wrapper: VueWrapper, label: string): VueWrapper {
  return wrapper
    .findAllComponents({ name: 'VSelect' })
    .find((candidate) => candidate.props('label') === label) as VueWrapper;
}

/**
 * The Vuetify text field with a given label.
 *
 * @param wrapper The app.
 * @param label Field label.
 * @returns The component wrapper.
 */
function textField(wrapper: VueWrapper, label: string): VueWrapper {
  return wrapper
    .findAllComponents({ name: 'VTextField' })
    .find((candidate) => candidate.props('label') === label) as VueWrapper;
}

beforeEach(() => {
  resetSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the reports page', () => {
  it('shows pipeline and delivery health, filters through the URL, and reports bad dates', async () => {
    const fake = await seeded();
    useApi('readonly@example.com', fake);
    const { wrapper, router } = await mountWithApp(App, { route: '/' });
    const nav = document.body.querySelector('nav')!;
    expect(nav.textContent).toContain('Reports');
    await router.push('/reports');
    await settle();
    expect(document.activeElement?.textContent).toBe('Reports');

    const pipeline = labelled('Pipeline by stage');
    expect(pipeline.textContent).toContain('Open pipeline');
    expect(pipeline.textContent).toContain('£123.00');
    expect(pipeline.textContent).toContain('£500.00');
    const delivery = labelled('Delivery by project');
    expect(delivery.textContent).toContain('Engines rollout');
    expect(document.body.textContent).toContain('1 project, 3 tasks');
    expect(labelled('Done: 1 of 3 tasks')).toBeTruthy();

    select(wrapper, 'Deal owner').vm.$emit('update:modelValue', fake.sales.userId);
    await settle();
    expect(router.currentRoute.value.query).toMatchObject({ ownerId: fake.sales.userId });

    select(wrapper, 'Projects').vm.$emit('update:modelValue', 'completed');
    await settle();
    expect(router.currentRoute.value.query).toMatchObject({ projectStatus: 'completed' });
    expect(document.body.textContent).toContain('No matching projects');

    textField(wrapper, 'Closed from').vm.$emit('update:modelValue', '2026-10-05');
    textField(wrapper, 'Closed to').vm.$emit('update:modelValue', '2026-10-01');
    await settle();
    expect(document.body.textContent).toContain('The end date must not be before the start date.');
    // The previous figures stay visible while the filter is corrected.
    expect(labelled('Pipeline by stage')).toBeTruthy();
  });

  it('opens with filters from the URL and keeps one report usable when the other fails', async () => {
    const fake = await seeded();
    const original = fake.service.projects.deliveryReport.bind(fake.service.projects);
    let fail = true;
    fake.service.projects.deliveryReport = (actor, filter) =>
      fail
        ? Promise.reject(
            Object.assign(new Error('down'), {
              name: 'ServiceError',
              code: 'DEPENDENCY_FAILURE',
              retryable: true,
              requestId: actor.requestId
            })
          )
        : original(actor, filter);
    useApi('readonly@example.com', fake);
    await mountWithApp(App, { route: '/reports?closedFrom=2026-10-01' });
    expect(labelled('Pipeline by stage').textContent).toContain('£500.00');
    expect(document.body.textContent).toContain('Temporarily unavailable');
    fail = false;
    const retry = [...document.body.querySelectorAll('button')].find(
      (button) =>
        button.textContent?.trim() === 'Try again' || button.textContent?.trim() === 'Retry'
    )!;
    retry.click();
    await settle();
    expect(labelled('Delivery by project').textContent).toContain('Engines rollout');
  });

  it('shows the quarterly pipeline by stage and switches quarter through the URL', async () => {
    const fake = await seeded();
    await fake.deal('Closing this quarter', 40_000, '2026-11-20');
    await fake.deal('Closing next quarter', 7_000, '2027-02-10');
    useApi('readonly@example.com', fake);
    const { wrapper, router } = await mountWithApp(App, { route: '/reports' });
    const stages = () => wrapper.get('[data-testid="quarterly-stages"]').text();
    const deals = () => labelled('Deals expected to close').textContent ?? '';
    expect(stages()).toContain('Q4 2026');
    expect(stages()).toContain('£400.00');
    expect(deals()).toContain('Closing this quarter');
    expect(deals()).not.toContain('Closing next quarter');
    expect(deals()).not.toContain('Open deal');
    const quarter = wrapper
      .findAllComponents({ name: 'VSelect' })
      .find((candidate) => candidate.props('label') === 'Quarter')!;
    expect((quarter.props('items') as { value: string }[]).map((item) => item.value)).toEqual([
      '2026-Q3',
      '2026-Q4',
      '2027-Q1',
      '2027-Q2'
    ]);
    quarter.vm.$emit('update:modelValue', '2027-Q1');
    await settle();
    expect(router.currentRoute.value.query.quarter).toBe('2027-Q1');
    expect(deals()).toContain('Closing next quarter');
    expect(stages()).toContain('Q1 2027');

    // A bookmarked quarter outside the offered range is still selectable, and empty is explained.
    await router.push('/reports?quarter=2025-Q1');
    await settle();
    expect(deals()).toContain('No open deals are expected to close in this quarter.');
    // The owner filter on the pipeline card narrows the quarterly report too, keeping the quarter.
    select(wrapper, 'Deal owner').vm.$emit('update:modelValue', fake.sales.userId);
    await settle();
    expect(router.currentRoute.value.query).toMatchObject({
      quarter: '2025-Q1',
      ownerId: fake.sales.userId
    });
  });

  it('is hidden from navigation and refused by the server without report.read', async () => {
    const fake = await seeded();
    fake.store.exec("DELETE FROM role_permissions WHERE permission = 'report.read'");
    useApi('readonly@example.com', fake);
    await mountWithApp(App, { route: '/reports' });
    expect(document.body.querySelector('nav')?.textContent).not.toContain('Reports');
    expect(document.body.textContent).toContain('You do not have access');
  });
});

describe('the customer overview timeline', () => {
  it('merges deals, projects, activities, and notes on contact and company pages', async () => {
    const fake = await seeded();
    await fake.service.notes.createNote(
      fake.sales,
      {
        title: 'Kick-off notes',
        markdown: 'Private body',
        links: [
          { type: 'contact', id: fake.contact.id },
          { type: 'company', id: fake.contact.company!.id }
        ]
      },
      key()
    );
    useApi('readonly@example.com', fake);
    const { router } = await mountWithApp(App, { route: `/contacts/${fake.contact.id}` });
    const timeline = () => labelled('Customer timeline');
    for (const text of [
      'Deal won:',
      'Deal opened:',
      'Project started:',
      'Note:',
      'Kick-off notes'
    ]) {
      expect(timeline().textContent).toContain(text);
    }
    expect(timeline().textContent).not.toContain('Private body');
    expect(timeline().querySelector(`a[href="/projects/${fake.project.id}"]`)).not.toBeNull();

    await router.push(`/companies/${fake.contact.company!.id}`);
    await settle();
    expect(timeline().textContent).toContain('Engines rollout');
    expect(document.body.querySelector('[data-testid="notes-card"]')?.textContent).toContain(
      'Kick-off notes'
    );
  });
});
