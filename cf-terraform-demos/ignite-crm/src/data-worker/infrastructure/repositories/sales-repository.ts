/**
 * @file D1 adapter for the sales use cases. All SQL is constant text with bound parameters.
 *   Projections avoid N+1 queries: a deal row is joined to its stage, pipeline, company, contact,
 *   and owner in one statement, and a page of activities is hydrated with its linked contacts by
 *   one further `IN (...)` query, so a timeline costs a fixed number of statements however many
 *   records it shows. Every write re-checks the records it links to with `tx_guard` rows inside the
 *   same atomic batch (see `../d1/d1-port.ts`).
 */

import type { UserRef } from '../../../shared/api/crm.ts';
import type {
  Activity,
  ContactNextAction,
  Deal,
  DealDetail,
  Pipeline
} from '../../../shared/api/sales.ts';
import type { ListCriteria } from '../../application/crm/crm-service.ts';
import type {
  ActionCandidate,
  ContactLink,
  DealRow,
  NewActivityRow,
  NextActionWrite,
  SalesRepository
} from '../../application/crm/sales-service.ts';
import type { MutationEnvelope } from '../../application/shared/mutations.ts';
import { likeContains } from '../../domain/crm/contacts.ts';
import { type D1Port, type D1TransactionPort, sql, type SqlValue } from '../d1/d1-port.ts';
import { D1IdempotencyReader, writeEnvelope } from './envelope.ts';

/**
 * Row shape of a deal projection.
 */
interface DealProjectionRow {
  id: string;
  title: string;
  status: Deal['status'];
  stage_id: string;
  stage_key: string;
  stage_label: string;
  stage_position: number;
  pipeline_id: string;
  pipeline_name: string;
  company_id: string | null;
  company_name: string | null;
  contact_id: string;
  contact_name: string;
  owner_id: string;
  owner_name: string;
  status_line: string | null;
  next_action_text: string | null;
  next_action_date: string | null;
  amount_minor: number;
  currency: string;
  expected_close_date: string | null;
  closed_at: string | null;
  project_id: string | null;
  project_name: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  sort_key: string;
}

/**
 * The deal projection: one row per deal with every reference it displays.
 */
const DEAL_SELECT = `
  SELECT d.id, d.title, d.status,
         s.id AS stage_id, s.key AS stage_key, s.label AS stage_label, s.position AS stage_position,
         p.id AS pipeline_id, p.name AS pipeline_name,
         co.id AS company_id, co.name AS company_name,
         ct.id AS contact_id, ct.display_name AS contact_name,
         u.id AS owner_id, u.display_name AS owner_name,
         d.status_line, d.next_action_text, d.next_action_date, d.amount_minor, d.currency,
         d.expected_close_date, d.closed_at, pr.id AS project_id, pr.name AS project_name,
         d.version, d.created_at, d.updated_at, lower(d.title) AS sort_key
    FROM deals d
    JOIN pipeline_stages s ON s.id = d.stage_id
    JOIN pipelines p ON p.id = d.pipeline_id
    JOIN contacts ct ON ct.id = d.primary_contact_id
    JOIN users u ON u.id = d.owner_id
    LEFT JOIN companies co ON co.id = d.company_id AND co.deleted_at IS NULL
    LEFT JOIN projects pr ON pr.id = d.project_id
   WHERE d.deleted_at IS NULL`;

/**
 * Map a deal projection row.
 *
 * @param row The row.
 * @returns The deal.
 */
function toDeal(row: DealProjectionRow): Deal {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    stage: {
      id: row.stage_id,
      key: row.stage_key,
      label: row.stage_label,
      position: row.stage_position
    },
    pipeline: { id: row.pipeline_id, name: row.pipeline_name },
    company:
      row.company_id !== null && row.company_name !== null
        ? { id: row.company_id, name: row.company_name }
        : null,
    primaryContact: { id: row.contact_id, displayName: row.contact_name },
    owner: { id: row.owner_id, displayName: row.owner_name },
    statusLine: row.status_line,
    nextActionText: row.next_action_text,
    nextActionDate: row.next_action_date,
    amountMinor: row.amount_minor,
    currency: row.currency,
    expectedCloseDate: row.expected_close_date,
    closedAt: row.closed_at,
    project:
      row.project_id !== null && row.project_name !== null
        ? { id: row.project_id, name: row.project_name }
        : null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Row shape of an activity query.
 */
interface ActivityRow {
  id: string;
  type: Activity['type'];
  subject: string;
  summary: string | null;
  occurred_at: string;
  duration_minutes: number | null;
  author_id: string;
  author_name: string;
  company_id: string | null;
  company_name: string | null;
  deal_id: string | null;
  deal_title: string | null;
  created_at: string;
}

/**
 * Columns and joins of an activity query; callers append the filter.
 */
const ACTIVITY_SELECT = `
  SELECT a.id, a.type, a.subject, a.summary, a.occurred_at, a.duration_minutes,
         a.author_id, u.display_name AS author_name,
         co.id AS company_id, co.name AS company_name,
         d.id AS deal_id, d.title AS deal_title, a.created_at
    FROM activities a
    JOIN users u ON u.id = a.author_id
    LEFT JOIN companies co ON co.id = a.company_id
    LEFT JOIN deals d ON d.id = a.deal_id
   WHERE a.deleted_at IS NULL`;

/**
 * Filter selecting the activities linked to a record.
 */
const ACTIVITY_FILTERS = {
  contact: 'AND a.id IN (SELECT activity_id FROM activity_contacts WHERE contact_id = ?)',
  deal: 'AND a.deal_id = ?',
  company: `AND (a.company_id = ?1
              OR a.deal_id IN (SELECT id FROM deals WHERE company_id = ?1)
              OR a.id IN (SELECT ac.activity_id FROM activity_contacts ac
                            JOIN contacts c ON c.id = ac.contact_id
                           WHERE c.company_id = ?1))`
} as const;

/**
 * Placeholders for an `IN (...)` list.
 *
 * @param count Number of values.
 * @returns `?, ?, ...`.
 */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * Queue guards that every record a deal links to is still active at commit time.
 *
 * @param tx The open transaction.
 * @param deal The deal row.
 */
function guardDealLinks(tx: D1TransactionPort, deal: DealRow): void {
  tx.requireRow(
    sql(
      `SELECT count(*) FROM contacts
        WHERE id = ? AND deleted_at IS NULL
          AND (? IS NULL OR company_id = ?)`,
      deal.primaryContactId,
      deal.companyId,
      deal.companyId
    ),
    'NOT_FOUND'
  );
  if (deal.companyId !== null) {
    tx.requireRow(
      sql('SELECT count(*) FROM companies WHERE id = ? AND deleted_at IS NULL', deal.companyId),
      'NOT_FOUND'
    );
  }
  tx.requireRow(
    sql("SELECT count(*) FROM users WHERE id = ? AND status = 'active'", deal.ownerId),
    'NOT_FOUND'
  );
  tx.requireRow(
    sql(
      'SELECT count(*) FROM pipeline_stages WHERE id = ? AND pipeline_id = ?',
      deal.stageId,
      deal.pipelineId
    ),
    'NOT_FOUND'
  );
}

/**
 * {@link SalesRepository} over D1.
 */
export class D1SalesRepository extends D1IdempotencyReader implements SalesRepository {
  /**
   * @param port The D1 port.
   */
  constructor(private readonly port: D1Port) {
    super(port);
  }

  /**
   * @inheritdoc
   */
  async pipeline(): Promise<Pipeline | null> {
    const rows = await this.port.read<{
      pipeline_id: string;
      pipeline_name: string;
      id: string;
      key: string;
      label: string;
      position: number;
    }>(
      sql(
        `SELECT p.id AS pipeline_id, p.name AS pipeline_name, s.id, s.key, s.label, s.position
           FROM pipelines p JOIN pipeline_stages s ON s.pipeline_id = p.id
          WHERE p.id = (SELECT id FROM pipelines ORDER BY created_at, id LIMIT 1)
          ORDER BY s.position`
      )
    );
    const first = rows[0];
    if (first === undefined) {
      return null;
    }
    return {
      id: first.pipeline_id,
      name: first.pipeline_name,
      stages: rows.map((row) => ({
        id: row.id,
        key: row.key,
        label: row.label,
        position: row.position
      }))
    };
  }

  /**
   * @inheritdoc
   */
  async activeUsers(): Promise<UserRef[]> {
    const rows = await this.port.read<{ id: string; display_name: string }>(
      sql(
        "SELECT id, display_name FROM users WHERE status = 'active' ORDER BY lower(display_name), id LIMIT 200"
      )
    );
    return rows.map((row) => ({ id: row.id, displayName: row.display_name }));
  }

  /**
   * @inheritdoc
   */
  async activeUser(userId: string): Promise<UserRef | null> {
    const row = await this.port.readOne<{ id: string; display_name: string }>(
      sql("SELECT id, display_name FROM users WHERE id = ? AND status = 'active'", userId)
    );
    return row === null ? null : { id: row.id, displayName: row.display_name };
  }

  /**
   * @inheritdoc
   */
  async contactLinks(ids: readonly string[]): Promise<ContactLink[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.port.read<{
      id: string;
      display_name: string;
      company_id: string | null;
    }>(
      sql(
        `SELECT id, display_name, company_id FROM contacts
          WHERE deleted_at IS NULL AND id IN (${placeholders(ids.length)})`,
        ...ids
      )
    );
    return rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      companyId: row.company_id
    }));
  }

  /**
   * @inheritdoc
   */
  async companyRef(id: string): Promise<{ id: string; name: string } | null> {
    return this.port.readOne<{ id: string; name: string }>(
      sql('SELECT id, name FROM companies WHERE id = ? AND deleted_at IS NULL', id)
    );
  }

  /**
   * @inheritdoc
   */
  async listDeals(
    criteria: ListCriteria,
    status: Deal['status'] | null
  ): Promise<Array<Deal & { sortKey: string }>> {
    let text = DEAL_SELECT;
    const params: SqlValue[] = [];
    if (status !== null) {
      text += ' AND d.status = ?';
      params.push(status);
    }
    if (criteria.q !== null) {
      text += ` AND (lower(d.title) LIKE ? ESCAPE '\\' OR lower(coalesce(co.name, '')) LIKE ? ESCAPE '\\'
                     OR lower(ct.display_name) LIKE ? ESCAPE '\\')`;
      const pattern = likeContains(criteria.q);
      params.push(pattern, pattern, pattern);
    }
    if (criteria.after !== null) {
      text += ' AND (lower(d.title) > ? OR (lower(d.title) = ? AND d.id > ?))';
      params.push(criteria.after.key, criteria.after.key, criteria.after.id);
    }
    text += ' ORDER BY lower(d.title), d.id LIMIT ?';
    params.push(criteria.limit + 1);
    const rows = await this.port.read<DealProjectionRow>(sql(text, ...params));
    return rows.map((row) => ({ ...toDeal(row), sortKey: row.sort_key }));
  }

  /**
   * @inheritdoc
   */
  async getDeal(id: string): Promise<Deal | null> {
    const row = await this.port.readOne<DealProjectionRow>(sql(`${DEAL_SELECT} AND d.id = ?`, id));
    return row === null ? null : toDeal(row);
  }

  /**
   * @inheritdoc
   */
  async contactDeals(contactId: string, limit: number): Promise<Deal[]> {
    const rows = await this.port.read<DealProjectionRow>(
      sql(
        `${DEAL_SELECT} AND d.primary_contact_id = ? ORDER BY d.created_at DESC, d.id LIMIT ?`,
        contactId,
        limit
      )
    );
    return rows.map(toDeal);
  }

  /**
   * @inheritdoc
   */
  async companyDeals(companyId: string, limit: number): Promise<Deal[]> {
    const rows = await this.port.read<DealProjectionRow>(
      sql(
        `${DEAL_SELECT} AND d.company_id = ? ORDER BY d.created_at DESC, d.id LIMIT ?`,
        companyId,
        limit
      )
    );
    return rows.map(toDeal);
  }

  /**
   * @inheritdoc
   */
  async activitiesFor(
    target: { readonly type: 'contact' | 'company' | 'deal'; readonly id: string },
    limit: number
  ): Promise<Activity[]> {
    const rows = await this.port.read<ActivityRow>(
      sql(
        `${ACTIVITY_SELECT} ${ACTIVITY_FILTERS[target.type]}
          ORDER BY a.occurred_at DESC, a.id LIMIT ?`,
        target.id,
        limit
      )
    );
    if (rows.length === 0) {
      return [];
    }
    // One query hydrates every activity's contacts, including ones deleted since (tombstones).
    const links = await this.port.read<{
      activity_id: string;
      id: string;
      display_name: string;
      deleted: number;
    }>(
      sql(
        `SELECT ac.activity_id, c.id, c.display_name, (c.deleted_at IS NOT NULL) AS deleted
           FROM activity_contacts ac JOIN contacts c ON c.id = ac.contact_id
          WHERE ac.activity_id IN (${placeholders(rows.length)})
          ORDER BY lower(c.display_name), c.id`,
        ...rows.map((row) => row.id)
      )
    );
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      subject: row.subject,
      summary: row.summary,
      occurredAt: row.occurred_at,
      durationMinutes: row.duration_minutes,
      author: { id: row.author_id, displayName: row.author_name },
      contacts: links
        .filter((link) => link.activity_id === row.id)
        .map((link) => ({
          id: link.id,
          displayName: link.display_name,
          deleted: link.deleted === 1
        })),
      company:
        row.company_id !== null && row.company_name !== null
          ? { id: row.company_id, name: row.company_name }
          : null,
      deal:
        row.deal_id !== null && row.deal_title !== null
          ? { id: row.deal_id, title: row.deal_title }
          : null,
      createdAt: row.created_at
    }));
  }

  /**
   * @inheritdoc
   */
  async contactNextAction(contactId: string): Promise<ContactNextAction | null> {
    const row = await this.port.readOne<{
      id: string;
      text: string;
      due_date: string | null;
      assignee_id: string;
      assignee_name: string;
      version: number;
      updated_at: string;
    }>(
      sql(
        `SELECT f.id, f.text, f.due_date, f.assignee_id, u.display_name AS assignee_name, f.version,
                f.updated_at
           FROM follow_ups f JOIN users u ON u.id = f.assignee_id
          WHERE f.contact_id = ? AND f.status = 'open'`,
        contactId
      )
    );
    return row === null
      ? null
      : {
          id: row.id,
          text: row.text,
          dueDate: row.due_date,
          assignee: { id: row.assignee_id, displayName: row.assignee_name },
          version: row.version,
          updatedAt: row.updated_at
        };
  }

  /**
   * @inheritdoc
   */
  async actionCandidates(userId: string, limit: number): Promise<ActionCandidate[]> {
    const [contacts, deals] = await Promise.all([
      this.port.read<{
        id: string;
        text: string;
        due_date: string | null;
        contact_id: string;
        contact_name: string;
        company_id: string | null;
        company_name: string | null;
      }>(
        sql(
          `SELECT f.id, f.text, f.due_date, c.id AS contact_id, c.display_name AS contact_name,
                  co.id AS company_id, co.name AS company_name
             FROM follow_ups f
             JOIN contacts c ON c.id = f.contact_id AND c.deleted_at IS NULL
             LEFT JOIN companies co ON co.id = c.company_id AND co.deleted_at IS NULL
            WHERE f.assignee_id = ? AND f.status = 'open'
            ORDER BY f.due_date IS NOT NULL, f.due_date, f.id LIMIT ?`,
          userId,
          limit
        )
      ),
      this.port.read<DealProjectionRow>(
        sql(
          `${DEAL_SELECT} AND d.owner_id = ? AND d.status = 'pending'
              AND d.next_action_date IS NOT NULL
            ORDER BY d.next_action_date, d.id LIMIT ?`,
          userId,
          limit
        )
      )
    ]);
    return [
      ...contacts.map((row) => ({
        kind: 'contact' as const,
        id: row.id,
        text: row.text,
        dueDate: row.due_date,
        contact: { id: row.contact_id, displayName: row.contact_name },
        deal: null,
        company:
          row.company_id !== null && row.company_name !== null
            ? { id: row.company_id, name: row.company_name }
            : null
      })),
      ...deals.map((row) => {
        const deal = toDeal(row);
        return {
          kind: 'deal' as const,
          id: deal.id,
          text: deal.nextActionText ?? '',
          dueDate: deal.nextActionDate,
          contact: deal.primaryContact,
          deal: { id: deal.id, title: deal.title },
          company: deal.company
        };
      })
    ];
  }

  /**
   * @inheritdoc
   */
  async pipelineTotals(pipelineId: string): Promise<{
    byStage: ReadonlyMap<string, { count: number; amountMinor: number }>;
    won: { count: number; amountMinor: number };
    lost: { count: number; amountMinor: number };
  }> {
    const rows = await this.port.read<{
      status: Deal['status'];
      stage_id: string;
      count: number;
      amount: number;
    }>(
      sql(
        `SELECT status, stage_id, count(*) AS count, coalesce(sum(amount_minor), 0) AS amount
           FROM deals WHERE pipeline_id = ? AND deleted_at IS NULL
          GROUP BY status, stage_id`,
        pipelineId
      )
    );
    const byStage = new Map<string, { count: number; amountMinor: number }>();
    const won = { count: 0, amountMinor: 0 };
    const lost = { count: 0, amountMinor: 0 };
    for (const row of rows) {
      if (row.status === 'pending') {
        byStage.set(row.stage_id, { count: row.count, amountMinor: row.amount });
      } else {
        const bucket = row.status === 'won' ? won : lost;
        bucket.count += row.count;
        bucket.amountMinor += row.amount;
      }
    }
    return { byStage, won, lost };
  }

  /**
   * @inheritdoc
   */
  async history(
    entityType: string,
    entityId: string,
    limit: number
  ): Promise<DealDetail['history']> {
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
  async insertDeal(write: {
    deal: DealRow;
    at: string;
    envelope: MutationEnvelope;
  }): Promise<void> {
    const { deal } = write;
    await this.port.transaction((tx) => {
      guardDealLinks(tx, deal);
      tx.write(
        sql(
          `INSERT INTO deals
             (id, title, company_id, primary_contact_id, owner_id, pipeline_id, stage_id, status,
              status_line, next_action_text, next_action_date, amount_minor, currency,
              expected_close_date, closed_at, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          deal.id,
          deal.title,
          deal.companyId,
          deal.primaryContactId,
          deal.ownerId,
          deal.pipelineId,
          deal.stageId,
          deal.status,
          deal.statusLine,
          deal.nextActionText,
          deal.nextActionDate,
          deal.amountMinor,
          deal.currency,
          deal.expectedCloseDate,
          deal.closedAt,
          write.at,
          write.at
        )
      );
      writeEnvelope(tx, write.envelope);
      return Promise.resolve();
    });
  }

  /**
   * @inheritdoc
   */
  async updateDeal(write: {
    deal: DealRow;
    expectedVersion: number;
    at: string;
    envelope: MutationEnvelope;
  }): Promise<void> {
    const { deal } = write;
    await this.port.transaction((tx) => {
      guardDealLinks(tx, deal);
      tx.write(
        sql(
          `UPDATE deals
              SET title = ?, company_id = ?, primary_contact_id = ?, owner_id = ?, stage_id = ?,
                  status = ?, status_line = ?, next_action_text = ?, next_action_date = ?,
                  amount_minor = ?, expected_close_date = ?, closed_at = ?,
                  version = version + 1, updated_at = ?
            WHERE id = ? AND version = ? AND deleted_at IS NULL
              AND (project_id IS NULL OR ? = 'won')`,
          deal.title,
          deal.companyId,
          deal.primaryContactId,
          deal.ownerId,
          deal.stageId,
          deal.status,
          deal.statusLine,
          deal.nextActionText,
          deal.nextActionDate,
          deal.amountMinor,
          deal.expectedCloseDate,
          deal.closedAt,
          write.at,
          deal.id,
          write.expectedVersion,
          deal.status
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
  async insertActivity(write: {
    activity: NewActivityRow;
    contactIds: readonly string[];
    envelope: MutationEnvelope;
  }): Promise<void> {
    const row = write.activity;
    await this.port.transaction((tx) => {
      tx.requireRow(
        sql(
          `SELECT count(*) = ? FROM contacts
            WHERE deleted_at IS NULL AND id IN (${placeholders(write.contactIds.length)})`,
          write.contactIds.length,
          ...write.contactIds
        ),
        'NOT_FOUND'
      );
      if (row.companyId !== null) {
        tx.requireRow(
          sql('SELECT count(*) FROM companies WHERE id = ? AND deleted_at IS NULL', row.companyId),
          'NOT_FOUND'
        );
      }
      if (row.dealId !== null) {
        tx.requireRow(
          sql(
            `SELECT count(*) FROM deals
              WHERE id = ? AND deleted_at IS NULL
                AND (? IS NULL OR company_id IS NULL OR company_id = ?)`,
            row.dealId,
            row.companyId,
            row.companyId
          ),
          'NOT_FOUND'
        );
      }
      tx.write(
        sql(
          `INSERT INTO activities
             (id, type, subject, summary, occurred_at, duration_minutes, author_id, company_id,
              deal_id, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          row.id,
          row.type,
          row.subject,
          row.summary,
          row.occurredAt,
          row.durationMinutes,
          row.authorId,
          row.companyId,
          row.dealId,
          row.createdAt,
          row.createdAt
        )
      );
      for (const contactId of write.contactIds) {
        tx.write(
          sql(
            'INSERT INTO activity_contacts (activity_id, contact_id) VALUES (?, ?)',
            row.id,
            contactId
          )
        );
      }
      writeEnvelope(tx, write.envelope);
      return Promise.resolve();
    });
  }

  /**
   * @inheritdoc
   */
  async saveNextAction(write: NextActionWrite, envelope: MutationEnvelope): Promise<void> {
    await this.port.transaction((tx) => {
      tx.requireRow(
        sql('SELECT count(*) FROM contacts WHERE id = ? AND deleted_at IS NULL', write.contactId),
        'NOT_FOUND'
      );
      if (write.expectedVersion === null) {
        // The partial unique index on open follow-ups makes a concurrent second insert fail the
        // batch with CONFLICT.
        tx.write(
          sql(
            `INSERT INTO follow_ups
               (id, contact_id, assignee_id, text, due_date, status, completed_at, version,
                created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'open', NULL, 1, ?, ?)`,
            write.id,
            write.contactId,
            write.assigneeId,
            write.text,
            write.dueDate,
            write.at,
            write.at
          )
        );
      } else {
        tx.write(
          sql(
            `UPDATE follow_ups
                SET assignee_id = ?, text = ?, due_date = ?, version = version + 1, updated_at = ?
              WHERE id = ? AND status = 'open' AND version = ?`,
            write.assigneeId,
            write.text,
            write.dueDate,
            write.at,
            write.id,
            write.expectedVersion
          )
        );
        tx.requireChanged('VERSION_MISMATCH');
      }
      writeEnvelope(tx, envelope);
      return Promise.resolve();
    });
  }

  /**
   * @inheritdoc
   */
  async completeNextAction(
    write: { id: string; expectedVersion: number; at: string },
    envelope: MutationEnvelope
  ): Promise<void> {
    await this.port.transaction((tx) => {
      tx.write(
        sql(
          `UPDATE follow_ups
              SET status = 'done', completed_at = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND status = 'open' AND version = ?`,
          write.at,
          write.at,
          write.id,
          write.expectedVersion
        )
      );
      tx.requireChanged('VERSION_MISMATCH');
      writeEnvelope(tx, envelope);
      return Promise.resolve();
    });
  }
}
