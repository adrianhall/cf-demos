/**
 * @file Convert the contact and company edit forms into update requests that carry only the fields
 *   the user changed. Kept out of the components so the rules are unit-testable: blanks become
 *   `null`; values are compared after the same normalization the server applies (trimmed, e-mail
 *   lower-cased, stock symbol upper-cased), so an untouched field is never sent; and a contact's
 *   company is expressed as detach (`companyId: null`) or reuse/create (`companyName`).
 */

import type {
  Company,
  Contact,
  UpdateCompanyInput,
  UpdateContactInput
} from '../../shared/api/crm.ts';

/**
 * The contact form's editable fields, as typed.
 */
export interface ContactDraft {
  /**
   * Given name.
   */
  firstName: string;
  /**
   * Family name.
   */
  lastName: string;
  /**
   * E-mail.
   */
  email: string;
  /**
   * Telephone.
   */
  phone: string;
  /**
   * Job title.
   */
  jobTitle: string;
  /**
   * Company name to reuse or create (blank for none).
   */
  companyName: string;
}

/**
 * The company form's editable fields, as typed.
 */
export interface CompanyDraft {
  /**
   * Company name.
   */
  name: string;
  /**
   * Business address.
   */
  address: string;
  /**
   * Stock ticker symbol.
   */
  stockSymbol: string;
  /**
   * Companies House link.
   */
  companiesHouseUrl: string;
  /**
   * Primary contact id ('' for none).
   */
  primaryContactId: string;
}

/**
 * A blank string as `null`.
 *
 * @param value Form text.
 * @returns The trimmed text, or `null` when blank.
 */
function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The form draft for an existing contact.
 *
 * @param contact The contact as loaded.
 * @returns A draft with every field filled from the record.
 */
export function contactDraftFrom(contact: Contact): ContactDraft {
  return {
    firstName: contact.firstName ?? '',
    lastName: contact.lastName ?? '',
    email: contact.email ?? '',
    phone: contact.phone ?? '',
    jobTitle: contact.jobTitle ?? '',
    companyName: contact.company?.name ?? ''
  };
}

/**
 * Build an update-contact request containing only the fields that changed.
 *
 * The company is compared by name, case-insensitively, because the server reuses an existing
 * company of the same name: retyping “acme” for “Acme” is not a change. A blank company detaches
 * the contact; a different name moves it to that (reused or newly created) company.
 *
 * @param contact The contact as the editor opened it.
 * @param draft The form value.
 * @returns The changed fields, or `null` when nothing changed.
 */
export function toUpdateContactInput(
  contact: Contact,
  draft: ContactDraft
): UpdateContactInput | null {
  const changes: Record<string, unknown> = {};
  const set = (field: keyof UpdateContactInput, next: string | null, current: string | null) => {
    if (next !== current) {
      changes[field] = next;
    }
  };
  set('firstName', blankToNull(draft.firstName), contact.firstName);
  set('lastName', blankToNull(draft.lastName), contact.lastName);
  set('email', blankToNull(draft.email)?.toLowerCase() ?? null, contact.email);
  set('phone', blankToNull(draft.phone), contact.phone);
  set('jobTitle', blankToNull(draft.jobTitle), contact.jobTitle);
  const companyName = blankToNull(draft.companyName);
  if (companyName === null) {
    if (contact.company !== null) {
      changes.companyId = null;
    }
  } else if (companyName.toLowerCase() !== contact.company?.name.toLowerCase()) {
    changes.companyName = companyName;
  }
  return Object.keys(changes).length === 0 ? null : (changes as UpdateContactInput);
}

/**
 * The form draft for an existing company.
 *
 * @param company The company as loaded.
 * @returns A draft with every field filled from the record.
 */
export function companyDraftFrom(company: Company): CompanyDraft {
  return {
    name: company.name,
    address: company.address ?? '',
    stockSymbol: company.stockSymbol ?? '',
    companiesHouseUrl: company.companiesHouseUrl ?? '',
    primaryContactId: company.primaryContact?.id ?? ''
  };
}

/**
 * Build an update-company request containing only the fields that changed.
 *
 * @param company The company as the editor opened it.
 * @param draft The form value.
 * @returns The changed fields, or `null` when nothing changed.
 */
export function toUpdateCompanyInput(
  company: Company,
  draft: CompanyDraft
): UpdateCompanyInput | null {
  const changes: Record<string, unknown> = {};
  const set = (field: keyof UpdateCompanyInput, next: string | null, current: string | null) => {
    if (next !== current) {
      changes[field] = next;
    }
  };
  const name = draft.name.trim();
  // A blank name is sent so the server's “Company name is required.” reaches the field.
  set('name', name, company.name);
  set('address', blankToNull(draft.address), company.address);
  set('stockSymbol', blankToNull(draft.stockSymbol)?.toUpperCase() ?? null, company.stockSymbol);
  set('companiesHouseUrl', blankToNull(draft.companiesHouseUrl), company.companiesHouseUrl);
  set(
    'primaryContactId',
    draft.primaryContactId === '' ? null : draft.primaryContactId,
    company.primaryContact?.id ?? null
  );
  return Object.keys(changes).length === 0 ? null : (changes as UpdateCompanyInput);
}
