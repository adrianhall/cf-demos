/**
 * @file Team administration and the audit trail in the DOM, against the real API app and the
 *   SQLite-backed fake Data Worker: an owner adds a teammate and changes their role, after which a
 *   second session with that identity sees different controls and a different server boundary;
 *   role-form validation; the final-owner refusal shown in the dialog; suspension with
 *   confirmation; capability hints versus server denials; keyboard-reachable controls; and audit
 *   filtering, paging, and redaction.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VueWrapper } from '@vue/test-utils';
import App from '../../src/client/App.vue';
import { resetSession } from '../../src/client/composables/useSession.ts';
import type { ActorContext } from '../../src/shared/data-service/contract.ts';
import type { Role } from '../../src/shared/permissions.ts';
import { createFakeDataService, testRuntime } from '../fakes/fake-data-service.ts';
import { mountWithApp, settle, useApi } from './support.ts';

let keyCounter = 0;

/**
 * A fresh idempotency key for seeding.
 *
 * @returns Mutation metadata.
 */
function key(): { idempotencyKey: string } {
  return { idempotencyKey: `team-ui-seed-${++keyCounter}` };
}

/**
 * A fake with one user per role.
 *
 * @returns The fake and actors.
 */
function seeded() {
  const fake = createFakeDataService({
    runtime: testRuntime(new Date('2026-10-11T09:00:00.000Z'))
  });
  const actors = new Map<Role, ActorContext>();
  for (const role of ['owner', 'manager', 'sales', 'delivery', 'read-only'] as const) {
    const email = role === 'read-only' ? 'readonly@example.com' : `${role}@example.com`;
    actors.set(role, {
      email,
      userId: fake.store.addUser(email, role),
      requestId: 'seed',
      channel: 'api'
    });
  }
  return { ...fake, actor: (role: Role) => actors.get(role)! };
}

/**
 * Find a button by visible text anywhere in the document (dialogs teleport to `body`).
 *
 * @param text Button text.
 * @returns The button, or `undefined`.
 */
function findButton(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === text
  );
}

/**
 * Find a button by visible text, failing when absent.
 *
 * @param text Button text.
 * @returns The button.
 */
function button(text: string): HTMLButtonElement {
  const found = findButton(text);
  if (found === undefined) {
    throw new Error(`No button "${text}"`);
  }
  return found;
}

/**
 * Find a button by visible text inside the open dialog.
 *
 * @param text Button text.
 * @returns The button.
 */
function dialogButton(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('.v-overlay--active .v-card button')].find(
    (candidate) => candidate.textContent?.trim() === text
  ) as HTMLButtonElement | undefined;
  if (found === undefined) {
    throw new Error(`No dialog button "${text}"`);
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
 * Type into the Vuetify field with a given label.
 *
 * @param label Field label text.
 * @param value New value.
 */
function fill(label: string, value: string): void {
  const field = [...document.body.querySelectorAll('.v-field')].find(
    (candidate) => candidate.querySelector('label')?.textContent?.trim() === label
  );
  const input = field?.querySelector<HTMLInputElement>('input');
  if (input === undefined || input === null) {
    throw new Error(`No field "${label}"`);
  }
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

/**
 * Toggle the role checkbox with a given label.
 *
 * @param label Role label.
 */
function toggleRole(label: string): void {
  const checkbox = [
    ...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  ].find(
    (input) => input.closest('.v-checkbox')?.querySelector('label')?.textContent?.trim() === label
  );
  if (checkbox === undefined) {
    throw new Error(`No role "${label}"`);
  }
  checkbox.click();
}

/**
 * Remount the app as another identity.
 *
 * @param wrapper The current app.
 * @param email The identity.
 * @param fake The shared fake.
 * @param route Where to start.
 * @returns The new mount.
 */
async function switchUser(
  wrapper: VueWrapper,
  email: string,
  fake: ReturnType<typeof seeded>,
  route: string
) {
  wrapper.unmount();
  document.body.innerHTML = '';
  resetSession();
  vi.unstubAllGlobals();
  useApi(email, fake);
  return mountWithApp(App, { route });
}

beforeEach(() => {
  resetSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the team page', () => {
  it('lets an owner add a teammate and promote them; the teammate’s next session changes', async () => {
    const fake = seeded();
    useApi('owner@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: '/team' });
    expect(wrapper.get('h1').text()).toBe('Team');
    expect(labelled('Team members').textContent).toContain('sales@example.com');

    button('Add teammate').click();
    await settle();
    fill('Access e-mail', 'pat@example.com');
    fill('Display name', 'Pat Partner');
    await settle();
    dialogButton('Add teammate').click();
    await settle();
    expect(labelled('Team members').textContent).toContain('Pat Partner');

    // Pat signs in read-only: no create controls, and the server refuses a write.
    let session = await switchUser(wrapper, 'pat@example.com', fake, '/contacts');
    expect(findButton('New contact')).toBeUndefined();
    expect(document.body.textContent).not.toContain('Audit trail');
    const pat = fake.store.userId('pat@example.com');
    await expect(
      fake.service.crm.createContact(
        { email: 'pat@example.com', userId: pat, requestId: 'r', channel: 'api' },
        {
          firstName: 'X',
          lastName: null,
          email: null,
          phone: null,
          jobTitle: null,
          companyId: null,
          companyName: 'Y'
        },
        key()
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // The owner makes Pat a manager.
    session = await switchUser(session.wrapper, 'owner@example.com', fake, '/team');
    labelled('Change roles for Pat Partner').click();
    await settle();
    toggleRole('Read-only');
    await settle();
    toggleRole('Manager');
    await settle();
    dialogButton('Save roles').click();
    await settle();
    expect(labelled('Team members').textContent).toContain('Manager');

    // Pat's next session: manager navigation and controls, and the server now allows.
    session = await switchUser(session.wrapper, 'pat@example.com', fake, '/audit');
    expect(session.wrapper.get('h1').text()).toBe('Audit trail');
    expect(labelled('Audit events').textContent).toContain('roles-changed');
    expect(document.body.textContent).toContain('Team');
    session.wrapper.unmount();
  });

  it('validates the invite form locally and keeps a refused role change in the dialog', async () => {
    const fake = seeded();
    useApi('owner@example.com', fake);
    await mountWithApp(App, { route: '/team' });
    button('Add teammate').click();
    await settle();
    toggleRole('Read-only');
    await settle();
    dialogButton('Add teammate').click();
    await settle();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('form-summary');
    for (const message of [
      'Must be a valid e-mail address.',
      'Display name is required.',
      'Choose at least one role.'
    ]) {
      expect(document.body.textContent).toContain(message);
    }
    dialogButton('Cancel').click();
    await settle();

    // Removing the only owner is refused by the server; the dialog explains and keeps the choice.
    labelled('Change roles for owner').click();
    await settle();
    toggleRole('Owner');
    await settle();
    toggleRole('Manager');
    await settle();
    dialogButton('Save roles').click();
    await settle();
    expect(document.body.textContent).toContain('The team must keep at least one active owner.');
    expect(document.body.querySelector('.v-overlay--active')).not.toBeNull();
    expect(fake.store.count('user_roles', "role_id = 'owner'")).toBe(1);
  });

  it('suspends after confirmation and offers no self-suspension', async () => {
    const fake = seeded();
    useApi('owner@example.com', fake);
    await mountWithApp(App, { route: '/team' });
    expect(document.body.querySelector('[aria-label="Suspend owner"]')).toBeNull();
    labelled('Suspend delivery').click();
    await settle();
    expect(document.body.textContent).toContain('They will be refused on their next request.');
    dialogButton('Suspend').click();
    await settle();
    expect(labelled('Team members').textContent).toContain('Suspended');
    await expect(fake.service.resolveActor('delivery@example.com', 'r')).rejects.toMatchObject({
      code: 'FORBIDDEN'
    });
    labelled('Reactivate delivery').click();
    await settle();
    dialogButton('Reactivate').click();
    await settle();
    expect(labelled('Team members').textContent).not.toContain('Suspended');
  });

  it('refreshes the owner’s own capability hints after they change their own roles', async () => {
    const fake = seeded();
    // A second owner, so the first may step down.
    await fake.service.permissions.setUserRoles(
      fake.actor('owner'),
      fake.actor('manager').userId,
      { roles: ['owner'] },
      1,
      key()
    );
    useApi('owner@example.com', fake);
    await mountWithApp(App, { route: '/team' });
    expect(document.body.querySelector('[data-testid="identity"]')?.textContent).toContain('Owner');
    labelled('Change roles for owner').click();
    await settle();
    toggleRole('Owner');
    await settle();
    toggleRole('Sales representative');
    await settle();
    dialogButton('Save roles').click();
    await settle();
    expect(document.body.querySelector('[data-testid="identity"]')?.textContent).toContain(
      'Sales representative'
    );
    // No longer an owner: the management controls disappear without a reload.
    expect(findButton('Add teammate')).toBeUndefined();
    expect(document.body.querySelector('nav')?.textContent).not.toContain('Audit trail');
  });

  it('shows managers a read-only directory and others a forbidden state', async () => {
    const fake = seeded();
    useApi('manager@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: '/team' });
    expect(document.body.textContent).toContain('Only an owner can change the team.');
    expect(findButton('Add teammate')).toBeUndefined();
    expect(findButton('Roles')).toBeUndefined();

    // A sales user who types the URL: hidden from navigation, and the server says no.
    const sales = await switchUser(wrapper, 'sales@example.com', fake, '/team');
    expect(document.body.querySelector('nav')?.textContent).not.toContain('Team');
    expect(document.body.textContent).toContain('You do not have access');
    sales.wrapper.unmount();
  });
});

describe('the audit trail', () => {
  it('filters by area and record, links to records, and never shows note text', async () => {
    const fake = seeded();
    const sales = fake.actor('sales');
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
    await fake.service.notes.createNote(
      sales,
      {
        title: 'Budget call',
        markdown: 'Their budget is exactly £1.2m',
        links: [{ type: 'contact', id: contact.id }]
      },
      key()
    );
    useApi('manager@example.com', fake);
    const { router, wrapper } = await mountWithApp(App, { route: '/audit' });
    const table = () => labelled('Audit events');
    expect(table().textContent).toContain('Budget call');
    expect(document.body.textContent).not.toContain('£1.2m');
    expect(document.body.querySelector('[data-testid="audit-details"]')?.textContent).toMatch(
      /digest: [0-9a-f]{12}…/u
    );

    const select = wrapper
      .findAllComponents({ name: 'VSelect' })
      .find((candidate) => candidate.props('label') === 'Area') as VueWrapper;
    select.vm.$emit('update:modelValue', 'crm');
    await settle();
    expect(router.currentRoute.value.query).toEqual({ module: 'crm' });
    expect(table().textContent).not.toContain('Budget call');
    const link = table().querySelector<HTMLAnchorElement>(`a[href="/contacts/${contact.id}"]`);
    expect(link?.textContent).toBe('Ada');

    button('Clear filters').click();
    await settle();
    expect(router.currentRoute.value.query).toEqual({});
  });

  it('pages with Load more and opens filtered from a URL', async () => {
    const fake = seeded();
    const owner = fake.actor('owner');
    for (let index = 0; index < 27; index++) {
      await fake.service.crm.createCompany(owner, { name: `Company ${index}` } as never, key());
    }
    useApi('owner@example.com', fake);
    await mountWithApp(App, { route: '/audit?entityType=company' });
    const rows = () => labelled('Audit events').querySelectorAll('tbody tr').length;
    expect(rows()).toBe(25);
    button('Load more').click();
    await settle();
    expect(rows()).toBe(27);
    expect(findButton('Load more')).toBeUndefined();
  });

  it('is hidden from roles without audit.read, and the server refuses them', async () => {
    const fake = seeded();
    useApi('delivery@example.com', fake);
    await mountWithApp(App, { route: '/audit' });
    expect(document.body.querySelector('nav')?.textContent).not.toContain('Audit trail');
    expect(document.body.textContent).toContain('You do not have access');
  });
});
