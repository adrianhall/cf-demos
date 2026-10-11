/**
 * @file In-memory fake of the Data Worker for Application Worker and client tests. It is built from
 *   the **real** application services with in-memory repository ports, so its authorization,
 *   validation, idempotency, and versioning behaviour is the production behaviour by construction.
 *   Only storage is faked. It passes the same contract suite
 *   (`tests/contract/data-service-contract.ts`) as the real `DataEntrypoint`.
 */

import type {
  CompanyChange,
  CrmRepository,
  ListCriteria,
  NewCompanyRow,
  NewContactRow
} from '../../src/data-worker/application/crm/crm-service.ts';
import { CrmService } from '../../src/data-worker/application/crm/crm-service.ts';
import type {
  NewUser,
  PermissionsRepository,
  UserRecord
} from '../../src/data-worker/application/permissions/permissions-service.ts';
import { PermissionsService } from '../../src/data-worker/application/permissions/permissions-service.ts';
import type {
  MutationEnvelope,
  StoredIdempotency
} from '../../src/data-worker/application/shared/mutations.ts';
import type { Runtime } from '../../src/data-worker/application/shared/runtime.ts';
import { likeContains } from '../../src/data-worker/domain/crm/contacts.ts';
import type {
  Company,
  CompanySummary,
  Contact,
  ContactSummary,
  HistoryEntry
} from '../../src/shared/api/crm.ts';
import { serviceError } from '../../src/shared/common/errors.ts';
import type { DataService } from '../../src/shared/data-service/contract.ts';
import { type Role, SEED_ROLE_PERMISSIONS } from '../../src/shared/permissions.ts';

/**
 * A stored user.
 */
interface StoredUser {
  id: string;
  email: string;
  displayName: string;
  status: 'active' | 'suspended';
  roles: Role[];
}

/**
 * A stored company.
 */
interface StoredCompany extends NewCompanyRow {
  primaryContactId: string | null;
  version: number;
  updatedAt: string;
  deleted: boolean;
}

/**
 * A stored contact.
 */
interface StoredContact extends NewContactRow {
  version: number;
  updatedAt: string;
  deleted: boolean;
}

/**
 * A stored audit event.
 */
interface StoredAudit {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  actorId: string;
  occurredAt: string;
}

/**
 * The fake's in-memory tables, exposed so tests can inspect side effects.
 */
export class FakeStore {
  /**
   * Users by id.
   */
  readonly users = new Map<string, StoredUser>();
  /**
   * Companies by id.
   */
  readonly companies = new Map<string, StoredCompany>();
  /**
   * Contacts by id.
   */
  readonly contacts = new Map<string, StoredContact>();
  /**
   * Audit events in insertion order.
   */
  readonly audit: StoredAudit[] = [];
  /**
   * Idempotency records keyed by actor/operation/key.
   */
  readonly idempotency = new Map<string, StoredIdempotency & { createdAt: string }>();
  /**
   * When set, every storage call fails as D1 would during an outage.
   */
  failing = false;

  /**
   * Add a user.
   *
   * @param email E-mail.
   * @param role Role.
   * @param status Status.
   * @returns The user id.
   */
  addUser(email: string, role: Role, status: 'active' | 'suspended' = 'active'): string {
    const id = crypto.randomUUID();
    this.users.set(id, {
      id,
      email,
      displayName: email.split('@')[0] ?? email,
      status,
      roles: [role]
    });
    return id;
  }

  /**
   * Throw a dependency failure when {@link failing} is set.
   *
   * @throws {Error} A `DEPENDENCY_FAILURE` service error.
   */
  check(): void {
    if (this.failing) {
      throw serviceError('DEPENDENCY_FAILURE', 'The database is temporarily unavailable.');
    }
  }

  /**
   * Commit an envelope's rows.
   *
   * @param envelope The envelope.
   * @throws {Error} `CONFLICT` when the idempotency record already exists (a concurrent duplicate).
   */
  commitEnvelope(envelope: MutationEnvelope): void {
    const record = envelope.idempotency;
    const key = `${record.actorId}|${record.operation}|${record.key}`;
    if (this.idempotency.has(key)) {
      throw serviceError('CONFLICT', 'A record with the same unique value already exists.');
    }
    for (const event of envelope.audit) {
      this.audit.push({
        id: event.id,
        entityType: event.entityType,
        entityId: event.entityId,
        action: event.action,
        actorId: event.actorId,
        occurredAt: event.occurredAt
      });
    }
    this.idempotency.set(key, {
      requestHash: record.requestHash,
      resultJson: record.resultJson,
      createdAt: record.createdAt
    });
  }
}

/**
 * {@link PermissionsRepository} over {@link FakeStore}.
 */
class FakePermissionsRepository implements PermissionsRepository {
  /**
   * @param store The store.
   */
  constructor(private readonly store: FakeStore) {}

  /**
   * Project a stored user.
   *
   * @param user The user.
   * @returns The record.
   */
  private record(user: StoredUser): UserRecord {
    const permissions = [
      ...new Set(user.roles.flatMap((role) => SEED_ROLE_PERMISSIONS[role]))
    ].sort();
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      roles: [...user.roles].sort(),
      permissions
    };
  }

  /**
   * @inheritdoc
   */
  async findUserByEmail(email: string): Promise<UserRecord | null> {
    this.store.check();
    const user = [...this.store.users.values()].find((candidate) => candidate.email === email);
    return Promise.resolve(user === undefined ? null : this.record(user));
  }

  /**
   * @inheritdoc
   */
  async findUserById(id: string): Promise<UserRecord | null> {
    this.store.check();
    const user = this.store.users.get(id);
    return Promise.resolve(user === undefined ? null : this.record(user));
  }

  /**
   * @inheritdoc
   */
  async provisionUser(user: NewUser): Promise<void> {
    this.store.check();
    if (![...this.store.users.values()].some((candidate) => candidate.email === user.email)) {
      this.store.users.set(user.id, {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        status: 'active',
        roles: [user.role]
      });
      this.store.audit.push({
        id: user.auditId,
        entityType: 'user',
        entityId: user.id,
        action: 'provisioned',
        actorId: user.id,
        occurredAt: user.createdAt
      });
    }
    return Promise.resolve();
  }
}

/**
 * {@link CrmRepository} over {@link FakeStore}.
 */
class FakeCrmRepository implements CrmRepository {
  /**
   * @param store The store.
   */
  constructor(private readonly store: FakeStore) {}

  /**
   * Active companies.
   *
   * @returns The companies.
   */
  private liveCompanies(): StoredCompany[] {
    return [...this.store.companies.values()].filter((company) => !company.deleted);
  }

  /**
   * Active contacts.
   *
   * @returns The contacts.
   */
  private liveContacts(): StoredContact[] {
    return [...this.store.contacts.values()].filter((contact) => !contact.deleted);
  }

  /**
   * Summarise a contact.
   *
   * @param contact The contact.
   * @returns The summary.
   */
  private summary(contact: StoredContact): ContactSummary {
    const company =
      contact.companyId === null ? undefined : this.store.companies.get(contact.companyId);
    return {
      id: contact.id,
      displayName: contact.displayName,
      email: contact.email,
      jobTitle: contact.jobTitle,
      companyId: contact.companyId,
      companyName: company?.name ?? null,
      updatedAt: contact.updatedAt
    };
  }

  /**
   * Apply keyset paging and search to sortable rows.
   *
   * @param rows Rows with sort keys and searchable text.
   * @param criteria Criteria.
   * @returns Up to `limit + 1` rows.
   */
  private page<T extends { id: string; sortKey: string; search: string[] }>(
    rows: T[],
    criteria: ListCriteria
  ): T[] {
    const pattern =
      criteria.q === null ? null : likeContains(criteria.q).slice(1, -1).replace(/\\(.)/gu, '$1');
    return rows
      .filter(
        (row) => pattern === null || row.search.some((text) => text.toLowerCase().includes(pattern))
      )
      .filter(
        (row) =>
          criteria.after === null
          || row.sortKey > criteria.after.key
          || (row.sortKey === criteria.after.key && row.id > criteria.after.id)
      )
      .sort((a, b) =>
        a.sortKey === b.sortKey ? (a.id < b.id ? -1 : 1) : a.sortKey < b.sortKey ? -1 : 1
      )
      .slice(0, criteria.limit + 1);
  }

  /**
   * @inheritdoc
   */
  async findIdempotency(
    actorId: string,
    operation: string,
    key: string,
    notBefore: string
  ): Promise<StoredIdempotency | null> {
    this.store.check();
    const record = this.store.idempotency.get(`${actorId}|${operation}|${key}`);
    return Promise.resolve(record === undefined || record.createdAt < notBefore ? null : record);
  }

  /**
   * @inheritdoc
   */
  async counts(): Promise<{ contacts: number; companies: number }> {
    this.store.check();
    return Promise.resolve({
      contacts: this.liveContacts().length,
      companies: this.liveCompanies().length
    });
  }

  /**
   * @inheritdoc
   */
  async recentContacts(limit: number): Promise<ContactSummary[]> {
    this.store.check();
    return Promise.resolve(
      this.liveContacts()
        .sort((a, b) =>
          a.updatedAt === b.updatedAt ? (a.id < b.id ? -1 : 1) : a.updatedAt > b.updatedAt ? -1 : 1
        )
        .slice(0, limit)
        .map((contact) => this.summary(contact))
    );
  }

  /**
   * @inheritdoc
   */
  async listContacts(criteria: ListCriteria): Promise<Array<ContactSummary & { sortKey: string }>> {
    this.store.check();
    const rows = this.liveContacts().map((contact) => {
      const summary = this.summary(contact);
      return {
        ...summary,
        sortKey: contact.displayName.toLowerCase(),
        search: [contact.displayName, contact.email ?? '', summary.companyName ?? '']
      };
    });
    return Promise.resolve(this.page(rows, criteria).map(({ search: _search, ...row }) => row));
  }

  /**
   * @inheritdoc
   */
  async listCompanies(
    criteria: ListCriteria
  ): Promise<Array<CompanySummary & { sortKey: string }>> {
    this.store.check();
    const rows = this.liveCompanies().map((company) => ({
      id: company.id,
      name: company.name,
      contactCount: this.liveContacts().filter((contact) => contact.companyId === company.id)
        .length,
      updatedAt: company.updatedAt,
      sortKey: company.name.toLowerCase(),
      search: [company.name]
    }));
    return Promise.resolve(this.page(rows, criteria).map(({ search: _search, ...row }) => row));
  }

  /**
   * @inheritdoc
   */
  async getContact(id: string): Promise<Contact | null> {
    this.store.check();
    const contact = this.store.contacts.get(id);
    if (contact === undefined || contact.deleted) {
      return Promise.resolve(null);
    }
    const company =
      contact.companyId === null ? undefined : this.store.companies.get(contact.companyId);
    const owner = this.store.users.get(contact.ownerId);
    return Promise.resolve({
      id: contact.id,
      firstName: contact.firstName,
      lastName: contact.lastName,
      displayName: contact.displayName,
      email: contact.email,
      phone: contact.phone,
      jobTitle: contact.jobTitle,
      company:
        company === undefined || company.deleted ? null : { id: company.id, name: company.name },
      owner: { id: contact.ownerId, displayName: owner?.displayName ?? contact.ownerId },
      version: contact.version,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt
    });
  }

  /**
   * @inheritdoc
   */
  async getCompany(id: string): Promise<Company | null> {
    this.store.check();
    const company = this.store.companies.get(id);
    if (company === undefined || company.deleted) {
      return Promise.resolve(null);
    }
    const primary =
      company.primaryContactId === null
        ? undefined
        : this.store.contacts.get(company.primaryContactId);
    return Promise.resolve({
      id: company.id,
      name: company.name,
      address: company.address,
      stockSymbol: company.stockSymbol,
      companiesHouseUrl: company.companiesHouseUrl,
      primaryContact:
        primary === undefined || primary.deleted
          ? null
          : { id: primary.id, displayName: primary.displayName },
      version: company.version,
      createdAt: company.createdAt,
      updatedAt: company.updatedAt
    });
  }

  /**
   * @inheritdoc
   */
  async companyContacts(companyId: string, limit: number): Promise<ContactSummary[]> {
    this.store.check();
    return Promise.resolve(
      this.liveContacts()
        .filter((contact) => contact.companyId === companyId)
        .sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()))
        .slice(0, limit)
        .map((contact) => this.summary(contact))
    );
  }

  /**
   * @inheritdoc
   */
  async findCompanyByName(nameKey: string): Promise<{ id: string; name: string } | null> {
    this.store.check();
    const company = this.liveCompanies().find(
      (candidate) => candidate.name.toLowerCase() === nameKey
    );
    return Promise.resolve(company === undefined ? null : { id: company.id, name: company.name });
  }

  /**
   * @inheritdoc
   */
  async userRef(userId: string): Promise<{ id: string; displayName: string } | null> {
    this.store.check();
    const user = this.store.users.get(userId);
    return Promise.resolve(
      user === undefined ? null : { id: user.id, displayName: user.displayName }
    );
  }

  /**
   * @inheritdoc
   */
  async history(entityType: string, entityId: string, limit: number): Promise<HistoryEntry[]> {
    this.store.check();
    return Promise.resolve(
      this.store.audit
        .filter((event) => event.entityType === entityType && event.entityId === entityId)
        .reverse()
        .slice(0, limit)
        .map((event) => ({
          id: event.id,
          action: event.action,
          actor: {
            id: event.actorId,
            displayName: this.store.users.get(event.actorId)?.displayName ?? event.actorId
          },
          occurredAt: event.occurredAt
        }))
    );
  }

  /**
   * @inheritdoc
   */
  async insertContact(write: {
    contact: NewContactRow;
    newCompany: NewCompanyRow | null;
    existingCompanyId: string | null;
    envelope: MutationEnvelope;
  }): Promise<void> {
    this.store.check();
    if (
      write.existingCompanyId !== null
      && this.store.companies.get(write.existingCompanyId)?.deleted !== false
    ) {
      throw serviceError('NOT_FOUND', 'A record this change depends on no longer exists.');
    }
    if (
      write.newCompany !== null
      && this.liveCompanies().some(
        (company) => company.name.toLowerCase() === write.newCompany?.name.toLowerCase()
      )
    ) {
      throw serviceError('CONFLICT', 'A record with the same unique value already exists.');
    }
    this.store.commitEnvelope(write.envelope);
    if (write.newCompany !== null) {
      this.store.companies.set(write.newCompany.id, {
        ...write.newCompany,
        primaryContactId: null,
        version: 1,
        updatedAt: write.newCompany.createdAt,
        deleted: false
      });
    }
    this.store.contacts.set(write.contact.id, {
      ...write.contact,
      version: 1,
      updatedAt: write.contact.createdAt,
      deleted: false
    });
    return Promise.resolve();
  }

  /**
   * @inheritdoc
   */
  async insertCompany(write: {
    company: NewCompanyRow;
    envelope: MutationEnvelope;
  }): Promise<void> {
    this.store.check();
    if (
      this.liveCompanies().some(
        (company) => company.name.toLowerCase() === write.company.name.toLowerCase()
      )
    ) {
      throw serviceError('CONFLICT', 'A record with the same unique value already exists.');
    }
    this.store.commitEnvelope(write.envelope);
    this.store.companies.set(write.company.id, {
      ...write.company,
      primaryContactId: null,
      version: 1,
      updatedAt: write.company.createdAt,
      deleted: false
    });
    return Promise.resolve();
  }

  /**
   * @inheritdoc
   */
  async updateCompany(write: { change: CompanyChange; envelope: MutationEnvelope }): Promise<void> {
    this.store.check();
    const { change } = write;
    const company = this.store.companies.get(change.id);
    if (company === undefined || company.deleted || company.version !== change.expectedVersion) {
      throw serviceError(
        'VERSION_MISMATCH',
        'The record was changed by someone else. Reload it and try again.'
      );
    }
    this.store.commitEnvelope(write.envelope);
    this.store.companies.set(change.id, {
      ...company,
      name: change.fields.name ?? company.name,
      address: change.fields.address === undefined ? company.address : change.fields.address,
      stockSymbol:
        change.fields.stockSymbol === undefined ? company.stockSymbol : change.fields.stockSymbol,
      companiesHouseUrl:
        change.fields.companiesHouseUrl === undefined
          ? company.companiesHouseUrl
          : change.fields.companiesHouseUrl,
      primaryContactId:
        change.fields.primaryContactId === undefined
          ? company.primaryContactId
          : change.fields.primaryContactId,
      version: company.version + 1,
      updatedAt: change.updatedAt
    });
    return Promise.resolve();
  }
}

/**
 * A deterministic runtime for tests.
 *
 * @param start Initial instant.
 * @returns A runtime whose clock advances 1 ms per read, plus a setter.
 */
export function testRuntime(
  start = new Date('2026-10-01T09:00:00.000Z')
): Runtime & { set(date: Date): void } {
  let now = start.getTime();
  return {
    now: () => new Date(now++),
    newId: () => crypto.randomUUID(),
    set: (date) => {
      now = date.getTime();
    }
  };
}

/**
 * Build a fake Data Worker.
 *
 * @param options Bootstrap owner e-mail, store, and runtime.
 * @returns The service and its store.
 */
export function createFakeDataService(
  options: { adminEmail?: string; store?: FakeStore; runtime?: Runtime } = {}
): { service: DataService; store: FakeStore } {
  const store = options.store ?? new FakeStore();
  const runtime = options.runtime ?? testRuntime();
  const permissions = new PermissionsService(
    new FakePermissionsRepository(store),
    options.adminEmail ?? 'owner@example.com',
    runtime
  );
  const crm = new CrmService(new FakeCrmRepository(store), permissions, runtime);
  return {
    store,
    service: {
      health: () => {
        store.check();
        return Promise.resolve({ status: 'ok', migration: '0001_foundation.sql' });
      },
      resolveActor: (email, requestId) => permissions.resolveActor(email, requestId),
      resolveUser: (userId) => permissions.resolveUser(userId),
      authorize: (request) => permissions.authorize(request),
      crm,
      permissions
    }
  };
}
