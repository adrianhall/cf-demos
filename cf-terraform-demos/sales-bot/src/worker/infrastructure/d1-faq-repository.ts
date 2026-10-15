import { isAudience, type Audience } from '../domain/audience';
import type { Faq, FaqQuery, FaqRepository, FaqStatus } from '../domain/faq';

/**
 * Columns selected for every FAQ read. One constant so the projection, {@link FaqRow}, and
 * {@link toFaq} cannot drift apart.
 */
const FAQ_COLUMNS =
  'id, revision, question, answer, product_id, owner_identity_key, audience, expires_at, '
  + 'status, source_escalation_id, created_at, updated_at';

/**
 * Selects the newest revision of each FAQ.
 *
 * A correlated subquery rather than a window function or a `max_revision` column on a second table:
 * D1 is SQLite, the FAQ table is small by nature, and this keeps "newest revision" stated once in
 * SQL instead of being an invariant some other write has to maintain.
 */
const LATEST_REVISION_PREDICATE =
  'revision = (SELECT MAX(inner_faqs.revision) FROM faqs AS inner_faqs WHERE inner_faqs.id = faqs.id)';

/**
 * Raw snake_cased row as stored in D1.
 */
interface FaqRow {
  /**
   * FAQ identifier.
   */
  id: string;
  /**
   * Revision number.
   */
  revision: number;
  /**
   * Question text.
   */
  question: string;
  /**
   * Answer text.
   */
  answer: string;
  /**
   * Product slug, or `null`.
   */
  product_id: string | null;
  /**
   * Owning identity key, or `null`.
   */
  owner_identity_key: string | null;
  /**
   * Audience classification as stored.
   */
  audience: string;
  /**
   * Expiry instant, or `null`.
   */
  expires_at: string | null;
  /**
   * Lifecycle state as stored.
   */
  status: string;
  /**
   * Source escalation, or `null`.
   */
  source_escalation_id: string | null;
  /**
   * Creation instant.
   */
  created_at: string;
  /**
   * Last-change instant.
   */
  updated_at: string;
}

/**
 * Narrow a stored status column to a {@link FaqStatus}.
 *
 * An unrecognized value is reported as `archived` rather than trusted. The column has a `CHECK`
 * constraint, so this only matters if the schema is changed carelessly — and in that case the
 * fail-closed answer is for the entry to be unreadable, not for it to default to active.
 *
 * @param value Raw column value.
 * @returns The lifecycle state.
 */
function toStatus(value: string): FaqStatus {
  return value === 'active' || value === 'expired' ? value : 'archived';
}

/**
 * Narrow a stored audience column to an {@link Audience}.
 *
 * Unrecognized values become `internal`, the most restricted audience, for the same fail-closed
 * reason as {@link toStatus}: a corrupted classification must not make content more visible.
 *
 * @param value Raw column value.
 * @returns The audience.
 */
function toAudience(value: string): Audience {
  return isAudience(value) ? value : 'internal';
}

/**
 * Convert a stored row into the domain representation.
 *
 * @param row Row returned by a query using {@link FAQ_COLUMNS}.
 * @returns The equivalent domain FAQ.
 */
function toFaq(row: FaqRow): Faq {
  return {
    id: row.id,
    revision: row.revision,
    question: row.question,
    answer: row.answer,
    productId: row.product_id,
    ownerIdentityKey: row.owner_identity_key,
    audience: toAudience(row.audience),
    expiresAt: row.expires_at,
    status: toStatus(row.status),
    sourceEscalationId: row.source_escalation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * D1 implementation of the {@link FaqRepository} port.
 *
 * D1 rather than KV because the knowledge base needs exactly what a relational store provides: a
 * composite `(id, revision)` primary key that makes a duplicate revision a constraint violation
 * instead of a silent overwrite, foreign keys to products and identities, and server-side
 * predicates for audience, product, status, and expiry so a restricted FAQ is never read into the
 * Worker in the first place.
 *
 * The audience filter is bound as parameters rather than interpolated. The list comes from
 * `visibleAudiences()` and is therefore already a closed set, but building SQL by concatenating
 * values is the habit that eventually meets a value that is not closed.
 */
export class D1FaqRepository implements FaqRepository {
  /**
   * @param database D1 database bound to this Worker, narrowed to the capabilities used so a unit
   *   test can supply a small fake.
   */
  public constructor(private readonly database: Pick<D1Database, 'prepare'>) {}

  /**
   * List the newest revision of each FAQ matching a reader's filter.
   *
   * @param query Audience, product, status, and expiry filter.
   * @returns Matching revisions, most recently updated first.
   * @throws {Error} When D1 rejects the query.
   */
  public async list(query: FaqQuery): Promise<Faq[]> {
    const conditions = [LATEST_REVISION_PREDICATE];
    const parameters: unknown[] = [];

    conditions.push(`audience IN (${query.audiences.map(() => '?').join(', ')})`);
    parameters.push(...query.audiences);

    if (query.productId !== undefined) {
      conditions.push('product_id = ?');
      parameters.push(query.productId);
    }
    if (query.includeInactive !== true) {
      conditions.push("status = 'active'");
      conditions.push('(expires_at IS NULL OR expires_at > ?)');
      parameters.push(query.now);
    }

    const result = await this.database
      .prepare(
        `SELECT ${FAQ_COLUMNS} FROM faqs WHERE ${conditions.join(' AND ')} `
          + 'ORDER BY updated_at DESC, id DESC'
      )
      .bind(...parameters)
      .all<FaqRow>();
    return result.results.map(toFaq);
  }

  /**
   * Read the newest revision of one FAQ, ignoring audience and expiry.
   *
   * @param id Stable FAQ identifier.
   * @returns The newest revision, or `null` when the identifier is unknown.
   * @throws {Error} When D1 rejects the query.
   */
  public async findLatest(id: string): Promise<Faq | null> {
    const row = await this.database
      .prepare(`SELECT ${FAQ_COLUMNS} FROM faqs WHERE id = ? ORDER BY revision DESC LIMIT 1`)
      .bind(id)
      .first<FaqRow>();
    return row === null ? null : toFaq(row);
  }

  /**
   * Insert revision 1 of a new FAQ.
   *
   * @param faq Fully resolved revision.
   * @returns A promise fulfilled once the revision is durable.
   * @throws {Error} When D1 rejects the insert, including the `(id, revision)` uniqueness
   *   violation.
   */
  public async insert(faq: Faq): Promise<void> {
    await this.write(faq);
  }

  /**
   * Insert the next revision of an existing FAQ.
   *
   * The same statement as {@link D1FaqRepository.insert}: the composite primary key is what makes a
   * revision collision fail, so there is nothing for a second statement to add. Two methods exist
   * because the port's callers mean different things, and a service reading `insertRevision` should
   * not have to know they are identical today.
   *
   * @param faq Fully resolved revision.
   * @returns A promise fulfilled once the revision is durable.
   * @throws {Error} When D1 rejects the insert, which is how two concurrent edits of the same
   *   revision are prevented from both succeeding.
   */
  public async insertRevision(faq: Faq): Promise<void> {
    await this.write(faq);
  }

  /**
   * Mark every active, newest revision whose expiry has passed as `expired`.
   *
   * @param now Instant to compare expiries against.
   * @returns Identifiers of the FAQs that were marked.
   * @throws {Error} When D1 rejects the read or the update.
   */
  public async markExpired(now: string): Promise<string[]> {
    const due = await this.database
      .prepare(
        `SELECT id FROM faqs WHERE ${LATEST_REVISION_PREDICATE} AND status = 'active' `
          + 'AND expires_at IS NOT NULL AND expires_at <= ?'
      )
      .bind(now)
      .all<{ id: string }>();
    const ids = due.results.map((row) => row.id);

    for (const id of ids) {
      await this.database
        .prepare(
          `UPDATE faqs SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'active' `
            + 'AND expires_at IS NOT NULL AND expires_at <= ?'
        )
        .bind(now, id, now)
        .run();
    }
    return ids;
  }

  /**
   * Insert one revision row.
   *
   * @param faq Fully resolved revision.
   * @returns A promise fulfilled once the row is durable.
   * @throws {Error} When D1 rejects the insert.
   */
  private async write(faq: Faq): Promise<void> {
    await this.database
      .prepare(
        'INSERT INTO faqs (id, revision, question, answer, product_id, owner_identity_key, '
          + 'audience, expires_at, status, source_escalation_id, created_at, updated_at) '
          + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        faq.id,
        faq.revision,
        faq.question,
        faq.answer,
        faq.productId,
        faq.ownerIdentityKey,
        faq.audience,
        faq.expiresAt,
        faq.status,
        faq.sourceEscalationId,
        faq.createdAt,
        faq.updatedAt
      )
      .run();
  }
}
