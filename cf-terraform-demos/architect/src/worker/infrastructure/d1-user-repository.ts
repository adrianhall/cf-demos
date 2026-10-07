import type { UserRepository } from '../application/ports/user-repository.ts';

/**
 * D1 adapter implementing {@link UserRepository}.
 *
 * D1 rather than KV because the administrative view this directory backs lists identities ordered
 * by recent activity and annotated with a diagram count — both queries by predicate across the
 * whole table, which is what a relational store is for and what a key-value store cannot answer
 * without reading every key.
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
}
