/**
 * @file D1 adapter for the CRM module's companies and contacts. All SQL is constant text with bound
 *   parameters. Search uses `LIKE ... ESCAPE '\'` on lower-cased columns with an escaped pattern,
 *   so `%` and `_` in a search term match literally. Listing uses keyset pagination on
 *   `(lower(name), id)`, matching the partial indexes in the migration.
 */

import type {
  Company,
  CompanySummary,
  Contact,
  ContactSummary,
  HistoryEntry
} from '../../../shared/api/crm.ts';
import type {
  CompanyChange,
  ContactChange,
  CrmRepository,
  NewCompanyRow,
  NewContactRow
} from '../../application/crm/crm-service.ts';
import type { MutationEnvelope } from '../../application/shared/mutations.ts';
import type { ListCriteria } from '../../application/shared/paging.ts';
import { likeContains } from '../../domain/crm/contacts.ts';
import { type D1Port, sql, type SqlStatement } from '../d1/d1-port.ts';
import { D1IdempotencyReader, writeEnvelope } from './envelope.ts';

/**
 * Row shape of a contact summary query.
 */
interface ContactSummaryRow {
  id: string;
  display_name: string;
  email: string | null;
  job_title: string | null;
  company_id: string | null;
  company_name: string | null;
  updated_at: string;
  sort_key: string;
}

/**
 * Row shape of a full contact query.
 */
interface ContactRow extends ContactSummaryRow {
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  owner_id: string;
  owner_name: string;
  version: number;
  created_at: string;
}

/**
 * Row shape of a company query.
 */
interface CompanyRow {
  id: string;
  name: string;
  address: string | null;
  stock_symbol: string | null;
  companies_house_url: string | null;
  primary_contact_id: string | null;
  primary_contact_name: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

/**
 * Columns selected for a contact summary.
 */
const CONTACT_SUMMARY_COLUMNS = `
  c.id, c.display_name, c.email, c.job_title, c.company_id, co.name AS company_name, c.updated_at,
  lower(c.display_name) AS sort_key`;

/**
 * Map a contact summary row.
 *
 * @param row The row.
 * @returns The summary.
 */
function toContactSummary(row: ContactSummaryRow): ContactSummary {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    jobTitle: row.job_title,
    companyId: row.company_id,
    companyName: row.company_name,
    updatedAt: row.updated_at
  };
}

/**
 * Append keyset and search predicates shared by the two list queries.
 *
 * @param base Query up to and including its `WHERE` clause's first condition.
 * @param keyColumn Lower-cased sort column expression.
 * @param searchColumns Lower-cased columns the term is matched against.
 * @param criteria Search and keyset position.
 * @returns The finished statement.
 */
function listStatement(
  base: string,
  keyColumn: string,
  searchColumns: readonly string[],
  criteria: ListCriteria
): SqlStatement {
  let text = base;
  const params: (string | number)[] = [];
  if (criteria.q !== null) {
    text += ` AND (${searchColumns.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
    params.push(...searchColumns.map(() => likeContains(criteria.q ?? '')));
  }
  if (criteria.after !== null) {
    text += ` AND (${keyColumn} > ? OR (${keyColumn} = ? AND c.id > ?))`;
    params.push(criteria.after.key, criteria.after.key, criteria.after.id);
  }
  text += ` ORDER BY ${keyColumn}, c.id LIMIT ?`;
  params.push(criteria.limit + 1);
  return sql(text, ...params);
}

/**
 * {@link CrmRepository} over D1.
 */
export class D1CrmRepository extends D1IdempotencyReader implements CrmRepository {
  /**
   * @param port The D1 port.
   */
  constructor(private readonly port: D1Port) {
    super(port);
  }

  /**
   * @inheritdoc
   */
  async counts(): Promise<{ contacts: number; companies: number }> {
    const row = await this.port.readOne<{ contacts: number; companies: number }>(
      sql(`SELECT (SELECT count(*) FROM contacts WHERE deleted_at IS NULL) AS contacts,
                  (SELECT count(*) FROM companies WHERE deleted_at IS NULL) AS companies`)
    );
    return { contacts: row?.contacts ?? 0, companies: row?.companies ?? 0 };
  }

  /**
   * @inheritdoc
   */
  async recentContacts(limit: number): Promise<ContactSummary[]> {
    const rows = await this.port.read<ContactSummaryRow>(
      sql(
        `SELECT ${CONTACT_SUMMARY_COLUMNS}
           FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
          WHERE c.deleted_at IS NULL
          ORDER BY c.updated_at DESC, c.id LIMIT ?`,
        limit
      )
    );
    return rows.map(toContactSummary);
  }

  /**
   * @inheritdoc
   */
  async listContacts(criteria: ListCriteria): Promise<Array<ContactSummary & { sortKey: string }>> {
    const rows = await this.port.read<ContactSummaryRow>(
      listStatement(
        `SELECT ${CONTACT_SUMMARY_COLUMNS}
           FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
          WHERE c.deleted_at IS NULL`,
        'lower(c.display_name)',
        ['lower(c.display_name)', "lower(coalesce(c.email, ''))", "lower(coalesce(co.name, ''))"],
        criteria
      )
    );
    return rows.map((row) => ({ ...toContactSummary(row), sortKey: row.sort_key }));
  }

  /**
   * @inheritdoc
   */
  async listCompanies(
    criteria: ListCriteria
  ): Promise<Array<CompanySummary & { sortKey: string }>> {
    const rows = await this.port.read<{
      id: string;
      name: string;
      contact_count: number;
      updated_at: string;
      sort_key: string;
    }>(
      listStatement(
        `SELECT c.id, c.name, c.updated_at, lower(c.name) AS sort_key,
                (SELECT count(*) FROM contacts ct WHERE ct.company_id = c.id AND ct.deleted_at IS NULL)
                  AS contact_count
           FROM companies c
          WHERE c.deleted_at IS NULL`,
        'lower(c.name)',
        ['lower(c.name)'],
        criteria
      )
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      contactCount: row.contact_count,
      updatedAt: row.updated_at,
      sortKey: row.sort_key
    }));
  }

  /**
   * @inheritdoc
   */
  async getContact(id: string): Promise<Contact | null> {
    const row = await this.port.readOne<ContactRow>(
      sql(
        `SELECT ${CONTACT_SUMMARY_COLUMNS}, c.first_name, c.last_name, c.phone, c.owner_id,
                u.display_name AS owner_name, c.version, c.created_at
           FROM contacts c
           LEFT JOIN companies co ON co.id = c.company_id AND co.deleted_at IS NULL
           JOIN users u ON u.id = c.owner_id
          WHERE c.id = ? AND c.deleted_at IS NULL`,
        id
      )
    );
    if (row === null) {
      return null;
    }
    return {
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      displayName: row.display_name,
      email: row.email,
      phone: row.phone,
      jobTitle: row.job_title,
      company:
        row.company_id !== null && row.company_name !== null
          ? { id: row.company_id, name: row.company_name }
          : null,
      owner: { id: row.owner_id, displayName: row.owner_name },
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  /**
   * @inheritdoc
   */
  async getCompany(id: string): Promise<Company | null> {
    const row = await this.port.readOne<CompanyRow>(
      sql(
        `SELECT co.id, co.name, co.address, co.stock_symbol, co.companies_house_url,
                co.primary_contact_id, pc.display_name AS primary_contact_name,
                co.version, co.created_at, co.updated_at
           FROM companies co
           LEFT JOIN contacts pc ON pc.id = co.primary_contact_id AND pc.deleted_at IS NULL
          WHERE co.id = ? AND co.deleted_at IS NULL`,
        id
      )
    );
    if (row === null) {
      return null;
    }
    return {
      id: row.id,
      name: row.name,
      address: row.address,
      stockSymbol: row.stock_symbol,
      companiesHouseUrl: row.companies_house_url,
      primaryContact:
        row.primary_contact_id !== null && row.primary_contact_name !== null
          ? { id: row.primary_contact_id, displayName: row.primary_contact_name }
          : null,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  /**
   * @inheritdoc
   */
  async companyContacts(companyId: string, limit: number): Promise<ContactSummary[]> {
    const rows = await this.port.read<ContactSummaryRow>(
      sql(
        `SELECT ${CONTACT_SUMMARY_COLUMNS}
           FROM contacts c JOIN companies co ON co.id = c.company_id
          WHERE c.company_id = ? AND c.deleted_at IS NULL
          ORDER BY lower(c.display_name), c.id LIMIT ?`,
        companyId,
        limit
      )
    );
    return rows.map(toContactSummary);
  }

  /**
   * @inheritdoc
   */
  async findCompanyByName(nameKey: string): Promise<{ id: string; name: string } | null> {
    return this.port.readOne<{ id: string; name: string }>(
      sql('SELECT id, name FROM companies WHERE lower(name) = ? AND deleted_at IS NULL', nameKey)
    );
  }

  /**
   * @inheritdoc
   */
  async userRef(userId: string): Promise<{ id: string; displayName: string } | null> {
    const row = await this.port.readOne<{ id: string; display_name: string }>(
      sql('SELECT id, display_name FROM users WHERE id = ?', userId)
    );
    return row === null ? null : { id: row.id, displayName: row.display_name };
  }

  /**
   * @inheritdoc
   */
  async history(entityType: string, entityId: string, limit: number): Promise<HistoryEntry[]> {
    const rows = await this.port.read<{
      id: string;
      action: string;
      actor_id: string;
      actor_name: string;
      occurred_at: string;
    }>(
      sql(
        `SELECT a.id, a.action, a.actor_id, u.display_name AS actor_name, a.occurred_at
           FROM audit_events a JOIN users u ON u.id = a.actor_id
          WHERE a.entity_type = ? AND a.entity_id = ?
          ORDER BY a.occurred_at DESC, a.id LIMIT ?`,
        entityType,
        entityId,
        limit
      )
    );
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      actor: { id: row.actor_id, displayName: row.actor_name },
      occurredAt: row.occurred_at
    }));
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
    await this.port.transaction((tx) => {
      if (write.newCompany !== null) {
        insertCompanyRow(tx.write.bind(tx), write.newCompany);
      }
      if (write.existingCompanyId !== null) {
        tx.requireRow(
          sql(
            'SELECT count(*) FROM companies WHERE id = ? AND deleted_at IS NULL',
            write.existingCompanyId
          ),
          'NOT_FOUND'
        );
      }
      const row = write.contact;
      tx.write(
        sql(
          `INSERT INTO contacts
             (id, first_name, last_name, display_name, email, phone, job_title, company_id, owner_id,
              version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          row.id,
          row.firstName,
          row.lastName,
          row.displayName,
          row.email,
          row.phone,
          row.jobTitle,
          row.companyId,
          row.ownerId,
          row.createdAt,
          row.createdAt
        )
      );
      writeEnvelope(tx, write.envelope);
      return Promise.resolve();
    });
  }

  /**
   * @inheritdoc
   */
  async insertCompany(write: {
    company: NewCompanyRow;
    envelope: MutationEnvelope;
  }): Promise<void> {
    await this.port.transaction((tx) => {
      insertCompanyRow(tx.write.bind(tx), write.company);
      writeEnvelope(tx, write.envelope);
      return Promise.resolve();
    });
  }

  /**
   * @inheritdoc
   */
  async updateCompany(write: { change: CompanyChange; envelope: MutationEnvelope }): Promise<void> {
    const { change } = write;
    const assignments: string[] = [];
    const params: (string | null)[] = [];
    const columns = {
      name: 'name',
      address: 'address',
      stockSymbol: 'stock_symbol',
      companiesHouseUrl: 'companies_house_url',
      primaryContactId: 'primary_contact_id'
    } as const;
    for (const [field, column] of Object.entries(columns) as [keyof typeof columns, string][]) {
      const value = change.fields[field];
      if (value !== undefined) {
        assignments.push(`${column} = ?`);
        params.push(value);
      }
    }
    await this.port.transaction((tx) => {
      if (typeof change.fields.primaryContactId === 'string') {
        tx.requireRow(
          sql(
            'SELECT count(*) FROM contacts WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
            change.fields.primaryContactId,
            change.id
          ),
          'NOT_FOUND'
        );
      }
      tx.write(
        sql(
          `UPDATE companies SET ${assignments.join(', ')}, version = version + 1, updated_at = ?
            WHERE id = ? AND version = ? AND deleted_at IS NULL`,
          ...params,
          change.updatedAt,
          change.id,
          change.expectedVersion
        )
      );
      tx.requireChanged('VERSION_MISMATCH');
      writeEnvelope(tx, write.envelope);
      return Promise.resolve();
    });
  }

  /**
   * @inheritdoc
   */
  async updateContact(write: {
    change: ContactChange;
    newCompany: NewCompanyRow | null;
    existingCompanyId: string | null;
    leftCompanyId: string | null;
    envelope: MutationEnvelope;
  }): Promise<void> {
    const { change } = write;
    await this.port.transaction((tx) => {
      if (write.newCompany !== null) {
        insertCompanyRow(tx.write.bind(tx), write.newCompany);
      }
      if (write.existingCompanyId !== null) {
        tx.requireRow(
          sql(
            'SELECT count(*) FROM companies WHERE id = ? AND deleted_at IS NULL',
            write.existingCompanyId
          ),
          'NOT_FOUND'
        );
      }
      tx.write(
        sql(
          `UPDATE contacts
              SET first_name = ?, last_name = ?, display_name = ?, email = ?, phone = ?,
                  job_title = ?, company_id = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND version = ? AND deleted_at IS NULL`,
          change.firstName,
          change.lastName,
          change.displayName,
          change.email,
          change.phone,
          change.jobTitle,
          change.companyId,
          change.updatedAt,
          change.id,
          change.expectedVersion
        )
      );
      tx.requireChanged('VERSION_MISMATCH');
      if (write.leftCompanyId !== null) {
        // Conditional, not guarded: if someone already chose another primary contact, keep it.
        tx.write(
          sql(
            `UPDATE companies
                SET primary_contact_id = NULL, version = version + 1, updated_at = ?
              WHERE id = ? AND primary_contact_id = ?`,
            change.updatedAt,
            write.leftCompanyId,
            change.id
          )
        );
      }
      writeEnvelope(tx, write.envelope);
      return Promise.resolve();
    });
  }
}

/**
 * Queue a company insert.
 *
 * @param write Queue function of the open transaction.
 * @param company The row.
 */
function insertCompanyRow(write: (statement: SqlStatement) => void, company: NewCompanyRow): void {
  write(
    sql(
      `INSERT INTO companies
         (id, name, address, stock_symbol, companies_house_url, primary_contact_id, version,
          created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)`,
      company.id,
      company.name,
      company.address,
      company.stockSymbol,
      company.companiesHouseUrl,
      company.createdBy,
      company.createdAt,
      company.createdAt
    )
  );
}
