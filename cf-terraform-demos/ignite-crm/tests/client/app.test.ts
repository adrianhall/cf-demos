/**
 * @file The SPA end to end in the DOM: shell, identity, dashboard, contacts, and details — against
 *   the real API app and the fake Data Worker.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import App from '../../src/client/App.vue';
import ContactForm from '../../src/client/components/ContactForm.vue';
import ResourceState from '../../src/client/components/ResourceState.vue';
import { resetSession } from '../../src/client/composables/useSession.ts';
import { ApiError } from '../../src/client/services/api-client.ts';
import { primaryRole } from '../../src/client/services/roles.ts';
import { createAppVuetify } from '../../src/client/vuetify.ts';
import { createFakeDataService } from '../fakes/fake-data-service.ts';
import { mountWithApp, settle, useApi } from './support.ts';

/**
 * Seed a fake with users and one contact.
 *
 * @returns The fake.
 */
async function seeded() {
  const fake = createFakeDataService();
  const salesId = fake.store.addUser('sales@example.com', 'sales');
  fake.store.addUser('readonly@example.com', 'read-only');
  await fake.service.crm.createContact(
    { email: 'sales@example.com', userId: salesId, requestId: 'seed', channel: 'api' },
    {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      phone: null,
      jobTitle: 'Analyst',
      companyId: null,
      companyName: 'Analytical Engines'
    },
    { idempotencyKey: 'seed-contact-1' }
  );
  return fake;
}

beforeEach(() => {
  resetSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('shell', () => {
  it('shows the signed-in identity and role, and the dashboard counts', async () => {
    useApi('sales@example.com', await seeded());
    const { wrapper } = await mountWithApp(App);
    expect(wrapper.get('[data-testid="identity"]').text()).toContain('Sales representative');
    expect(wrapper.text()).toContain('Dashboard');
    expect(wrapper.text()).toContain('Ada Lovelace');
    expect(wrapper.find('a.skip-link').attributes('href')).toBe('#main');
    expect(wrapper.find('nav[aria-label="Main navigation"]').exists()).toBe(true);
  });

  it('explains a session failure and retries', async () => {
    const fake = await seeded();
    fake.store.failing = true;
    useApi('sales@example.com', fake);
    const { wrapper } = await mountWithApp(App);
    expect(wrapper.get('[role="alert"]').text()).toContain('temporarily unavailable');
    fake.store.failing = false;
    await wrapper.get('[role="alert"] button').trigger('click');
    await settle();
    expect(wrapper.text()).toContain('Recently updated contacts');
  });

  it('navigates and moves focus to the new page heading', async () => {
    useApi('sales@example.com', await seeded());
    const { wrapper, router } = await mountWithApp(App);
    await router.push('/companies');
    await settle();
    expect(document.activeElement?.textContent).toBe('Companies');
    expect(document.title).toBe('Companies · Ignite CRM');
    expect(wrapper.text()).toContain('Analytical Engines');
    await router.push('/nowhere');
    await settle();
    expect(wrapper.text()).toContain('Page not found');
  });
});

describe('account menu and page', () => {
  it('opens a labelled account menu that links to the account page and to sign-out', async () => {
    useApi('sales@example.com', await seeded());
    const { wrapper, router } = await mountWithApp(App);
    const trigger = wrapper.get('[data-testid="identity"]');
    // The fake names each user after their e-mail's local part.
    expect(trigger.attributes('aria-label')).toBe('Account menu: sales, Sales representative');
    await trigger.trigger('click');
    await settle();
    expect(document.body.querySelector('[data-testid="account-summary"]')?.textContent).toContain(
      'sales@example.com'
    );
    const signOut = [...document.body.querySelectorAll<HTMLAnchorElement>('a')].find(
      (link) => link.textContent?.trim() === 'Sign out'
    );
    expect(signOut?.getAttribute('href')).toBe('/cdn-cgi/access/logout');
    const account = [...document.body.querySelectorAll<HTMLAnchorElement>('a')].find(
      (link) => link.textContent?.trim() === 'Your account'
    )!;
    account.click();
    await settle();
    expect(router.currentRoute.value.name).toBe('account');
    expect(document.activeElement?.textContent).toBe('Your account');
    const page = wrapper.get('section[aria-labelledby="account-title"]').text();
    expect(page).toContain('sales@example.com');
    expect(page).toContain('Sales representative');
    expect(page).toContain('Create and edit contacts, companies, deals, and activities');
    expect(page).not.toContain('Read the audit trail');
    expect(page).toContain('Ask an owner to change your display name or roles.');
  });

  it('picks the most privileged role for the account icon', () => {
    expect(primaryRole(['sales', 'manager'])).toBe('manager');
    expect(primaryRole(['delivery'])).toBe('delivery');
    // A session always carries a role, but an empty list falls back to the least privileged.
    expect(primaryRole([])).toBe('read-only');
  });

  it('describes a read-only user’s narrower capabilities', async () => {
    useApi('readonly@example.com', await seeded());
    const { wrapper } = await mountWithApp(App, { route: '/account' });
    const list = wrapper.get('[aria-label="Your permissions"]').text();
    expect(list).toContain('See contacts, companies, and deals');
    expect(list).not.toContain('Create and edit');
  });
});

describe('shell accessibility', () => {
  it('reports the drawer state, keeps focus while only the query changes, and gives 404 an h1', async () => {
    useApi('sales@example.com', await seeded());
    const { wrapper, router } = await mountWithApp(App);
    const toggle = wrapper.get('[aria-label="Toggle navigation"]');
    expect(toggle.attributes('aria-controls')).toBe('main-navigation');
    const before = toggle.attributes('aria-expanded');
    await toggle.trigger('click');
    await settle();
    expect(toggle.attributes('aria-expanded')).not.toBe(before);

    await router.push('/companies');
    await settle();
    const search = document.body.querySelector<HTMLInputElement>('input');
    search?.focus();
    await router.replace({ query: { q: 'x' } });
    await settle();
    expect(document.activeElement).toBe(search);

    await router.push('/no-such-page');
    await settle();
    expect(document.activeElement?.tagName).toBe('H1');
    expect(document.activeElement?.textContent).toBe('Page not found');
  });

  it('returns focus to the button that opened a dialog when it is cancelled', async () => {
    useApi('sales@example.com', await seeded());
    await mountWithApp(App, { route: '/contacts' });
    const opener = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'New contact'
    )!;
    opener.focus();
    opener.click();
    await settle();
    const cancel = [
      ...document.body.querySelectorAll<HTMLButtonElement>('.v-overlay--active button')
    ].find((button) => button.textContent?.trim() === 'Cancel')!;
    cancel.click();
    await settle();
    expect(document.activeElement).toBe(opener);
  });
});

describe('expired sign-in', () => {
  it('asks the user to sign in again, with a reload instead of a retry', async () => {
    useApi('sales@example.com', await seeded());
    const { router } = await mountWithApp(App, { route: '/' });
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } })
      )
    );
    await router.push('/companies');
    await settle();
    expect(document.body.textContent).toContain('Please sign in again');
    const button = [...document.body.querySelectorAll('[role="alert"] button')].find(
      (candidate) => candidate.textContent?.trim() === 'Sign in'
    ) as HTMLButtonElement;
    expect(
      [...document.body.querySelectorAll('[role="alert"] button')].some(
        (candidate) => candidate.textContent?.trim() === 'Retry'
      )
    ).toBe(false);
    button.click();
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe('lazy route chunks', () => {
  it('shows progress while a view loads and offers a reload when its chunk fails', async () => {
    useApi('sales@example.com', await seeded());
    const { wrapper, router } = await mountWithApp(App);
    let release!: () => void;
    router.addRoute({
      path: '/slow',
      name: 'slow',
      component: () =>
        new Promise((resolve) => {
          release = () => resolve({ render: () => null });
        })
    });
    router.addRoute({
      path: '/broken',
      name: 'broken',
      component: () => Promise.reject(new Error('Failed to fetch dynamically imported module'))
    });
    const pending = router.push('/slow');
    await settle();
    // `aria-hidden` follows the `active` prop (the --active class also needs an intersection
    // observer, which jsdom does not drive).
    expect(wrapper.get('[aria-label="Loading page"]').attributes('aria-hidden')).toBe('false');
    release();
    await pending;
    await settle();
    expect(wrapper.get('[aria-label="Loading page"]').attributes('aria-hidden')).toBe('true');

    await router.push('/broken').catch(() => undefined);
    await settle();
    expect(wrapper.text()).toContain('This page could not be loaded');
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const button = wrapper
      .findAll('[role="alert"] button')
      .find((candidate) => candidate.text() === 'Reload')!;
    await button.trigger('click');
    expect(reload).toHaveBeenCalledOnce();
    // A later successful navigation clears the alert.
    await router.push('/companies');
    await settle();
    expect(wrapper.text()).not.toContain('This page could not be loaded');
  });
});

describe('contacts', () => {
  it('searches, then opens a contact and its company', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useApi('readonly@example.com', await seeded());
    const { wrapper, router } = await mountWithApp(App, { route: '/contacts' });
    expect(wrapper.text()).toContain('Your role can view contacts but not create');
    expect(wrapper.text()).not.toContain('New contact');

    await wrapper.get('input[type="search"], [role="searchbox"] input').setValue('zzz');
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(wrapper.text()).toContain('No matching contacts');
    expect(router.currentRoute.value.query).toEqual({ q: 'zzz' });

    await wrapper.get('input[type="search"], [role="searchbox"] input').setValue('love');
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    await wrapper.get('a[href^="/contacts/"]').trigger('click');
    await settle();
    expect(wrapper.text()).toContain('Analyst');
    expect(wrapper.text()).toContain('created by sales');
    vi.useRealTimers();

    const companyLink = wrapper.get('main a[href^="/companies/"]');
    expect(companyLink.text()).toBe('Analytical Engines');
    await router.push(companyLink.attributes('href') ?? '');
    await settle();
    expect(wrapper.get('h1').text()).toBe('Analytical Engines');
    expect(wrapper.text()).toContain('Ada Lovelace');
  });

  it('pages with Load more', async () => {
    const fake = await seeded();
    const salesId = fake.store.userId('sales@example.com');
    for (let i = 0; i < 26; i++) {
      await fake.service.crm.createContact(
        { email: 'sales@example.com', userId: salesId, requestId: 'seed', channel: 'api' },
        {
          firstName: `Person ${String(i).padStart(2, '0')}`,
          lastName: null,
          email: null,
          phone: null,
          jobTitle: null,
          companyId: null,
          companyName: null
        },
        { idempotencyKey: `seed-page-${i}-key` }
      );
    }
    useApi('sales@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: '/contacts' });
    expect(wrapper.findAll('a[href^="/contacts/"]')).toHaveLength(25);
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Load more')
      ?.trigger('click');
    await settle();
    expect(wrapper.findAll('a[href^="/contacts/"]')).toHaveLength(27);
  });

  it('creates a contact with a new company from the keyboard-operable dialog', async () => {
    useApi('sales@example.com', await seeded());
    const { wrapper, router } = await mountWithApp(App, { route: '/contacts' });
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('New contact'))
      ?.trigger('click');
    await settle();
    const dialog = document.body.querySelector('form') as HTMLFormElement;
    const inputs = dialog.querySelectorAll('input');
    const byLabel = (label: string) =>
      [...inputs].find((input) =>
        input.labels?.[0]?.textContent?.includes(label)
      ) as HTMLInputElement;
    byLabel('First name').value = 'Grace';
    byLabel('First name').dispatchEvent(new Event('input'));
    byLabel('Company').value = 'Hopper Systems';
    byLabel('Company').dispatchEvent(new Event('input'));
    dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(router.currentRoute.value.name).toBe('contact');
    expect(wrapper.get('h1').text()).toBe('Grace');
    expect(wrapper.text()).toContain('Hopper Systems');
  });
});

describe('companies', () => {
  it('searches and pages companies', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fake = await seeded();
    const salesId = fake.store.userId('sales@example.com');
    for (let i = 0; i < 25; i++) {
      await fake.service.crm.createCompany(
        { email: 'sales@example.com', userId: salesId, requestId: 'seed', channel: 'api' },
        {
          name: `Co ${String(i).padStart(2, '0')}`,
          address: null,
          stockSymbol: null,
          companiesHouseUrl: null
        },
        { idempotencyKey: `seed-co-${i}-key` }
      );
    }
    useApi('sales@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: '/companies' });
    expect(wrapper.findAll('main a[href^="/companies/"]')).toHaveLength(25);
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Load more')
      ?.trigger('click');
    await settle();
    expect(wrapper.findAll('main a[href^="/companies/"]')).toHaveLength(26);
    await wrapper.get('[role="searchbox"] input, input[type="search"]').setValue('analytical');
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(wrapper.findAll('main a[href^="/companies/"]').map((link) => link.text())).toEqual([
      'Analytical Engines1 contact'
    ]);
    vi.useRealTimers();
  });
});

describe('denied and failed actions', () => {
  it('explains a server denial in the create dialog and keeps the draft', async () => {
    const fake = await seeded();
    // The session says sales, but the server has since demoted the user: the API is authoritative.
    useApi('sales@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: '/contacts' });
    fake.store.setRoles(fake.store.userId('sales@example.com'), ['read-only']);
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('New contact'))
      ?.trigger('click');
    await settle();
    const form = document.body.querySelector('form') as HTMLFormElement;
    const first = form.querySelector('input') as HTMLInputElement;
    first.value = 'Blocked';
    first.dispatchEvent(new Event('input'));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(document.body.textContent).toContain('Your role does not allow creating contacts.');
    expect((document.body.querySelector('form input') as HTMLInputElement).value).toBe('Blocked');
  });

  it('shows not-found for a missing contact without a retry button', async () => {
    useApi('sales@example.com', await seeded());
    const { wrapper } = await mountWithApp(App, { route: `/contacts/${crypto.randomUUID()}` });
    expect(wrapper.text()).toContain('Not found');
    expect(wrapper.findAll('button').some((button) => button.text() === 'Retry')).toBe(false);
  });
});

describe('ContactForm', () => {
  it('blocks an empty submission and focuses the error summary', async () => {
    const { wrapper } = await mountWithApp(ContactForm);
    await wrapper.get('form').trigger('submit');
    await settle();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('form-summary');
    expect(wrapper.text()).toContain('Enter a name or a company.');
  });

  it('shows server field errors on their inputs and announces them', async () => {
    const wrapper = mount(ContactForm, {
      props: { fieldErrors: {}, formError: null },
      attachTo: document.body,
      global: { plugins: [createAppVuetify()] }
    });
    // The `*.vue` module shim types every SFC's props loosely (no vue-tsc under TypeScript 7), so
    // the prop object is declared once with its real shape.
    const serverErrors: Record<string, unknown> = {
      fieldErrors: { email: 'Must be a valid e-mail address.' },
      formError: 'The request contains invalid fields.'
    };
    await wrapper.setProps(serverErrors);
    await settle();
    expect(wrapper.text()).toContain('Must be a valid e-mail address.');
    expect(document.activeElement?.getAttribute('data-testid')).toBe('form-summary');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Cancel')
      ?.trigger('click');
    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });

  it('emits the draft on a valid submission', async () => {
    const wrapper = mount(ContactForm, {
      attachTo: document.body,
      global: { plugins: [createAppVuetify()] }
    });
    await wrapper.findAll('input')[0]?.setValue('Ada');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('submit')?.[0]?.[0]).toMatchObject({ firstName: 'Ada', lastName: '' });
  });
});

describe('ResourceState', () => {
  it.each([
    ['forbidden', 'You do not have access', false],
    ['not-found', 'Not found', false],
    ['unavailable', 'Temporarily unavailable', true],
    ['server', 'Something went wrong', true]
  ] as const)('presents %s errors', async (kind, title, retryable) => {
    const { wrapper } = await mountWithApp(ResourceState, {
      props: {
        state: 'error',
        error: new ApiError(kind, 'Detail text', 500, {
          type: 'about:blank',
          status: 500,
          title: 'x',
          requestId: 'req-9'
        })
      }
    });
    expect(wrapper.text()).toContain(title);
    expect(wrapper.text()).toContain('Reference: req-9');
    expect(wrapper.findAll('button').some((button) => button.text() === 'Retry')).toBe(retryable);
  });

  it('presents loading and empty states', async () => {
    const loading = await mountWithApp(ResourceState, { props: { state: 'loading', error: null } });
    expect(loading.wrapper.find('[aria-busy="true"]').exists()).toBe(true);
    const empty = await mountWithApp(ResourceState, {
      props: { state: 'success', error: null, empty: true, emptyTitle: 'Nothing' }
    });
    expect(empty.wrapper.text()).toContain('Nothing');
  });
});
