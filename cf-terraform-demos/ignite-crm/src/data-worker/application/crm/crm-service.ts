/**
 * @file CRM module use cases for companies and contacts, including their customer timelines. Each
 *   operation follows the same order: validate input → authorize → (mutations) replay check →
 *   domain rules → one atomic repository write including audit and idempotency rows. Repositories
 *   receive fully formed rows; they make no business decisions.
 */

import * as v from 'valibot';
import {
  type Company,
  type CompanySummary,
  type Contact,
  type ContactSummary,
  type CreateCompanyInput,
  CreateCompanyInputSchema,
  type CreateContactInput,
  CreateContactInputSchema,
  type Dashboard,
  type HistoryEntry,
  type UpdateCompanyInput,
  UpdateCompanyInputSchema
} from '../../../shared/api/crm.ts';
import {
  type CompanyDetail,
  type ContactDetail,
  TIMELINE_ACTIVITY_LIMIT,
  TIMELINE_DEAL_LIMIT
} from '../../../shared/api/customer.ts';
import { serviceError } from '../../../shared/common/errors.ts';
import { DEFAULT_PAGE_SIZE, type Page, PageRequestSchema } from '../../../shared/common/paging.ts';
import type {
  ActorContext,
  ContactsPort,
  ListOptions,
  MutationMeta
} from '../../../shared/data-service/contract.ts';
import { SearchTermSchema, VersionSchema } from '../../../shared/validation/fields.ts';
import { companyNameKey, contactDisplayName } from '../../domain/crm/contacts.ts';
import type { Authorizer } from '../permissions/permissions-service.ts';
import {
  type AuditEntry,
  type IdempotencyRepository,
  IdempotentMutation,
  type MutationEnvelope
} from '../shared/mutations.ts';
import type { Runtime } from '../shared/runtime.ts';
import { validate, validateActor, validateId, validateIdempotencyKey } from '../shared/validate.ts';
import type { SalesRepository } from './sales-service.ts';

/**
 * A company row to insert.
 */
export interface NewCompanyRow {
  /**
   * Identifier.
   */
  readonly id: string;
  /**
   * Name.
   */
  readonly name: string;
  /**
   * Address.
   */
  readonly address: string | null;
  /**
   * Stock symbol.
   */
  readonly stockSymbol: string | null;
  /**
   * Companies House link.
   */
  readonly companiesHouseUrl: string | null;
  /**
   * Creating user.
   */
  readonly createdBy: string;
  /**
   * Creation instant.
   */
  readonly createdAt: string;
}

/**
 * A contact row to insert.
 */
export interface NewContactRow {
  /**
   * Identifier.
   */
  readonly id: string;
  /**
   * Given name.
   */
  readonly firstName: string | null;
  /**
   * Family name.
   */
  readonly lastName: string | null;
  /**
   * Display name.
   */
  readonly displayName: string;
  /**
   * E-mail.
   */
  readonly email: string | null;
  /**
   * Telephone.
   */
  readonly phone: string | null;
  /**
   * Job title.
   */
  readonly jobTitle: string | null;
  /**
   * Company.
   */
  readonly companyId: string | null;
  /**
   * Owner.
   */
  readonly ownerId: string;
  /**
   * Creation instant.
   */
  readonly createdAt: string;
}

/**
 * A company update to apply if the version still matches.
 */
export interface CompanyChange {
  /**
   * Company identifier.
   */
  readonly id: string;
  /**
   * Version the caller read.
   */
  readonly expectedVersion: number;
  /**
   * Fields to set (only present keys change).
   */
  readonly fields: UpdateCompanyInput;
  /**
   * Modification instant.
   */
  readonly updatedAt: string;
}

/**
 * A page request after validation.
 */
export interface ListCriteria {
  /**
   * Lower-cased search term, if any.
   */
  readonly q: string | null;
  /**
   * Page size.
   */
  readonly limit: number;
  /**
   * Decoded keyset position.
   */
  readonly after: { readonly key: string; readonly id: string } | null;
}

/**
 * Storage port for the CRM module.
 */
export interface CrmRepository extends IdempotencyRepository {
  /**
   * Count active contacts and companies.
   *
   * @returns The counts.
   */
  counts(): Promise<{ contacts: number; companies: number }>;
  /**
   * Most recently updated active contacts.
   *
   * @param limit Maximum rows.
   * @returns Summaries, newest first.
   */
  recentContacts(limit: number): Promise<ContactSummary[]>;
  /**
   * One page of active contacts ordered by lower-cased display name then id.
   *
   * @param criteria Search and keyset position.
   * @returns Up to `limit + 1` rows (the extra row signals another page) with their sort keys.
   */
  listContacts(criteria: ListCriteria): Promise<Array<ContactSummary & { sortKey: string }>>;
  /**
   * One page of active companies ordered by lower-cased name then id.
   *
   * @param criteria Search and keyset position.
   * @returns Up to `limit + 1` rows with their sort keys.
   */
  listCompanies(criteria: ListCriteria): Promise<Array<CompanySummary & { sortKey: string }>>;
  /**
   * Read an active contact.
   *
   * @param id Contact identifier.
   * @returns The contact, or `null`.
   */
  getContact(id: string): Promise<Contact | null>;
  /**
   * Read an active company.
   *
   * @param id Company identifier.
   * @returns The company, or `null`.
   */
  getCompany(id: string): Promise<Company | null>;
  /**
   * Active contacts at a company, by name.
   *
   * @param companyId Company identifier.
   * @param limit Maximum rows.
   * @returns Summaries.
   */
  companyContacts(companyId: string, limit: number): Promise<ContactSummary[]>;
  /**
   * Find an active company by case-insensitive name.
   *
   * @param nameKey Lower-cased trimmed name.
   * @returns The company's id and name, or `null`.
   */
  findCompanyByName(nameKey: string): Promise<{ id: string; name: string } | null>;
  /**
   * Look up a user's display reference.
   *
   * @param userId User identifier.
   * @returns The reference, or `null` when unknown.
   */
  userRef(userId: string): Promise<{ id: string; displayName: string } | null>;
  /**
   * Recent history for an entity.
   *
   * @param entityType Entity type.
   * @param entityId Entity identifier.
   * @param limit Maximum entries.
   * @returns Entries, newest first.
   */
  history(entityType: string, entityId: string, limit: number): Promise<HistoryEntry[]>;
  /**
   * Atomically insert a contact, optionally a new company, and the envelope rows. When
   * `existingCompanyId` is set, the commit fails with `NOT_FOUND` if that company was deleted in
   * the meantime.
   *
   * @param write The rows.
   * @returns Once committed.
   * @throws {Error} `NOT_FOUND`, `CONFLICT` (a concurrent create of the same company name), or
   *   `DEPENDENCY_FAILURE`; nothing is written.
   */
  insertContact(write: {
    contact: NewContactRow;
    newCompany: NewCompanyRow | null;
    existingCompanyId: string | null;
    envelope: MutationEnvelope;
  }): Promise<void>;
  /**
   * Atomically insert a company and the envelope rows.
   *
   * @param write The rows.
   * @returns Once committed.
   * @throws {Error} `CONFLICT` for a duplicate live name, or `DEPENDENCY_FAILURE`.
   */
  insertCompany(write: { company: NewCompanyRow; envelope: MutationEnvelope }): Promise<void>;
  /**
   * Atomically update a company if it is still at `expectedVersion`, verifying a new primary
   * contact belongs to it, and write the envelope rows.
   *
   * @param write The change.
   * @returns Once committed.
   * @throws {Error} `VERSION_MISMATCH`, `NOT_FOUND` (primary contact not at this company),
   *   `CONFLICT` (duplicate name), or `DEPENDENCY_FAILURE`.
   */
  updateCompany(write: { change: CompanyChange; envelope: MutationEnvelope }): Promise<void>;
}

/**
 * Number of history entries returned with a record.
 */
const HISTORY_LIMIT = 20;

/**
 * Maximum contacts listed on a company detail page.
 */
const COMPANY_CONTACT_LIMIT = 100;

/**
 * Encode a keyset position as an opaque cursor.
 *
 * @param key Sort key of the last row.
 * @param id Identifier of the last row.
 * @returns A base64url cursor.
 */
export function encodeCursor(key: string, id: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([key, id]));
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/**
 * Decode a cursor produced by {@link encodeCursor}.
 *
 * @param cursor The cursor.
 * @param requestId Request identifier for the error.
 * @returns The keyset position.
 * @throws {Error} A `VALIDATION_FAILED` service error when the cursor was not produced here.
 */
export function decodeCursor(cursor: string, requestId: string): { key: string; id: string } {
  try {
    const binary = atob(cursor.replace(/-/gu, '+').replace(/_/gu, '/'));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      Array.isArray(parsed)
      && parsed.length === 2
      && typeof parsed[0] === 'string'
      && typeof parsed[1] === 'string'
    ) {
      return { key: parsed[0], id: parsed[1] };
    }
  } catch {
    // Fall through to the validation error below.
  }
  throw serviceError('VALIDATION_FAILED', 'The cursor is invalid.', {
    requestId,
    fields: { cursor: 'The cursor is invalid.' }
  });
}

/**
 * Schema for list options crossing RPC.
 */
const ListOptionsSchema = v.strictObject({
  q: v.optional(SearchTermSchema),
  ...PageRequestSchema.entries
});

/**
 * The sales reads a customer timeline needs.
 */
export type TimelineReader = Pick<
  SalesRepository,
  'contactDeals' | 'companyDeals' | 'activitiesFor' | 'contactNextAction'
>;

/**
 * Contacts and companies application service.
 */
export class CrmService implements ContactsPort {
  /**
   * @param repository Storage port.
   * @param authorizer Permissions capability.
   * @param runtime Clock and id source.
   * @param timeline Sales reads for the customer timeline.
   */
  constructor(
    private readonly repository: CrmRepository,
    private readonly authorizer: Authorizer,
    private readonly runtime: Runtime,
    private readonly timeline: TimelineReader
  ) {}

  /**
   * @inheritdoc
   */
  async dashboard(actor: ActorContext): Promise<Dashboard> {
    const caller = validateActor(actor);
    await this.authorizer.require(caller, 'crm.read');
    const [counts, recentContacts] = await Promise.all([
      this.repository.counts(),
      this.repository.recentContacts(5)
    ]);
    return { ...counts, recentContacts };
  }

  /**
   * @inheritdoc
   */
  async listContacts(actor: ActorContext, options: ListOptions): Promise<Page<ContactSummary>> {
    const caller = validateActor(actor);
    const criteria = this.criteria(options, caller.requestId);
    await this.authorizer.require(caller, 'crm.read');
    return this.paginate(await this.repository.listContacts(criteria), criteria.limit);
  }

  /**
   * @inheritdoc
   */
  async listCompanies(actor: ActorContext, options: ListOptions): Promise<Page<CompanySummary>> {
    const caller = validateActor(actor);
    const criteria = this.criteria(options, caller.requestId);
    await this.authorizer.require(caller, 'crm.read');
    return this.paginate(await this.repository.listCompanies(criteria), criteria.limit);
  }

  /**
   * @inheritdoc
   */
  async getContact(actor: ActorContext, id: string): Promise<ContactDetail> {
    const caller = validateActor(actor);
    const contactId = validateId(id, caller.requestId);
    await this.authorizer.require(caller, 'crm.read');
    const contact = await this.repository.getContact(contactId);
    if (contact === null) {
      throw serviceError('NOT_FOUND', 'Contact not found.', { requestId: caller.requestId });
    }
    // A fixed set of parallel, bounded reads: never one call per related record.
    const [nextAction, deals, activities, history] = await Promise.all([
      this.timeline.contactNextAction(contactId),
      this.timeline.contactDeals(contactId, TIMELINE_DEAL_LIMIT),
      this.timeline.activitiesFor({ type: 'contact', id: contactId }, TIMELINE_ACTIVITY_LIMIT),
      this.repository.history('contact', contactId, HISTORY_LIMIT)
    ]);
    return { contact, nextAction, deals, activities, history };
  }

  /**
   * @inheritdoc
   */
  async getCompany(actor: ActorContext, id: string): Promise<CompanyDetail> {
    const caller = validateActor(actor);
    const companyId = validateId(id, caller.requestId);
    await this.authorizer.require(caller, 'crm.read');
    const company = await this.repository.getCompany(companyId);
    if (company === null) {
      throw serviceError('NOT_FOUND', 'Company not found.', { requestId: caller.requestId });
    }
    const [contacts, deals, activities, history] = await Promise.all([
      this.repository.companyContacts(companyId, COMPANY_CONTACT_LIMIT),
      this.timeline.companyDeals(companyId, TIMELINE_DEAL_LIMIT),
      this.timeline.activitiesFor({ type: 'company', id: companyId }, TIMELINE_ACTIVITY_LIMIT),
      this.repository.history('company', companyId, HISTORY_LIMIT)
    ]);
    return { company, contacts, deals, activities, history };
  }

  /**
   * @inheritdoc
   */
  async createContact(
    actor: ActorContext,
    input: CreateContactInput,
    meta: MutationMeta
  ): Promise<Contact> {
    const caller = validateActor(actor);
    const fields = validate(CreateContactInputSchema, input, caller.requestId);
    const key = validateIdempotencyKey(meta?.idempotencyKey, caller.requestId);
    await this.authorizer.require(caller, 'crm.write');

    const mutation = await IdempotentMutation.begin(
      'crm.createContact',
      caller,
      { idempotencyKey: key },
      fields,
      this.runtime
    );
    const replayed = await mutation.replay<Contact>(this.repository);
    if (replayed !== undefined) {
      return replayed;
    }

    const now = this.runtime.now();
    const at = now.toISOString();
    let company: { id: string; name: string } | null = null;
    let newCompany: NewCompanyRow | null = null;
    if (fields.companyId !== null) {
      const existing = await this.repository.getCompany(fields.companyId);
      if (existing === null) {
        throw serviceError('VALIDATION_FAILED', 'The selected company does not exist.', {
          requestId: caller.requestId,
          fields: { companyId: 'The selected company does not exist.' }
        });
      }
      company = { id: existing.id, name: existing.name };
    } else if (fields.companyName !== null) {
      company = await this.repository.findCompanyByName(companyNameKey(fields.companyName));
      if (company === null) {
        newCompany = {
          id: this.runtime.newId(),
          name: fields.companyName,
          address: null,
          stockSymbol: null,
          companiesHouseUrl: null,
          createdBy: caller.userId,
          createdAt: at
        };
        company = { id: newCompany.id, name: newCompany.name };
      }
    }

    const row: NewContactRow = {
      id: this.runtime.newId(),
      firstName: fields.firstName,
      lastName: fields.lastName,
      displayName: contactDisplayName(fields.firstName, fields.lastName, company?.name ?? null),
      email: fields.email,
      phone: fields.phone,
      jobTitle: fields.jobTitle,
      companyId: company?.id ?? null,
      ownerId: caller.userId,
      createdAt: at
    };
    const owner = await this.ownerRef(caller);
    const contact: Contact = {
      id: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
      displayName: row.displayName,
      email: row.email,
      phone: row.phone,
      jobTitle: row.jobTitle,
      company,
      owner,
      version: 1,
      createdAt: at,
      updatedAt: at
    };
    const audit: AuditEntry[] = [];
    if (newCompany !== null) {
      audit.push(
        mutation.audit('crm', 'company', newCompany.id, 'created', { via: 'contact' }, at)
      );
    }
    audit.push(
      mutation.audit('crm', 'contact', row.id, 'created', { companyId: row.companyId }, at)
    );
    await this.repository.insertContact({
      contact: row,
      newCompany,
      existingCompanyId: newCompany === null ? (company?.id ?? null) : null,
      envelope: mutation.envelope(contact, audit, now)
    });
    return contact;
  }

  /**
   * @inheritdoc
   */
  async createCompany(
    actor: ActorContext,
    input: CreateCompanyInput,
    meta: MutationMeta
  ): Promise<Company> {
    const caller = validateActor(actor);
    const fields = validate(CreateCompanyInputSchema, input, caller.requestId);
    const key = validateIdempotencyKey(meta?.idempotencyKey, caller.requestId);
    await this.authorizer.require(caller, 'crm.write');

    const mutation = await IdempotentMutation.begin(
      'crm.createCompany',
      caller,
      { idempotencyKey: key },
      fields,
      this.runtime
    );
    const replayed = await mutation.replay<Company>(this.repository);
    if (replayed !== undefined) {
      return replayed;
    }
    if ((await this.repository.findCompanyByName(companyNameKey(fields.name))) !== null) {
      throw serviceError('CONFLICT', 'A company with this name already exists.', {
        requestId: caller.requestId,
        fields: { name: 'A company with this name already exists.' }
      });
    }

    const now = this.runtime.now();
    const at = now.toISOString();
    const row: NewCompanyRow = {
      id: this.runtime.newId(),
      ...fields,
      createdBy: caller.userId,
      createdAt: at
    };
    const company: Company = {
      id: row.id,
      name: row.name,
      address: row.address,
      stockSymbol: row.stockSymbol,
      companiesHouseUrl: row.companiesHouseUrl,
      primaryContact: null,
      version: 1,
      createdAt: at,
      updatedAt: at
    };
    await this.repository.insertCompany({
      company: row,
      envelope: mutation.envelope(
        company,
        [mutation.audit('crm', 'company', row.id, 'created', {}, at)],
        now
      )
    });
    return company;
  }

  /**
   * @inheritdoc
   */
  async updateCompany(
    actor: ActorContext,
    id: string,
    input: UpdateCompanyInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Company> {
    const caller = validateActor(actor);
    const companyId = validateId(id, caller.requestId);
    const fields = validate(UpdateCompanyInputSchema, input, caller.requestId);
    const version = validate(VersionSchema, expectedVersion, caller.requestId);
    const key = validateIdempotencyKey(meta?.idempotencyKey, caller.requestId);
    await this.authorizer.require(caller, 'crm.write');

    const mutation = await IdempotentMutation.begin(
      'crm.updateCompany',
      caller,
      { idempotencyKey: key },
      { companyId, fields, version },
      this.runtime
    );
    const replayed = await mutation.replay<Company>(this.repository);
    if (replayed !== undefined) {
      return replayed;
    }
    const current = await this.repository.getCompany(companyId);
    if (current === null) {
      throw serviceError('NOT_FOUND', 'Company not found.', { requestId: caller.requestId });
    }
    if (current.version !== version) {
      throw serviceError(
        'VERSION_MISMATCH',
        'The company was changed by someone else. Reload it and try again.',
        {
          requestId: caller.requestId
        }
      );
    }
    let primaryContact = current.primaryContact;
    if (fields.primaryContactId !== undefined) {
      if (fields.primaryContactId === null) {
        primaryContact = null;
      } else {
        const contact = await this.repository.getContact(fields.primaryContactId);
        if (contact === null || contact.company?.id !== companyId) {
          throw serviceError(
            'VALIDATION_FAILED',
            'The primary contact must be an active contact at this company.',
            {
              requestId: caller.requestId,
              fields: {
                primaryContactId: 'The primary contact must be an active contact at this company.'
              }
            }
          );
        }
        primaryContact = { id: contact.id, displayName: contact.displayName };
      }
    }
    if (fields.name !== undefined && companyNameKey(fields.name) !== companyNameKey(current.name)) {
      const clash = await this.repository.findCompanyByName(companyNameKey(fields.name));
      if (clash !== null) {
        throw serviceError('CONFLICT', 'A company with this name already exists.', {
          requestId: caller.requestId,
          fields: { name: 'A company with this name already exists.' }
        });
      }
    }

    const now = this.runtime.now();
    const at = now.toISOString();
    const company: Company = {
      ...current,
      name: fields.name ?? current.name,
      address: fields.address === undefined ? current.address : fields.address,
      stockSymbol: fields.stockSymbol === undefined ? current.stockSymbol : fields.stockSymbol,
      companiesHouseUrl:
        fields.companiesHouseUrl === undefined
          ? current.companiesHouseUrl
          : fields.companiesHouseUrl,
      primaryContact,
      version: current.version + 1,
      updatedAt: at
    };
    const changed = Object.keys(fields).sort().join(',');
    await this.repository.updateCompany({
      change: { id: companyId, expectedVersion: version, fields, updatedAt: at },
      envelope: mutation.envelope(
        company,
        [
          mutation.audit(
            'crm',
            'company',
            companyId,
            'updated',
            { fields: changed, version: company.version },
            at
          )
        ],
        now
      )
    });
    return company;
  }

  /**
   * Validate and normalise list options.
   *
   * @param options Untrusted options.
   * @param requestId Request identifier for errors.
   * @returns Repository criteria.
   * @throws {Error} A `VALIDATION_FAILED` service error.
   */
  private criteria(options: ListOptions, requestId: string): ListCriteria {
    const parsed = validate(ListOptionsSchema, options ?? { limit: DEFAULT_PAGE_SIZE }, requestId);
    return {
      q: parsed.q?.toLowerCase() ?? null,
      limit: parsed.limit,
      after: parsed.cursor === undefined ? null : decodeCursor(parsed.cursor, requestId)
    };
  }

  /**
   * Turn an over-fetched row set into a page.
   *
   * @param rows Up to `limit + 1` rows carrying their sort keys.
   * @param limit Page size.
   * @returns The page with a cursor when more rows exist.
   */
  private paginate<T extends { id: string; sortKey: string }>(
    rows: readonly T[],
    limit: number
  ): Page<Omit<T, 'sortKey'>> {
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(({ sortKey: _sortKey, ...item }) => item),
      nextCursor:
        rows.length > limit && last !== undefined ? encodeCursor(last.sortKey, last.id) : null
    };
  }

  /**
   * The caller as a user reference.
   *
   * @param actor The caller.
   * @returns The reference.
   */
  private async ownerRef(actor: ActorContext): Promise<{ id: string; displayName: string }> {
    const contactOwner = await this.repository.userRef(actor.userId);
    return contactOwner ?? { id: actor.userId, displayName: actor.email };
  }
}
