/**
 * @file Contact and company editing in the SPA, against the real API app and the fake Data Worker:
 *   the edit dialogs are offered only with `crm.write`; saving sends only changed fields; nothing
 *   changed is reported without a request; validation failures and version conflicts keep the
 *   user's draft; and "Load latest version" lets the user save again. The pure draft helpers are
 *   tested directly for their normalization rules.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/client/App.vue';
import { resetSession } from '../../src/client/composables/useSession.ts';
import {
  companyDraftFrom,
  contactDraftFrom,
  toUpdateCompanyInput,
  toUpdateContactInput
} from '../../src/client/services/crm-draft.ts';
import type { Company, Contact } from '../../src/shared/api/crm.ts';
import type { ActorContext } from '../../src/shared/data-service/contract.ts';
import { createFakeDataService } from '../fakes/fake-data-service.ts';
import { mountWithApp, settle, useApi } from './support.ts';

let counter = 0;

/**
 * A fresh idempotency key.
 *
 * @returns Mutation metadata.
 */
function key(): { idempotencyKey: string } {
  return { idempotencyKey: `crm-edit-key-${++counter}` };
}

/**
 * A fake with a sales and a read-only user, and Ada at Analytical Engines.
 *
 * @returns The fake, the sales actor, and Ada.
 */
async function seeded() {
  const fake = createFakeDataService();
  const sales: ActorContext = {
    email: 'sales@example.com',
    userId: fake.store.addUser('sales@example.com', 'sales'),
    requestId: 'seed',
    channel: 'api'
  };
  fake.store.addUser('readonly@example.com', 'read-only');
  const ada = await fake.service.crm.createContact(
    sales,
    {
      firstName: 'Ada',
      lastName: null,
      email: null,
      phone: null,
      jobTitle: 'Analyst',
      companyId: null,
      companyName: 'Analytical Engines'
    },
    key()
  );
  return { ...fake, sales, ada };
}

/**
 * A button by its visible text, anywhere in the document.
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
 * The open dialog's input with a label.
 *
 * @param label Label text (exact).
 * @returns The input or textarea.
 */
function field(label: string): HTMLInputElement {
  const dialog = document.body.querySelector('.v-overlay--active[role="dialog"]')!;
  const found = [...dialog.querySelectorAll<HTMLInputElement>('input, textarea')].find(
    (input) => input.labels?.[0]?.textContent?.replace('*', '').trim() === label
  );
  if (found === undefined) {
    throw new Error(`No field "${label}"`);
  }
  return found;
}

/**
 * Type into a field in the open dialog.
 *
 * @param label Label text.
 * @param value New value.
 */
function type(label: string, value: string): void {
  const input = field(label);
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

/**
 * Submit the open dialog's form.
 */
function submit(): void {
  document.body
    .querySelector('.v-overlay--active[role="dialog"] form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  resetSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('crm drafts', () => {
  const contact: Contact = {
    id: '00000000-0000-4000-8000-0000000000a1',
    firstName: 'Ada',
    lastName: null,
    displayName: 'Ada',
    email: 'ada@example.com',
    phone: null,
    jobTitle: null,
    company: { id: '00000000-0000-4000-8000-0000000000c1', name: 'Engines' },
    owner: { id: '00000000-0000-4000-8000-000000000001', displayName: 'Sam' },
    version: 1,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z'
  };

  it('sends only changed contact fields, normalized as the server would', () => {
    const draft = contactDraftFrom(contact);
    expect(toUpdateContactInput(contact, draft)).toBeNull();
    expect(
      toUpdateContactInput(contact, {
        ...draft,
        email: ' ADA@EXAMPLE.COM ',
        companyName: 'engines'
      })
    ).toBeNull();
    expect(
      toUpdateContactInput(contact, { ...draft, lastName: ' Lovelace ', phone: '07523 185547' })
    ).toEqual({ lastName: 'Lovelace', phone: '07523 185547' });
    expect(toUpdateContactInput(contact, { ...draft, companyName: '  ' })).toEqual({
      companyId: null
    });
    expect(toUpdateContactInput(contact, { ...draft, companyName: 'Looms' })).toEqual({
      companyName: 'Looms'
    });
    const loner = { ...contact, company: null };
    expect(toUpdateContactInput(loner, contactDraftFrom(loner))).toBeNull();
    expect(toUpdateContactInput(loner, { ...contactDraftFrom(loner), companyName: 'New' })).toEqual(
      { companyName: 'New' }
    );
  });

  it('sends only changed company fields', () => {
    const company: Company = {
      id: '00000000-0000-4000-8000-0000000000c1',
      name: 'Engines',
      address: null,
      stockSymbol: 'ENG',
      companiesHouseUrl: null,
      primaryContact: { id: contact.id, displayName: 'Ada' },
      version: 1,
      createdAt: '2026-10-01T09:00:00.000Z',
      updatedAt: '2026-10-01T09:00:00.000Z'
    };
    const draft = companyDraftFrom(company);
    expect(toUpdateCompanyInput(company, { ...draft, stockSymbol: ' eng ' })).toBeNull();
    expect(
      toUpdateCompanyInput(company, {
        ...draft,
        name: ' Engines Ltd ',
        address: '1 Road',
        primaryContactId: ''
      })
    ).toEqual({ name: 'Engines Ltd', address: '1 Road', primaryContactId: null });
    expect(
      toUpdateCompanyInput(
        { ...company, primaryContact: null },
        { ...draft, primaryContactId: contact.id }
      )
    ).toEqual({ primaryContactId: contact.id });
  });
});

describe('editing a contact', () => {
  it('is not offered to a read-only user', async () => {
    const fake = await seeded();
    useApi('readonly@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: `/contacts/${fake.ada.id}` });
    expect(wrapper.text()).not.toContain('Edit contact');
  });

  it('saves changed fields, reports no change, and keeps a draft through a validation error', async () => {
    const fake = await seeded();
    useApi('sales@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: `/contacts/${fake.ada.id}` });

    button('Edit contact').click();
    await settle();
    expect(field('First name').value).toBe('Ada');
    expect(button('Save contact').type).toBe('submit');
    submit();
    await settle();
    expect(wrapper.text()).toContain('Nothing changed, so nothing was saved.');

    button('Edit contact').click();
    await settle();
    type('Last name', 'Lovelace');
    type('E-mail', 'ahall@cloudflarecom');
    submit();
    await settle();
    // The server's 422 lands on the field, and the draft survives.
    expect(document.body.textContent).toContain('valid e-mail');
    expect(field('Last name').value).toBe('Lovelace');
    type('E-mail', 'ada@engines.example');
    type('Company', 'Looms');
    submit();
    await settle();
    expect(wrapper.get('h1').text()).toBe('Ada Lovelace');
    expect(wrapper.text()).toContain('ada@engines.example');
    expect(wrapper.text()).toContain('Looms');
    expect((await fake.service.crm.getContact(fake.sales, fake.ada.id)).contact.version).toBe(2);
  });

  it('keeps the draft on a version conflict, then saves after loading the latest version', async () => {
    const fake = await seeded();
    useApi('sales@example.com', fake);
    const { wrapper } = await mountWithApp(App, { route: `/contacts/${fake.ada.id}` });
    button('Edit contact').click();
    await settle();
    type('Phone', '020 7946 0000');
    await fake.service.crm.updateContact(
      fake.sales,
      fake.ada.id,
      { jobTitle: 'Director' },
      1,
      key()
    );
    submit();
    await settle();
    expect(document.body.querySelector('[data-testid="conflict"]')).not.toBeNull();
    expect(field('Phone').value).toBe('020 7946 0000');
    button('Load latest version').click();
    await settle();
    submit();
    await settle();
    // Only the phone was sent, so the other person's job title survives.
    const { contact } = await fake.service.crm.getContact(fake.sales, fake.ada.id);
    expect(contact).toMatchObject({ phone: '+442079460000', jobTitle: 'Director', version: 3 });
    expect(wrapper.text()).toContain('Director');
    // Stored as E.164, shown in the installation's national format.
    expect(wrapper.text()).toContain('020 7946 0000');
  });
});

describe('editing a company', () => {
  it('edits details and chooses a primary contact from its own contacts', async () => {
    const fake = await seeded();
    useApi('sales@example.com', fake);
    const companyId = fake.ada.company!.id;
    const { wrapper } = await mountWithApp(App, { route: `/companies/${companyId}` });
    button('Edit company').click();
    await settle();
    type('Address', '1 Engine Row');
    type('Stock symbol', 'eng');
    const select = wrapper
      .findAllComponents({ name: 'VSelect' })
      .find((candidate) => candidate.props('label') === 'Primary contact')!;
    select.vm.$emit('update:modelValue', fake.ada.id);
    await settle();
    submit();
    await settle();
    expect(wrapper.text()).toContain('1 Engine Row');
    expect(wrapper.text()).toContain('ENG');
    const { company } = await fake.service.crm.getCompany(fake.sales, companyId);
    expect(company).toMatchObject({ stockSymbol: 'ENG', primaryContact: { id: fake.ada.id } });
  });

  it('blocks a blank name locally, explains a taken name, and reports a conflict', async () => {
    const fake = await seeded();
    await fake.service.crm.createCompany(
      fake.sales,
      { name: 'Taken', address: null, stockSymbol: null, companiesHouseUrl: null },
      key()
    );
    useApi('sales@example.com', fake);
    const companyId = fake.ada.company!.id;
    const { wrapper } = await mountWithApp(App, { route: `/companies/${companyId}` });
    button('Edit company').click();
    await settle();
    type('Company name', '  ');
    submit();
    await settle();
    expect(document.body.textContent).toContain('Company name is required.');
    type('Company name', 'taken');
    submit();
    await settle();
    expect(document.body.textContent).toContain('A company with this name already exists.');
    expect(field('Company name').value).toBe('taken');
    button('Cancel').click();
    await settle();

    button('Edit company').click();
    await settle();
    expect(field('Company name').value).toBe('Analytical Engines');
    submit();
    await settle();
    expect(wrapper.text()).toContain('Nothing changed, so nothing was saved.');

    button('Edit company').click();
    await settle();
    type('Address', 'Mine');
    await fake.service.crm.updateCompany(fake.sales, companyId, { address: 'Theirs' }, 1, key());
    submit();
    await settle();
    expect(document.body.querySelector('[data-testid="conflict"]')).not.toBeNull();
    button('Load latest version').click();
    await settle();
    expect(document.body.textContent).toContain('The latest version is loaded.');
    submit();
    await settle();
    expect((await fake.service.crm.getCompany(fake.sales, companyId)).company.address).toBe('Mine');
  });
});
