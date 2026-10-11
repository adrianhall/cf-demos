/**
 * @file The delivery SPA in the DOM, against the real API app and the SQLite-backed fake Data
 *   Worker: won-deal conversion with confirmation, result, and conflict recovery; the task board's
 *   keyboard status menu and its version-race handling; task creation and editing with a preserved
 *   draft on conflict; the table view; My work; project status; and role-based visibility.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VueWrapper } from '@vue/test-utils';
import App from '../../src/client/App.vue';
import TaskBoard from '../../src/client/components/TaskBoard.vue';
import { resetSession } from '../../src/client/composables/useSession.ts';
import type { Task } from '../../src/shared/api/projects.ts';
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
  return { idempotencyKey: `delivery-seed-${++keyCounter}` };
}

/**
 * Seed a fake with sales, delivery, manager, and read-only users and one won deal.
 *
 * @returns The fake, actors, and the won deal.
 */
async function seeded() {
  const runtime = testRuntime(new Date('2026-10-11T09:00:00.000Z'));
  const fake = createFakeDataService({ runtime });
  const actor = (
    email: string,
    role: 'sales' | 'delivery' | 'manager' | 'read-only'
  ): ActorContext => ({
    email,
    userId: fake.store.addUser(email, role),
    requestId: 'seed',
    channel: 'api'
  });
  const sales = actor('sales@example.com', 'sales');
  const delivery = actor('delivery@example.com', 'delivery');
  const manager = actor('manager@example.com', 'manager');
  actor('readonly@example.com', 'read-only');
  const contact = await fake.service.crm.createContact(
    sales,
    {
      firstName: 'Ada',
      lastName: 'Analyst',
      email: null,
      phone: null,
      jobTitle: null,
      companyId: null,
      companyName: 'Engines'
    },
    key()
  );
  const created = await fake.service.crm.createDeal(
    sales,
    {
      title: 'Engine renewal',
      primaryContactId: contact.id,
      amountMinor: 1000,
      statusLine: null,
      nextActionText: null,
      nextActionDate: null,
      expectedCloseDate: null
    },
    key()
  );
  const won = await fake.service.crm.updateDeal(sales, created.id, { status: 'won' }, 1, key());
  return { ...fake, runtime, sales, delivery, manager, contact, won };
}

/**
 * A seeded fake with the deal already converted and one task assigned to the delivery user.
 *
 * @returns The fake, the project, and the task.
 */
async function withProject() {
  const fake = await seeded();
  const project = await fake.service.projects.convertDeal(
    fake.sales,
    fake.won.id,
    {},
    fake.won.version,
    key()
  );
  const task = await fake.service.projects.createTask(
    fake.delivery,
    project.id,
    {
      title: 'Kickoff call',
      description: null,
      status: 'todo',
      priority: 'high',
      assigneeId: fake.delivery.userId,
      dueDate: '2026-10-12'
    },
    key()
  );
  return { ...fake, project, task };
}

/**
 * Find a button by its visible text, anywhere in the document (dialogs teleport to `body`).
 *
 * @param text Button text.
 * @returns The button.
 */
function button(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === text
  );
  if (found === undefined) {
    throw new Error(`No button "${text}"`);
  }
  return found;
}

/**
 * Click an element found by an accessible name.
 *
 * @param label The `aria-label`.
 */
function clickLabelled(label: string): void {
  const element = document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (element === null) {
    throw new Error(`No element labelled "${label}"`);
  }
  element.click();
}

/**
 * Click an open menu item by its text.
 *
 * @param text Item text.
 */
function chooseMenuItem(text: string): void {
  const item = [...document.body.querySelectorAll<HTMLElement>('.v-overlay .v-list-item')].find(
    (candidate) => candidate.textContent?.trim() === text
  );
  if (item === undefined) {
    throw new Error(`No menu item "${text}"`);
  }
  item.click();
}

/**
 * Type into an input found by its label.
 *
 * @param label Label text.
 * @param value New value.
 */
function type(label: string, value: string): void {
  const element = [
    ...document.body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
  ].find((candidate) => candidate.labels?.[0]?.textContent?.trim() === label);
  if (element === undefined) {
    throw new Error(`No input "${label}"`);
  }
  element.value = value;
  element.dispatchEvent(new Event('input'));
}

/**
 * Submit the last form in the document (the open dialog's).
 */
function submitDialog(): void {
  const forms = document.body.querySelectorAll('form');
  forms[forms.length - 1]?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  resetSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('converting a won deal', () => {
  it('confirms, converts once, opens the project, and shows the link back on the deal', async () => {
    const fake = await seeded();
    useApi('sales@example.com', fake);
    const { wrapper, router } = await mountWithApp(App, { route: `/deals/${fake.won.id}` });
    button('Convert to project').click();
    await settle();
    expect(document.body.textContent).toContain(
      'either the project is created and linked, or nothing'
    );
    type('Project name', 'Engine renewal delivery');
    submitDialog();
    await settle();
    expect(router.currentRoute.value.name).toBe('project');
    expect(wrapper.get('h1').text()).toBe('Engine renewal delivery');
    expect(wrapper.text()).toContain('Engine renewal');
    expect(wrapper.text()).toContain('Engines');
    expect(fake.store.count('projects')).toBe(1);

    await router.push(`/deals/${fake.won.id}`);
    await settle();
    expect(wrapper.get('[data-testid="converted"]').text()).toContain('Engine renewal delivery');
    expect(() => button('Convert to project')).toThrow();
  });

  it('reloads and explains when the deal changed after the dialog opened', async () => {
    const fake = await seeded();
    useApi('sales@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: `/deals/${fake.won.id}` });
    button('Convert to project').click();
    await settle();
    // Someone else converts it first.
    await fake.service.projects.convertDeal(fake.manager, fake.won.id, {}, fake.won.version, key());
    submitDialog();
    await settle();
    expect(document.body.querySelector('[data-testid="convert-error"]')?.textContent).toContain(
      'already been converted'
    );
    expect(wrapper.find('[data-testid="converted"]').exists()).toBe(true);
    expect(fake.store.count('projects')).toBe(1);
  });

  it('asks for a fresh look after a stale version and shows field errors', async () => {
    const fake = await seeded();
    useApi('sales@example.com', fake);
    await mountWithApp(App, { route: `/deals/${fake.won.id}` });
    button('Convert to project').click();
    await settle();
    await fake.service.crm.updateDeal(
      fake.sales,
      fake.won.id,
      { statusLine: 'Signed' },
      fake.won.version,
      key()
    );
    submitDialog();
    await settle();
    expect(document.body.querySelector('[data-testid="convert-error"]')?.textContent).toContain(
      'This deal changed after you opened it'
    );
    type('Target date', '2026-01-01');
    submitDialog();
    await settle();
    expect(document.body.textContent).toContain('The target date cannot be in the past.');
    expect(fake.store.count('projects')).toBe(0);
  });

  it('is not offered for a pending deal or to a delivery user', async () => {
    const fake = await seeded();
    useApi('delivery@example.com', fake);
    await mountWithApp(App, { route: `/deals/${fake.won.id}` });
    expect(() => button('Convert to project')).toThrow();
  });
});

describe('Mark won/lost', () => {
  /**
   * A seeded fake whose deal is still pending (the default seed wins it).
   *
   * @returns The fake and the pending deal.
   */
  async function withPending() {
    const fake = await seeded();
    const pending = await fake.service.crm.createDeal(
      fake.sales,
      {
        title: 'Open opportunity',
        primaryContactId: fake.contact.id,
        amountMinor: 500,
        statusLine: null,
        nextActionText: 'Chase',
        nextActionDate: '2026-10-20',
        expectedCloseDate: null
      },
      key()
    );
    return { ...fake, pending };
  }

  /**
   * The "also convert" checkbox input.
   *
   * @returns The input.
   */
  function convertBox(): HTMLInputElement {
    const box = document.body.querySelector<HTMLInputElement>(
      '[data-testid="convert-on-win"] input[type="checkbox"]'
    );
    if (box === null) {
      throw new Error('No convert checkbox');
    }
    return box;
  }

  /**
   * Choose an outcome radio.
   *
   * @param value `won` or `lost`.
   */
  function chooseOutcome(value: 'won' | 'lost'): void {
    const radio = document.body.querySelector<HTMLInputElement>(
      `[data-testid="outcome"] input[value="${value}"]`
    );
    if (radio === null) {
      throw new Error(`No ${value} radio`);
    }
    radio.click();
  }

  it('defaults to won with conversion checked, and wins + converts in one step', async () => {
    const fake = await withPending();
    useApi('sales@example.com', fake);
    const { wrapper, router } = await mountWithApp(App, { route: `/deals/${fake.pending.id}` });
    button('Mark won/lost').click();
    await settle();
    expect(convertBox().checked).toBe(true);
    expect(convertBox().disabled).toBe(false);
    button('Submit').click();
    await settle();
    expect(router.currentRoute.value.name).toBe('project');
    expect(wrapper.get('h1').text()).toBe('Open opportunity');
    const { deal } = await fake.service.crm.getDeal(fake.sales, fake.pending.id);
    expect(deal).toMatchObject({ status: 'won', nextActionText: null });
    expect(deal.project).not.toBeNull();
  });

  it('wins without converting when unchecked, then offers Convert to project', async () => {
    const fake = await withPending();
    useApi('sales@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: `/deals/${fake.pending.id}` });
    button('Mark won/lost').click();
    await settle();
    convertBox().click();
    await settle();
    expect(convertBox().checked).toBe(false);
    button('Submit').click();
    await settle();
    expect(wrapper.text()).toContain('Won');
    expect(() => button('Mark won/lost')).toThrow();
    expect(button('Convert to project')).toBeDefined();
    expect(fake.store.count('projects')).toBe(0);
  });

  it('greys out conversion for lost and closes the deal as lost', async () => {
    const fake = await withPending();
    useApi('sales@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: `/deals/${fake.pending.id}` });
    button('Mark won/lost').click();
    await settle();
    chooseOutcome('lost');
    await settle();
    expect(convertBox().disabled).toBe(true);
    expect(convertBox().checked).toBe(false);
    expect(document.body.textContent).toContain('Only a won deal can become a project.');
    button('Submit').click();
    await settle();
    expect(wrapper.text()).toContain('Lost');
    expect(() => button('Convert to project')).toThrow();
    expect((await fake.service.crm.getDeal(fake.sales, fake.pending.id)).deal.status).toBe('lost');
    expect(fake.store.count('projects')).toBe(0);
  });

  it('reloads and explains when the deal changed after the dialog opened', async () => {
    const fake = await withPending();
    useApi('sales@example.com', fake);
    await mountWithApp(App, { route: `/deals/${fake.pending.id}` });
    button('Mark won/lost').click();
    await settle();
    await fake.service.crm.updateDeal(
      fake.sales,
      fake.pending.id,
      { statusLine: 'Moved on' },
      1,
      key()
    );
    button('Submit').click();
    await settle();
    expect(document.body.querySelector('[data-testid="close-error"]')?.textContent).toContain(
      'This deal changed after you opened it'
    );
    expect((await fake.service.crm.getDeal(fake.sales, fake.pending.id)).deal.status).toBe(
      'pending'
    );
    expect(fake.store.count('projects')).toBe(0);
  });

  it('is hidden from read-only users and on a closed deal; a delivery user cannot convert', async () => {
    const fake = await withPending();
    useApi('readonly@example.com', fake);
    const first = await mountWithApp(App, { route: `/deals/${fake.pending.id}` });
    expect(() => button('Mark won/lost')).toThrow();
    first.wrapper.unmount();
    document.body.innerHTML = '';
    resetSession();
    // The default seed deal is already won: no Mark won/lost for anyone.
    useApi('sales@example.com', fake);
    await mountWithApp(App, { route: `/deals/${fake.won.id}` });
    expect(() => button('Mark won/lost')).toThrow();
  });
});

describe('task board', () => {
  it('moves a task with the keyboard-operable status menu and announces it', async () => {
    const fake = await withProject();
    useApi('delivery@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: `/projects/${fake.project.id}` });
    expect(wrapper.get('[data-testid="task-board"]').text()).toContain('Kickoff call');
    clickLabelled('Move Kickoff call to another status');
    await settle();
    chooseMenuItem('In progress');
    await settle();
    expect(wrapper.get('[data-testid="board-notice"]').text()).toContain(
      'Kickoff call moved to In progress.'
    );
    const detail = await fake.service.projects.getProject(fake.delivery, fake.project.id);
    expect(detail.tasks[0]?.status).toBe('in_progress');
  });

  it('refreshes and explains a move that lost a version race', async () => {
    const fake = await withProject();
    useApi('delivery@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: `/projects/${fake.project.id}` });
    await fake.service.projects.updateTask(
      fake.delivery,
      fake.task.id,
      { title: 'Kickoff call v2' },
      1,
      key()
    );
    clickLabelled('Move Kickoff call to another status');
    await settle();
    chooseMenuItem('Done');
    await settle();
    expect(wrapper.text()).toContain('was changed by someone else');
    expect(wrapper.text()).toContain('Kickoff call v2');
  });

  it('adds a task, edits it, and keeps the draft on a version conflict', async () => {
    const fake = await withProject();
    useApi('delivery@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: `/projects/${fake.project.id}` });
    button('Add task').click();
    await settle();
    submitDialog();
    await settle();
    expect(document.body.textContent).toContain('Title is required.');
    type('Title', 'Write runbook');
    type('Description', 'For go-live');
    submitDialog();
    await settle();
    expect(wrapper.text()).toContain('Added Write runbook.');
    expect(wrapper.get('[data-testid="task-board"]').text()).toContain('Write runbook');

    clickLabelled('Edit Kickoff call');
    await settle();
    await fake.service.projects.updateTask(
      fake.delivery,
      fake.task.id,
      { priority: 'urgent' },
      1,
      key()
    );
    type('Title', 'Kickoff call with customer');
    submitDialog();
    await settle();
    expect(document.body.querySelector('[data-testid="conflict"]')).not.toBeNull();
    button('Load latest version').click();
    await settle();
    expect(document.body.textContent).toContain('Your edits are still in the form');
    submitDialog();
    await settle();
    expect(wrapper.text()).toContain('Saved Kickoff call with customer.');
    const detail = await fake.service.projects.getProject(fake.delivery, fake.project.id);
    expect(detail.tasks.find((task) => task.id === fake.task.id)).toMatchObject({
      title: 'Kickoff call with customer',
      priority: 'urgent'
    });
  });

  it('closes an unchanged edit without saving, and lists tasks in the table view', async () => {
    const fake = await withProject();
    useApi('delivery@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: `/projects/${fake.project.id}` });
    clickLabelled('Edit Kickoff call');
    await settle();
    submitDialog();
    await settle();
    expect(document.body.querySelector('[data-testid="conflict"]')).toBeNull();
    button('Table').click();
    await settle();
    expect(wrapper.get('table').text()).toContain('Kickoff call');
    expect(wrapper.get('table').text()).toContain('High');
  });

  it('is read-only for sales and read-only users, and for an archived project', async () => {
    const fake = await withProject();
    useApi('readonly@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: `/projects/${fake.project.id}` });
    expect(wrapper.text()).toContain('Your role can view delivery work but not change it.');
    expect(
      document.body.querySelector('[aria-label="Move Kickoff call to another status"]')
    ).toBeNull();
    expect(() => button('Add task')).toThrow();
  });
});

describe('project status', () => {
  it('lets a manager archive (making the board read-only) but explains a denial to delivery', async () => {
    const fake = await withProject();
    useApi('delivery@example.com', fake);
    const first = await mountWithApp(App, { route: `/projects/${fake.project.id}` });
    const select = first.wrapper
      .findAllComponents({ name: 'VSelect' })
      .find((candidate) => candidate.props('label') === 'Project status') as VueWrapper;
    select.vm.$emit('update:modelValue', 'archived');
    await settle();
    expect(first.wrapper.text()).toContain('Only managers and owners can archive or unarchive');
    first.wrapper.unmount();
    document.body.innerHTML = '';

    resetSession();
    useApi('manager@example.com', fake);
    const second = await mountWithApp(App, { route: `/projects/${fake.project.id}` });
    const managerSelect = second.wrapper
      .findAllComponents({ name: 'VSelect' })
      .find((candidate) => candidate.props('label') === 'Project status') as VueWrapper;
    managerSelect.vm.$emit('update:modelValue', 'archived');
    await settle();
    expect(second.wrapper.text()).toContain('This project is archived and read-only.');
    expect(
      document.body.querySelector('[aria-label="Move Kickoff call to another status"]')
    ).toBeNull();
  });
});

describe('projects list and my work', () => {
  it('lists, filters (URL-backed), and opens projects', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fake = await withProject();
    useApi('readonly@example.com', fake);
    const { wrapper, router } = await mountWithApp(App, { route: '/projects' });
    expect(wrapper.text()).toContain('Engine renewal');
    expect(wrapper.text()).toContain('0 of 1 done');
    const status = wrapper.findAllComponents({ name: 'VSelect' })[0] as VueWrapper;
    status.vm.$emit('update:modelValue', 'archived');
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(router.currentRoute.value.query).toEqual({ status: 'archived' });
    expect(wrapper.text()).toContain('No matching projects');
  });

  it('pages the project list', async () => {
    const fake = await seeded();
    for (let i = 0; i < 26; i++) {
      const created = await fake.service.crm.createDeal(
        fake.sales,
        {
          title: `Deal ${String(i).padStart(2, '0')}`,
          primaryContactId: fake.contact.id,
          amountMinor: 0,
          statusLine: null,
          nextActionText: null,
          nextActionDate: null,
          expectedCloseDate: null
        },
        key()
      );
      const won = await fake.service.crm.updateDeal(
        fake.sales,
        created.id,
        { status: 'won' },
        1,
        key()
      );
      await fake.service.projects.convertDeal(fake.sales, won.id, {}, won.version, key());
    }
    useApi('readonly@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: '/projects' });
    expect(wrapper.findAll('[aria-label="Projects"] .v-list-item')).toHaveLength(25);
    button('Load more').click();
    await settle();
    expect(wrapper.findAll('[aria-label="Projects"] .v-list-item')).toHaveLength(26);
  });

  it('shows my work with overdue highlighting and moves a task from the list', async () => {
    const fake = await withProject();
    fake.runtime.set(new Date('2026-10-13T09:00:00.000Z'));
    useApi('delivery@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: '/my-work' });
    expect(wrapper.text()).toContain('Kickoff call');
    clickLabelled('Move Kickoff call to another status');
    await settle();
    chooseMenuItem('Done');
    await settle();
    expect(wrapper.text()).toContain('Kickoff call moved to Done.');
    expect(wrapper.text()).toContain('Nothing assigned to you');
  });

  it('shows projects on the company and contact timelines', async () => {
    const fake = await withProject();
    useApi('readonly@example.com', fake);
    const { wrapper, router } = await mountWithApp(App, {
      route: `/companies/${fake.contact.company?.id ?? ''}`
    });
    expect(wrapper.text()).toContain('Lead sales · 1 open, 0 done');
    await router.push(`/contacts/${fake.contact.id}`);
    await settle();
    expect(wrapper.text()).toContain('Engine renewal');
    expect(wrapper.text()).toContain('Converted to Engine renewal');
  });
});

describe('TaskBoard component', () => {
  it('flags overdue tasks in text and emits open', async () => {
    const fake = await withProject();
    const detail = await fake.service.projects.getProject(fake.delivery, fake.project.id);
    const opened: Task[] = [];
    const { wrapper } = await mountWithApp(TaskBoard, {
      props: {
        tasks: detail.tasks,
        editable: true,
        today: '2026-10-20',
        onOpen: (task: Task) => opened.push(task)
      }
    });
    expect(wrapper.text()).toContain('(overdue)');
    expect(wrapper.text()).toContain('To do (1)');
    clickLabelled('Edit Kickoff call');
    await settle();
    expect(opened.map((task) => task.id)).toEqual([fake.task.id]);
  });
});
