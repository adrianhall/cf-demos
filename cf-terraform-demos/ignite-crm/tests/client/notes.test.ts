/**
 * @file The notes SPA in the DOM, against the real API app and the SQLite-backed fake Data Worker:
 *   the review scenario (one meeting note linked to two contacts, their company, the deal, and its
 *   project, then found by search and opened from every record), search loading/empty/error states,
 *   an invalid-link error kept on its chip, conflict recovery with a preserved draft, the
 *   author-or-manager edit rule, and role-based visibility.
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
  return { idempotencyKey: `notes-ui-seed-${++keyCounter}` };
}

/**
 * Seed two contacts at one company, a deal, and its project, with one user per role.
 *
 * @returns The fake, actors, and records.
 */
async function seeded() {
  const fake = createFakeDataService({
    runtime: testRuntime(new Date('2026-10-11T09:00:00.000Z'))
  });
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
  actor('manager@example.com', 'manager');
  actor('readonly@example.com', 'read-only');
  const person = (firstName: string, companyId: string | null) =>
    fake.service.crm.createContact(
      sales,
      {
        firstName,
        lastName: null,
        email: null,
        phone: null,
        jobTitle: null,
        companyId,
        companyName: companyId === null ? 'Northwind Traders' : null
      },
      key()
    );
  const priya = await person('Priya', null);
  const companyId = priya.company!.id;
  const tom = await person('Tom', companyId);
  const deal = await fake.service.crm.createDeal(
    sales,
    {
      title: 'Support renewal',
      primaryContactId: priya.id,
      amountMinor: 100,
      statusLine: null,
      nextActionText: null,
      nextActionDate: null,
      expectedCloseDate: null
    },
    key()
  );
  const project = await fake.service.projects.convertDeal(
    sales,
    deal.id,
    { markWon: true, name: 'Support rollout' },
    deal.version,
    key()
  );
  return { ...fake, sales, delivery, priya, tom, companyId, deal, project };
}

/**
 * Find a button by its visible text anywhere in the document (dialogs teleport to `body`).
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
 * Type into the input or textarea of the Vuetify field with a given label.
 *
 * @param label Field label text.
 * @param value New value.
 */
function fill(label: string, value: string): void {
  const field = [...document.body.querySelectorAll('.v-field')].find(
    (candidate) => candidate.querySelector('label')?.textContent?.trim() === label
  );
  const input = field?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  if (input === undefined || input === null) {
    throw new Error(`No field "${label}"`);
  }
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

/**
 * Choose a record type in the link chooser and search for a record, waiting out the debounce. The
 * type is set through the Vuetify select's own `update:modelValue`, as the other client suites do;
 * opening its overlay menu in jsdom adds nothing to what is under test.
 *
 * @param wrapper The mounted app.
 * @param type Record type.
 * @param text Search text.
 */
async function searchLinks(
  wrapper: VueWrapper,
  type: 'contact' | 'company' | 'deal' | 'project',
  text: string
): Promise<void> {
  const select = wrapper
    .findAllComponents({ name: 'VSelect' })
    .find((candidate) => candidate.props('label') === 'Record type') as VueWrapper;
  select.vm.$emit('update:modelValue', type);
  await settle();
  fill(`Search ${type} records`, text);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await settle();
}

beforeEach(() => {
  resetSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the multi-linked meeting note', () => {
  it('is written from the project, linked to five records, searched, and opened from each', async () => {
    const fake = await seeded();
    useApi('sales@example.com', fake);
    const { wrapper, router } = await mountWithApp(App, { route: `/projects/${fake.project.id}` });
    expect(document.body.querySelector('[data-testid="notes-card"]')?.textContent).toContain(
      'No notes about this record yet.'
    );

    button('New note').click();
    await settle();
    // The note starts linked to the project it was written from.
    expect(labelled('Linked records: 1 chosen').textContent).toContain('Support rollout');
    fill('Title', 'Kick-off with Northwind');
    fill('Body', '# Agenda\n\n- Agreed **zephyr** milestones\n- [ ] Send the plan');
    await settle();
    await searchLinks(wrapper, 'contact', 'Pri');
    labelled('Link contact Priya').click();
    await settle();
    await searchLinks(wrapper, 'contact', 'Tom');
    labelled('Link contact Tom').click();
    await searchLinks(wrapper, 'company', 'North');
    labelled('Link company Northwind Traders').click();
    await searchLinks(wrapper, 'deal', 'Support');
    labelled('Link deal Support renewal').click();
    await settle();
    expect(labelled('Linked records: 5 chosen')).toBeDefined();
    button('Create note').click();
    await settle();

    expect(router.currentRoute.value.name).toBe('note');
    const noteId = router.currentRoute.value.params.id as string;
    expect(wrapper.get('h1').text()).toBe('Kick-off with Northwind');
    const body = labelled('Kick-off with Northwind (note body)');
    expect(body.querySelector('h3')?.textContent).toBe('Agenda');
    expect(body.querySelector('strong')?.textContent).toBe('zephyr');
    expect(body.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
    expect(labelled('Linked records').textContent).toContain('Northwind Traders');

    // Search finds it, with the matched word highlighted.
    await router.push('/notes');
    await settle();
    fill('Search notes', 'zeph');
    button('Search').click();
    await settle();
    expect(document.body.textContent).toContain('1 note matches “zeph”');
    expect(document.body.querySelector('[data-testid="snippet"] mark')?.textContent).toBe('zephyr');
    // Search text never reaches the URL.
    expect(router.currentRoute.value.fullPath).toBe('/notes');

    // The same note from every linked record.
    for (const path of [
      `/contacts/${fake.priya.id}`,
      `/contacts/${fake.tom.id}`,
      `/companies/${fake.companyId}`,
      `/deals/${fake.deal.id}`,
      `/projects/${fake.project.id}`
    ]) {
      await router.push(path);
      await settle();
      const card = document.body.querySelector('[data-testid="notes-card"]');
      const link = card?.querySelector<HTMLAnchorElement>('a[href^="/notes/"]');
      expect(link?.getAttribute('href'), path).toBe(`/notes/${noteId}`);
    }
  });

  it('keeps the draft and marks the link when a target disappears before saving', async () => {
    const fake = await seeded();
    useApi('sales@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: `/contacts/${fake.priya.id}` });
    button('New note').click();
    await settle();
    fill('Title', 'Doomed link');
    fill('Body', 'Text I do not want to lose.');
    await searchLinks(wrapper, 'deal', 'Support');
    labelled('Link deal Support renewal').click();
    await settle();
    fake.store.exec(
      'UPDATE deals SET deleted_at = ? WHERE id = ?',
      '2026-10-11T08:00:00.000Z',
      fake.deal.id
    );
    button('Create note').click();
    await settle();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('form-summary');
    expect(document.body.textContent).toContain(
      'This record does not exist or is no longer available.'
    );
    expect(document.body.querySelector('textarea')?.value).toBe('Text I do not want to lose.');
    // Removing the bad link with the keyboard-reachable button lets the note save.
    labelled('Remove Support renewal').click();
    await settle();
    button('Create note').click();
    await settle();
    expect(fake.store.count('notes')).toBe(1);
  });

  it('refuses an empty note locally and names each missing part', async () => {
    const fake = await seeded();
    useApi('sales@example.com', fake);
    await mountWithApp(App, { route: '/notes' });
    button('New note').click();
    await settle();
    button('Create note').click();
    await settle();
    expect(document.body.textContent).toContain('Title is required.');
    expect(document.body.textContent).toContain('Body is required.');
    expect(document.body.textContent).toContain('Link the note to at least one record.');
    expect(fake.store.count('notes')).toBe(0);
  });
});

describe('the notes card on a record page', () => {
  it('fails inside its card without hiding the record, then retries', async () => {
    const fake = await seeded();
    useApi('sales@example.com', fake);
    const realFetch = globalThis.fetch;
    let failNotes = true;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) =>
      failNotes && input.startsWith('/api/v1/notes?')
        ? new Response(
            JSON.stringify({
              type: 'about:blank',
              status: 503,
              title: 'Unavailable',
              detail: 'Try later.'
            }),
            { status: 503, headers: { 'Content-Type': 'application/problem+json' } }
          )
        : realFetch(input, init)
    );
    const { wrapper } = await mountWithApp(App, { route: `/contacts/${fake.priya.id}` });
    expect(wrapper.get('h1').text()).toBe('Priya');
    expect(document.body.querySelector('[data-testid="notes-error"]')?.textContent).toContain(
      'Notes could not be loaded.'
    );
    failNotes = false;
    button('Retry').click();
    await settle();
    expect(document.body.querySelector('[data-testid="notes-error"]')).toBeNull();
    expect(document.body.textContent).toContain('No notes about this record yet.');
  });

  it('pages a long feed with Show more notes', async () => {
    const fake = await seeded();
    for (let index = 0; index < 27; index++) {
      await fake.service.notes.createNote(
        fake.sales,
        { title: `Note ${index}`, markdown: 'Body', links: [{ type: 'contact', id: fake.tom.id }] },
        key()
      );
    }
    useApi('readonly@example.com', fake);
    await mountWithApp(App, { route: `/contacts/${fake.tom.id}` });
    const card = () => document.body.querySelector('[data-testid="notes-card"]')!;
    expect(card().querySelectorAll('a[href^="/notes/"]')).toHaveLength(25);
    expect(card().textContent).not.toContain('New note');
    button('Show more notes').click();
    await settle();
    expect(card().querySelectorAll('a[href^="/notes/"]')).toHaveLength(27);
  });
});

describe('search states', () => {
  it('validates length, shows an empty result, recovers from an error, and clears', async () => {
    const fake = await seeded();
    await fake.service.notes.createNote(
      fake.sales,
      { title: 'Pricing call', markdown: 'Body', links: [{ type: 'deal', id: fake.deal.id }] },
      key()
    );
    useApi('readonly@example.com', fake);
    await mountWithApp(App, { route: '/notes' });
    expect(document.body.textContent).toContain('Pricing call');
    expect(() => button('New note')).toThrow();

    fill('Search notes', 'p');
    button('Search').click();
    await settle();
    expect(document.body.textContent).toContain('Search for at least 2 characters.');

    fill('Search notes', 'nothinglikeit');
    button('Search').click();
    await settle();
    expect(document.body.textContent).toContain('No matching notes');

    fake.store.failing = true;
    fill('Search notes', 'pricing');
    button('Search').click();
    await settle();
    expect(document.body.textContent).toContain('Temporarily unavailable');
    fake.store.failing = false;
    button('Retry').click();
    await settle();
    expect(document.body.textContent).toContain('1 note matches “pricing”');

    button('Clear').click();
    await settle();
    expect(document.body.textContent).toContain('Recently updated');
  });
});

describe('editing a note', () => {
  /**
   * A seeded fake with one note by the sales user.
   *
   * @returns The fake and the note.
   */
  async function withNote() {
    const fake = await seeded();
    const note = await fake.service.notes.createNote(
      fake.sales,
      {
        title: 'Weekly sync',
        markdown: 'First draft',
        links: [
          { type: 'contact', id: fake.priya.id },
          { type: 'project', id: fake.project.id }
        ]
      },
      key()
    );
    return { ...fake, note };
  }

  it('lets the author edit text and remove a link, then shows the new version', async () => {
    const fake = await withNote();
    useApi('sales@example.com', fake);
    await mountWithApp(App, { route: `/notes/${fake.note.id}` });
    button('Edit note').click();
    await settle();
    fill('Body', 'Second draft');
    labelled('Remove Support rollout').click();
    await settle();
    button('Save note').click();
    await settle();
    expect(labelled('Weekly sync (note body)').textContent).toContain('Second draft');
    expect(labelled('Linked records').textContent).not.toContain('Support rollout');
    expect((await fake.service.notes.getNote(fake.sales, fake.note.id)).note.version).toBe(2);
  });

  it('keeps the draft on a conflict and saves only the user’s change after reloading', async () => {
    const fake = await withNote();
    useApi('sales@example.com', fake);
    await mountWithApp(App, { route: `/notes/${fake.note.id}` });
    button('Edit note').click();
    await settle();
    fill('Title', 'My title');
    await fake.service.notes.updateNote(
      fake.sales,
      fake.note.id,
      { markdown: 'Their body' },
      1,
      key()
    );
    button('Save note').click();
    await settle();
    expect(document.body.querySelector('[data-testid="conflict"]')).not.toBeNull();
    button('Load latest version').click();
    await settle();
    expect(document.body.textContent).toContain('The latest version is loaded.');
    button('Save note').click();
    await settle();
    const { note } = await fake.service.notes.getNote(fake.sales, fake.note.id);
    expect({ title: note.title, markdown: note.markdown, version: note.version }).toEqual({
      title: 'My title',
      markdown: 'Their body',
      version: 3
    });
  });

  it('offers Edit to the author and managers only', async () => {
    const fake = await withNote();
    for (const [email, visible] of [
      ['delivery@example.com', false],
      ['readonly@example.com', false],
      ['manager@example.com', true]
    ] as const) {
      useApi(email, fake);
      const { wrapper } = await mountWithApp(App, { route: `/notes/${fake.note.id}` });
      expect(document.body.textContent).toContain('Weekly sync');
      const hasEdit = [...document.body.querySelectorAll('button')].some(
        (candidate) => candidate.textContent?.trim() === 'Edit note'
      );
      expect(hasEdit, email).toBe(visible);
      wrapper.unmount();
      document.body.innerHTML = '';
      resetSession();
      vi.unstubAllGlobals();
    }
  });

  it('shows a tombstone for a deleted linked record', async () => {
    const fake = await withNote();
    fake.store.exec('UPDATE projects SET deleted_at = ? WHERE id = ?', 'x', fake.project.id);
    useApi('sales@example.com', fake);
    await mountWithApp(App, { route: `/notes/${fake.note.id}` });
    const list = labelled('Linked records');
    expect(list.textContent).toContain('Project · deleted');
    // A tombstone is not a link.
    expect(list.querySelectorAll('a')).toHaveLength(1);
  });
});
