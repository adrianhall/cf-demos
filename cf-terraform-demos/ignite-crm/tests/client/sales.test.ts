/**
 * @file The sales SPA in the DOM, against the real API app and the SQLite-backed fake Data Worker:
 *   deal creation from a contact, the pipeline board's keyboard move, deal editing with a preserved
 *   draft on a version conflict, activity logging with several contacts, next actions, the action
 *   stream, and the dashboard pipeline summary — plus role-based control visibility.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DOMWrapper, VueWrapper } from '@vue/test-utils';
import App from '../../src/client/App.vue';
import { resetSession } from '../../src/client/composables/useSession.ts';
import type { ActorContext } from '../../src/shared/data-service/contract.ts';
import { createFakeDataService, testRuntime } from '../fakes/fake-data-service.ts';
import { mountWithApp, settle, useApi } from './support.ts';

/**
 * Seed a fake with users and a company with two contacts.
 *
 * @returns The fake plus the sales actor and contact ids.
 */
async function seeded() {
  // "Now" for the Data Worker is 11 Oct 2026; the browser keeps the real clock.
  const fake = createFakeDataService({
    runtime: testRuntime(new Date('2026-10-11T09:00:00.000Z'))
  });
  const sales: ActorContext = {
    email: 'sales@example.com',
    userId: fake.store.addUser('sales@example.com', 'sales'),
    requestId: 'seed',
    channel: 'api'
  };
  fake.store.addUser('readonly@example.com', 'read-only');
  fake.store.addUser('owner@example.com', 'owner');
  const contact = (firstName: string) =>
    fake.service.crm.createContact(
      sales,
      {
        firstName,
        lastName: 'Analyst',
        email: null,
        phone: null,
        jobTitle: null,
        companyId: null,
        companyName: 'Engines'
      },
      { idempotencyKey: `seed-${firstName}-key` }
    );
  const ada = await contact('Ada');
  const grace = await contact('Grace');
  return { ...fake, sales, ada, grace };
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
 * Find an input by its label, anywhere in the document.
 *
 * @param label Label text.
 * @returns The input.
 */
function input(label: string): HTMLInputElement | HTMLTextAreaElement {
  const found = [
    ...document.body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
  ].find((candidate) => candidate.labels?.[0]?.textContent?.trim() === label);
  if (found === undefined) {
    throw new Error(`No input "${label}"`);
  }
  return found;
}

/**
 * Type into an input.
 *
 * @param label Label text.
 * @param value New value.
 */
function type(label: string, value: string): void {
  const element = input(label);
  element.value = value;
  element.dispatchEvent(new Event('input'));
}

/**
 * Submit the open dialog's form.
 *
 * @param index Which form, when several are open.
 */
function submit(index = 0): void {
  const forms = document.body.querySelectorAll('form');
  forms[index]?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  resetSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('deals from a contact', () => {
  it('creates a deal for the contact with a next action and opens it', async () => {
    const fake = await seeded();
    useApi('sales@example.com', fake);
    const { wrapper, router } = await mountWithApp(App, { route: `/contacts/${fake.ada.id}` });
    button('New deal').click();
    await settle();
    type('Title', 'Engine renewal');
    type('Amount (£)', '1,250.50');
    type('Next action', 'Send proposal');
    type('Next action date', '2026-10-15');
    submit();
    await settle();
    expect(router.currentRoute.value.name).toBe('deal');
    expect(wrapper.get('h1').text()).toBe('Engine renewal');
    expect(wrapper.text()).toContain('£1,250.50');
    expect(wrapper.text()).toContain('Send proposal');
    expect(wrapper.text()).toContain('Open · Lead');
    expect(wrapper.text()).toContain('Engines');
  });

  it('blocks half a next action and a malformed amount locally', async () => {
    const fake = await seeded();
    useApi('sales@example.com', fake);
    await mountWithApp(App, { route: `/contacts/${fake.ada.id}` });
    button('New deal').click();
    await settle();
    type('Title', 'Bad');
    type('Amount (£)', 'lots');
    type('Next action', 'Something');
    submit();
    await settle();
    expect(document.body.textContent).toContain('Enter an amount in pounds');
    expect(document.body.textContent).toContain(
      'A next action needs both a description and a date.'
    );
    expect(fake.store.count('deals')).toBe(0);
  });

  it('shows server validation on the field (a past next-action date)', async () => {
    const fake = await seeded();
    useApi('sales@example.com', fake);
    await mountWithApp(App, { route: `/contacts/${fake.ada.id}` });
    button('New deal').click();
    await settle();
    type('Title', 'Late');
    type('Next action', 'Too late');
    type('Next action date', '2026-10-01');
    submit();
    await settle();
    expect(document.body.textContent).toContain('The next action date cannot be in the past.');
    expect((input('Title') as HTMLInputElement).value).toBe('Late');
  });
});

describe('deal editing', () => {
  it('saves only changes, then keeps the draft on a version conflict and reloads on request', async () => {
    const fake = await seeded();
    const deal = await fake.service.crm.createDeal(
      fake.sales,
      {
        title: 'Conflicted',
        primaryContactId: fake.ada.id,
        amountMinor: 1000,
        statusLine: null,
        nextActionText: null,
        nextActionDate: null,
        expectedCloseDate: null
      },
      { idempotencyKey: 'seed-deal-key' }
    );
    useApi('sales@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: `/deals/${deal.id}` });

    button('Edit deal').click();
    await settle();
    // Someone else saves first.
    await fake.service.crm.updateDeal(fake.sales, deal.id, { title: 'Theirs' }, 1, {
      idempotencyKey: 'other-user-key'
    });
    type('Status line', 'My careful note');
    submit();
    await settle();
    expect(document.body.querySelector('[data-testid="conflict"]')).not.toBeNull();
    expect((input('Status line') as HTMLInputElement).value).toBe('My careful note');

    button('Load latest version').click();
    await settle();
    expect(document.body.textContent).toContain('Your edits are still in the form');
    submit();
    await settle();
    expect(wrapper.text()).toContain('My careful note');
    // The other user's title change survives: the save sent only the field this user edited.
    expect(wrapper.get('h1').text()).toBe('Theirs');
  });

  it('closes a deal as won, which clears the next action', async () => {
    const fake = await seeded();
    const deal = await fake.service.crm.createDeal(
      fake.sales,
      {
        title: 'Winnable',
        primaryContactId: fake.ada.id,
        amountMinor: 0,
        statusLine: null,
        nextActionText: 'Chase',
        nextActionDate: '2026-10-20',
        expectedCloseDate: null
      },
      { idempotencyKey: 'seed-win-key' }
    );
    useApi('sales@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: `/deals/${deal.id}` });
    button('Edit deal').click();
    await settle();
    const vm = wrapper.findComponent({ name: 'DealForm' });
    expect(vm.exists()).toBe(true);
    // Choose "Won" through the select's model (Vuetify menus are covered by Vuetify's own tests).
    const select = wrapper.findAllComponents({ name: 'VSelect' })[0] as VueWrapper;
    select.vm.$emit('update:modelValue', 'won');
    await settle();
    expect(document.body.textContent).toContain('A won or lost deal has no next action');
    submit();
    await settle();
    expect(wrapper.text()).toContain('Won');
    expect(wrapper.text()).not.toContain('Chase');
  });

  it('reports "nothing changed" without calling the API', async () => {
    const fake = await seeded();
    const deal = await fake.service.crm.createDeal(
      fake.sales,
      {
        title: 'Same',
        primaryContactId: fake.ada.id,
        amountMinor: 0,
        statusLine: null,
        nextActionText: null,
        nextActionDate: null,
        expectedCloseDate: null
      },
      { idempotencyKey: 'seed-same-key' }
    );
    useApi('sales@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: `/deals/${deal.id}` });
    button('Edit deal').click();
    await settle();
    submit();
    await settle();
    expect(wrapper.text()).toContain('Nothing changed, so nothing was saved.');
    const notice = wrapper.findAll('.v-alert').find((alert) => alert.text().includes('Nothing'))!;
    await notice.get('button').trigger('click');
    await settle();
    expect(wrapper.text()).not.toContain('Nothing changed');
  });

  it('logs a call about the deal from the deal page, and cancels each dialog without writing', async () => {
    const fake = await seeded();
    const deal = await fake.service.crm.createDeal(
      fake.sales,
      {
        title: 'Expansion',
        primaryContactId: fake.ada.id,
        amountMinor: 0,
        statusLine: null,
        nextActionText: null,
        nextActionDate: null,
        expectedCloseDate: null
      },
      { idempotencyKey: 'seed-log-deal' }
    );
    useApi('sales@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: `/deals/${deal.id}` });
    // Closed Vuetify dialogs stay mounted, so act within the one that is open.
    const openDialog = (): HTMLElement =>
      [...document.body.querySelectorAll<HTMLElement>('.v-overlay--active[role="dialog"]')].at(-1)!;
    const within = (text: string): HTMLButtonElement =>
      [...openDialog().querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === text
      )!;
    for (const opener of ['Edit deal', 'Mark won/lost', 'Log activity']) {
      button(opener).click();
      await settle();
      within('Cancel').click();
      await settle();
      expect(document.body.querySelector('.v-overlay--active[role="dialog"]')).toBeNull();
    }
    expect(fake.store.count('activities')).toBe(0);
    expect((await fake.service.crm.getDeal(fake.sales, deal.id)).deal.version).toBe(1);

    button('Log activity').click();
    await settle();
    type('Subject', 'Pricing call');
    type('When', '2026-10-11T08:00');
    openDialog()
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(wrapper.text()).toContain('Pricing call');
    expect(fake.store.count('activities')).toBe(1);
  });
});

describe('pipeline board', () => {
  it('moves a deal to another stage from the keyboard-operable menu', async () => {
    const fake = await seeded();
    const deal = await fake.service.crm.createDeal(
      fake.sales,
      {
        title: 'Movable',
        primaryContactId: fake.ada.id,
        amountMinor: 5000,
        statusLine: null,
        nextActionText: null,
        nextActionDate: null,
        expectedCloseDate: null
      },
      { idempotencyKey: 'seed-move-key' }
    );
    useApi('sales@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: '/deals' });
    expect(wrapper.get('[data-testid="pipeline-board"]').text()).toContain('Movable');
    (
      document.body.querySelector(
        `[aria-label="Move Movable to another stage"]`
      ) as HTMLButtonElement
    ).click();
    await settle();
    const proposal = [...document.body.querySelectorAll('.v-list-item')].find(
      (item) => item.textContent?.trim() === 'Proposal'
    ) as HTMLElement;
    proposal.click();
    await settle();
    expect((await fake.service.crm.getDeal(fake.sales, deal.id)).deal.stage.key).toBe('proposal');
    const column = wrapper.findAll('[role="listitem"]')[2] as DOMWrapper<Element>;
    expect(column.text()).toContain('Movable');
    // The move is announced, and focus follows the card to its new column (WCAG 4.1.3, 2.4.3).
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(document.body.querySelector('[data-testid="announcer"]')?.textContent?.trim()).toBe(
      'Movable moved to Proposal.'
    );
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Move Movable to another stage'
    );
    expect(column.element.contains(document.activeElement)).toBe(true);
  });

  it('switches to the list with a URL-backed filter, and hides writes from read-only users', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fake = await seeded();
    await fake.service.crm.createDeal(
      fake.sales,
      {
        title: 'Listed',
        primaryContactId: fake.ada.id,
        amountMinor: 0,
        statusLine: 'Shortlisted',
        nextActionText: null,
        nextActionDate: null,
        expectedCloseDate: null
      },
      { idempotencyKey: 'seed-list-key' }
    );
    useApi('readonly@example.com', fake);
    const { wrapper, router } = await mountWithApp(App, { route: '/deals' });
    expect(wrapper.text()).toContain('Your role can view deals but not create');
    expect(document.body.querySelector('[aria-label="Move Listed to another stage"]')).toBeNull();
    button('List').click();
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(router.currentRoute.value.query).toEqual({ view: 'list' });
    expect(wrapper.find('table').text()).toContain('Shortlisted');
    vi.useRealTimers();
  });
});

describe('deals page', () => {
  it('creates a deal from the deals page, choosing the contact in the picker', async () => {
    const fake = await seeded();
    useApi('sales@example.com', fake);
    const { wrapper, router } = await mountWithApp(App, { route: '/deals' });
    button('New deal').click();
    await settle();
    type('Title', 'From the board');
    wrapper
      .findComponent({ name: 'ContactPicker' })
      .vm.$emit('update:modelValue', { id: fake.grace.id, displayName: 'Grace Analyst' });
    await settle();
    submit();
    await settle();
    expect(router.currentRoute.value.name).toBe('deal');
    expect(wrapper.text()).toContain('Grace Analyst');
  });

  it('requires a primary contact', async () => {
    const fake = await seeded();
    useApi('sales@example.com', fake);
    await mountWithApp(App, { route: '/deals' });
    button('New deal').click();
    await settle();
    type('Title', 'Nobody');
    submit();
    await settle();
    expect(document.body.textContent).toContain('Choose the primary contact.');
  });

  it('pages the list, filters by outcome, and lists deals on contact and company timelines', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fake = await seeded();
    for (let i = 0; i < 27; i++) {
      await fake.service.crm.createDeal(
        fake.sales,
        {
          title: `Deal ${String(i).padStart(2, '0')}`,
          primaryContactId: fake.ada.id,
          amountMinor: 100,
          statusLine: null,
          nextActionText: i === 0 ? 'Follow up' : null,
          nextActionDate: i === 0 ? '2026-10-20' : null,
          expectedCloseDate: null
        },
        { idempotencyKey: `seed-page-deal-${i}` }
      );
    }
    useApi('sales@example.com', fake);
    const { wrapper, router } = await mountWithApp(App, { route: '/deals?view=list' });
    expect(wrapper.findAll('tbody tr')).toHaveLength(25);
    expect(wrapper.find('tbody').text()).toContain('Follow up');
    button('Load more').click();
    await settle();
    expect(wrapper.findAll('tbody tr')).toHaveLength(27);

    const outcome = wrapper
      .findAllComponents({ name: 'VSelect' })
      .find((select) => select.props('label') === 'Outcome') as VueWrapper;
    outcome.vm.$emit('update:modelValue', 'won');
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(router.currentRoute.value.query).toEqual({ view: 'list', status: 'won' });
    expect(wrapper.text()).toContain('No matching deals');
    vi.useRealTimers();

    await router.push(`/contacts/${fake.ada.id}`);
    await settle();
    expect(wrapper.text()).toContain('Deal 00 · £1.00');
    expect(wrapper.text()).toContain('Next: Follow up');
    await router.push(`/companies/${fake.ada.company?.id ?? ''}`);
    await settle();
    expect(wrapper.text()).toContain('Deal 26');
  });

  it('filters the list by stage from the URL and the Stage select', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fake = await seeded();
    const { stages } = await fake.service.crm.getPipeline(fake.sales);
    for (const [title, stage] of [
      ['Early', stages[0]!],
      ['Later', stages[1]!]
    ] as const) {
      await fake.service.crm.createDeal(
        fake.sales,
        {
          title,
          primaryContactId: fake.ada.id,
          stageId: stage.id,
          amountMinor: 0,
          statusLine: null,
          nextActionText: null,
          nextActionDate: null,
          expectedCloseDate: null
        },
        { idempotencyKey: `seed-stage-${title}` }
      );
    }
    useApi('sales@example.com', fake);
    const { wrapper, router } = await mountWithApp(App, {
      route: `/deals?view=list&stage=${stages[1]!.id}`
    });
    expect(wrapper.find('tbody').text()).toContain('Later');
    expect(wrapper.find('tbody').text()).not.toContain('Early');
    const stage = wrapper
      .findAllComponents({ name: 'VSelect' })
      .find((select) => select.props('label') === 'Stage')!;
    expect(stage.props('modelValue')).toBe(stages[1]!.id);
    stage.vm.$emit('update:modelValue', stages[0]!.id);
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(router.currentRoute.value.query).toEqual({ view: 'list', stage: stages[0]!.id });
    expect(wrapper.find('tbody').text()).toContain('Early');
    stage.vm.$emit('update:modelValue', 'all');
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(wrapper.findAll('tbody tr')).toHaveLength(2);
    vi.useRealTimers();
  });

  it('refreshes the board and explains a move that lost a version race', async () => {
    const fake = await seeded();
    const deal = await fake.service.crm.createDeal(
      fake.sales,
      {
        title: 'Raced',
        primaryContactId: fake.ada.id,
        amountMinor: 0,
        statusLine: null,
        nextActionText: null,
        nextActionDate: null,
        expectedCloseDate: null
      },
      { idempotencyKey: 'seed-race-key' }
    );
    useApi('sales@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: '/deals' });
    await fake.service.crm.updateDeal(fake.sales, deal.id, { title: 'Raced again' }, 1, {
      idempotencyKey: 'other-race-key'
    });
    (
      document.body.querySelector('[aria-label="Move Raced to another stage"]') as HTMLButtonElement
    ).click();
    await settle();
    (
      [...document.body.querySelectorAll('.v-list-item')].find(
        (item) => item.textContent?.trim() === 'Qualified'
      ) as HTMLElement
    ).click();
    await settle();
    expect(wrapper.text()).toContain('was changed by someone else');
    expect(wrapper.text()).toContain('Raced again');
  });
});

describe('contact picker keyboard selection', () => {
  it('adds a searched person with Enter instead of submitting the parent activity form', async () => {
    const fake = await seeded();
    useApi('sales@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: `/contacts/${fake.ada.id}` });
    button('Log activity').click();
    await settle();
    const picker = document.body.querySelector(
      '.v-dialog input[type="search"]'
    ) as HTMLInputElement;
    picker.focus();
    picker.value = 'Grace';
    picker.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await settle();
    expect(document.body.textContent).toContain('Grace Analyst');
    picker.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    await settle();
    expect(document.body.textContent).toContain('Grace Analyst');
    expect(fake.store.count('activities')).toBe(0);
    const selected = wrapper.findComponent({ name: 'ContactPicker' }).props('modelValue') as {
      id: string;
    }[];
    expect(selected.map((contact) => contact.id)).toEqual([fake.ada.id, fake.grace.id]);
  });
});

describe('activities', () => {
  it('logs one meeting with two people from a contact; it appears on both timelines', async () => {
    const fake = await seeded();
    useApi('sales@example.com', fake);
    const { wrapper, router } = await mountWithApp(App, { route: `/contacts/${fake.ada.id}` });
    button('Log activity').click();
    await settle();
    type('Subject', 'Roadmap review');
    // The form defaults to the browser's clock; the fake Data Worker's clock is fixed earlier.
    type('When', '2026-10-11T08:00');
    // Add Grace through the picker's model (the autocomplete's own keyboard UI is Vuetify's).
    const picker = wrapper.findComponent({ name: 'ContactPicker' });
    picker.vm.$emit('update:modelValue', [
      { id: fake.ada.id, displayName: 'Ada Analyst' },
      { id: fake.grace.id, displayName: 'Grace Analyst' }
    ]);
    await settle();
    submit();
    await settle();
    expect(wrapper.text()).toContain('Meeting: Roadmap review');
    await router.push(`/contacts/${fake.grace.id}`);
    await settle();
    expect(wrapper.text()).toContain('Meeting: Roadmap review');
    expect(wrapper.text()).toContain('Ada Analyst');
  });

  it('requires at least one contact and a subject', async () => {
    const fake = await seeded();
    useApi('sales@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: `/contacts/${fake.ada.id}` });
    button('Log activity').click();
    await settle();
    wrapper.findComponent({ name: 'ContactPicker' }).vm.$emit('update:modelValue', []);
    type('Duration (minutes)', '0');
    await settle();
    submit();
    await settle();
    expect(document.body.textContent).toContain('Choose at least one contact.');
    expect(document.body.textContent).toContain('Subject is required.');
    expect(document.body.textContent).toContain('Duration must be 1–1440 whole minutes.');
    expect(fake.store.count('activities')).toBe(0);
  });
});

describe('next actions and the action stream', () => {
  it('sets a contact next action, shows it in the stream, and completes it there', async () => {
    const fake = await seeded();
    useApi('sales@example.com', fake);
    const { wrapper, router } = await mountWithApp(App, { route: `/contacts/${fake.grace.id}` });
    button('Set next action').click();
    await settle();
    type('What to do', 'Book a demo');
    submit();
    await settle();
    expect(wrapper.get('[data-testid="next-action"]').text()).toContain('Book a demo');

    await router.push('/actions');
    await settle();
    expect(wrapper.text()).toContain('As soon as possible (1)');
    expect(wrapper.get('[data-testid="urgency"]').text()).toBe('ASAP');
    (
      document.body.querySelector(
        '[aria-label="Mark done: Book a demo for Grace Analyst"]'
      ) as HTMLButtonElement
    ).click();
    await settle();
    expect(wrapper.text()).toContain('Nothing to chase');
  });

  it('shows overdue deal actions and the pipeline summary on the dashboard', async () => {
    const fake = await seeded();
    await fake.service.crm.createDeal(
      fake.sales,
      {
        title: 'Pipeline deal',
        primaryContactId: fake.ada.id,
        amountMinor: 250000,
        statusLine: null,
        nextActionText: 'Chase signature',
        nextActionDate: '2026-10-11',
        expectedCloseDate: '2026-12-15'
      },
      { idempotencyKey: 'seed-dash-key' }
    );
    useApi('sales@example.com', fake);
    const { wrapper } = await mountWithApp(App);
    expect(wrapper.text()).toContain('Chase signature');
    const panel = wrapper.get('[data-testid="pipeline-summary"]');
    expect(panel.text()).toContain('£2,500.00');
    // The total row says "Pipeline total"; the heading is "Pipeline summary", so the two never
    // read as a duplicate, and the table takes its accessible name from that heading.
    expect(panel.text()).toContain('Pipeline total');
    expect(panel.text()).not.toContain('Open total');
    const heading = document.getElementById(panel.get('table').attributes('aria-labelledby')!);
    expect(heading?.textContent).toBe('Pipeline summary');
    const quarter = panel.get('[data-testid="pipeline-this-quarter"]').text();
    expect(quarter).toContain('Pipeline this qtr');
    expect(quarter).toMatch(/Q\d 20\d\d: open deals expected to close/u);
    // The fake's clock decides the quarter, so compare with what the service reports.
    const expected = (await fake.service.crm.pipelineSummary(fake.sales)).thisQuarter;
    expect(quarter).toContain(expected.label);
    expect(quarter).toContain(String(expected.count));
  });

  it('links each pipeline-panel row to a deals list whose rows match the panel count', async () => {
    const fake = await seeded();
    const { stages } = await fake.service.crm.getPipeline(fake.sales);
    const make = async (title: string, stageId: string, status?: 'won' | 'lost') => {
      const deal = await fake.service.crm.createDeal(
        fake.sales,
        {
          title,
          primaryContactId: fake.ada.id,
          stageId,
          amountMinor: 1000,
          statusLine: null,
          nextActionText: null,
          nextActionDate: null,
          expectedCloseDate: null
        },
        { idempotencyKey: `seed-drill-${title.replace(' ', '-')}` }
      );
      if (status !== undefined) {
        await fake.service.crm.updateDeal(fake.sales, deal.id, { status }, 1, {
          idempotencyKey: `seed-close-${title.replace(' ', '-')}`
        });
      }
    };
    await make('Lead one', stages[0]!.id);
    await make('Lead two', stages[0]!.id);
    await make('Qualified one', stages[1]!.id);
    await make('Won one', stages[1]!.id, 'won');
    await make('Lost one', stages[0]!.id, 'lost');
    useApi('sales@example.com', fake);
    const { wrapper, router } = await mountWithApp(App);
    const panel = () => wrapper.get('[data-testid="pipeline-summary"]');
    const cases: [string, number][] = [
      [`Show open deals in ${stages[0]!.label}`, 2],
      [`Show open deals in ${stages[1]!.label}`, 1],
      ['Show all open deals', 3],
      ['Show won deals', 1],
      ['Show lost deals', 1]
    ];
    for (const [label, expected] of cases) {
      await router.push('/');
      await settle();
      const link = panel().get(`a[aria-label="${label}"]`);
      // The panel's count for that row is in the next cell.
      expect(link.element.closest('tr')!.querySelector('td')!.textContent?.trim()).toBe(
        String(expected)
      );
      await router.push(link.attributes('href')!);
      await settle();
      expect(router.currentRoute.value.query.view).toBe('list');
      expect(wrapper.findAll('tbody tr'), label).toHaveLength(expected);
    }
  });

  it('explains a next action that changed before completion', async () => {
    const fake = await seeded();
    await fake.service.crm.setContactNextAction(
      fake.sales,
      fake.ada.id,
      { text: 'Old', dueDate: null },
      null,
      { idempotencyKey: 'seed-na-key' }
    );
    useApi('sales@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: '/actions' });
    await fake.service.crm.completeContactNextAction(fake.sales, fake.ada.id, 1, {
      idempotencyKey: 'other-done-key'
    });
    (
      document.body.querySelector(
        '[aria-label="Mark done: Old for Ada Analyst"]'
      ) as HTMLButtonElement
    ).click();
    await settle();
    expect(wrapper.text()).toContain('That action has already changed.');
    // The row is gone; focus lands on the page heading rather than <body>.
    expect(document.activeElement?.tagName).toBe('H1');
  });

  it('sets, cancels, conflicts on, and completes a contact next action from its card', async () => {
    const fake = await seeded();
    useApi('sales@example.com', fake);
    const { wrapper, router } = await mountWithApp(App, { route: `/contacts/${fake.ada.id}` });
    const card = () => wrapper.findAll('.v-card').find((c) => c.text().startsWith('Next action'))!;
    expect(card().text()).toContain('No next action set.');

    // Cancel discards the draft without a request.
    button('Set next action').click();
    await settle();
    type('What to do', 'Draft');
    button('Cancel').click();
    await settle();
    expect(card().text()).toContain('No next action set.');

    button('Set next action').click();
    await settle();
    type('What to do', 'Call Ada');
    button('Save next action').click();
    await settle();
    expect(card().get('[data-testid="next-action"]').text()).toContain('As soon as possible');

    // Someone else completes it first: Done explains why instead of failing silently.
    await fake.service.crm.completeContactNextAction(fake.sales, fake.ada.id, 1, {
      idempotencyKey: 'card-other-done'
    });
    button('Done').click();
    await settle();
    expect(card().get('[role="alert"]').text()).toContain('This contact has no open next action.');

    // After a reload the card shows the current (empty) state; set a dated one and complete it.
    await fake.service.crm.setContactNextAction(
      fake.sales,
      fake.ada.id,
      { text: 'Send quote', dueDate: '2026-10-20' },
      null,
      { idempotencyKey: 'card-set-dated' }
    );
    await router.push('/contacts');
    await router.push(`/contacts/${fake.ada.id}`);
    await settle();
    expect(card().text()).toContain('Send quote');
    expect(card().text()).not.toContain('As soon as possible');
    button('Done').click();
    await settle();
    expect(card().text()).toContain('No next action set.');
  });
});
