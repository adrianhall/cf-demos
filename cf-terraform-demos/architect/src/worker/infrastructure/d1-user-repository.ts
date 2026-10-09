import { sqlCount } from '@adrianhall/cloudflare-toolkit/guards';
import type { UserRepository } from '../application/ports/user-repository.ts';
import type { AdminUserDirectoryEntry, DirectoryPage, DirectoryRows } from '../domain/user.ts';

/**
 * One directory row joined with its diagram count, in D1's snake-cased column names.
 */
interface UserDirectoryRow {
  email: string;
  display_name: string | null;
  first_seen_at: string;
  last_seen_at: string;
  diagram_count: number;
}

/**
 * Converts a stored row into the domain shape.
 *
 * @param row Row as returned by D1.
 * @returns The directory entry in the application tier's vocabulary.
 */
function toDirectoryEntry(row: UserDirectoryRow): AdminUserDirectoryEntry {
  return {
    diagramCount: row.diagram_count,
    displayName: row.display_name,
    email: row.email,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at
  };
}

/**
 * D1 adapter implementing {@link UserRepository}.
 *
 * D1 rather than KV because the administrative view this directory backs lists identities ordered
 * by recent activity and annotated with a diagram count — both queries by predicate across the
 * whole table, which is what a relational store is for and what a key-value store cannot answer
 * without reading every key. The count in particular is a join between two tables, which is not a
 * question a key-value store can be asked at all.
 */
export class D1UserRepository implements UserRepository {
  /**
   * @param database D1 binding. Narrowed to the one capability this adapter uses, so a unit test
   *   can supply a small fake rather than a complete `D1Database` implementation.
   */
  constructor(private readonly database: Pick<D1Database, 'prepare'>) {}

  /**
   * Inserts a directory row on first sight, or refreshes `last_seen_at` on a subsequent request.
   *
   * One statement rather than a read followed by a conditional write: an upsert is atomic, whereas
   * check-then-write races two concurrent requests from the same identity against each other and
   * can lose the insert.
   *
   * `display_name` is written as `NULL` and never touched by the update branch, because no
   * request-time source for it exists: the verified Access identity carries only `email`, `sub` and
   * `source`, and this demo provisions no identity provider that could supply a name claim.
   *
   * @param email Verified Cloudflare Access identity email.
   * @param seenAt ISO-8601 timestamp to record.
   * @returns A promise fulfilled once the row has been written.
   * @throws {Error} When D1 rejects the statement.
   */
  async recordSeen(email: string, seenAt: string): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO users (email, display_name, first_seen_at, last_seen_at)
         VALUES (?, NULL, ?, ?)
         ON CONFLICT(email) DO UPDATE SET last_seen_at = excluded.last_seen_at`
      )
      .bind(email, seenAt, seenAt)
      .run();
  }

  /**
   * Reports whether a directory row exists for one email.
   *
   * Selects a literal rather than the row, because the question is existence: the caller
   * (`../application/collaborator-service.ts`) needs a yes or no, and reading four columns to
   * discard three of them would be work done for nothing. The lookup is on `users.email`, the
   * table's primary key, so it is an index seek rather than a scan.
   *
   * The comparison is exact, matching every other identity comparison in this application. An owner
   * who types a collaborator's address with different capitalisation is told that person has not
   * signed in — the same answer any other unrecognised address gets — rather than having two
   * spellings silently resolved to one identity.
   *
   * @param email Verified Cloudflare Access identity email to look for.
   * @returns `true` when the directory holds a row for that email.
   * @throws {Error} When D1 rejects the statement.
   */
  async exists(email: string): Promise<boolean> {
    const row = await this.database
      .prepare('SELECT 1 AS present FROM users WHERE email = ? LIMIT 1')
      .bind(email)
      .first<{ present: number }>();

    return row !== null;
  }

  /**
   * Reads one page of the directory, most recently active first, each row carrying its owner's
   * current diagram count.
   *
   * The count comes from a correlated subquery against `diagrams.owner_email` rather than a
   * denormalised counter column, so it cannot drift from the diagrams an identity actually owns —
   * including after a moderation delete, which is exactly the operation a counter would be
   * forgotten in. The subquery rides the `diagrams_owner_email_idx` index
   * (`migrations/0001_create_diagrams_and_users.sql`), so it is a per-row index lookup rather than
   * a scan of the shared table.
   *
   * The total is read as a second statement rather than as a window function over the first,
   * because `LIMIT` is applied before a window would be evaluated: the paged query simply cannot
   * see the rows it excluded.
   *
   * @param page Validated pagination window.
   * @returns The requested rows and the directory's total row count.
   * @throws {Error} When D1 rejects either statement.
   */
  async listWithDiagramCounts(page: DirectoryPage): Promise<DirectoryRows> {
    const { results } = await this.database
      .prepare(
        `SELECT
           u.email AS email,
           u.display_name AS display_name,
           u.first_seen_at AS first_seen_at,
           u.last_seen_at AS last_seen_at,
           (SELECT COUNT(*) FROM diagrams d WHERE d.owner_email = u.email) AS diagram_count
         FROM users u
         ORDER BY u.last_seen_at DESC, u.email ASC
         LIMIT ? OFFSET ?`
      )
      .bind(page.limit, page.offset)
      .all<UserDirectoryRow>();

    const totalRow = await this.database
      .prepare('SELECT COUNT(*) AS count FROM users')
      .first<{ count: number }>();

    // `sqlCount` rather than `totalRow?.count ?? 0`. A `COUNT(*)` always produces a row, so a
    // missing or non-numeric one is a storage fault rather than an empty directory — and the two
    // must not look alike. The guard fails loudly where `?? 0` would report "nobody has ever
    // signed in" to an administrator looking at a broken database.
    return { total: sqlCount(totalRow), users: results.map(toDirectoryEntry) };
  }
}
