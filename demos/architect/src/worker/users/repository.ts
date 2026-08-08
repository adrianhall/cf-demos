/**
 * D1 persistence boundary for the lightweight `users` directory
 * (docs/09-ARCHITECT.md's Data Model). Every method is keyed on the verified Cloudflare Access
 * identity's email; there is no separate internal user identifier.
 */
export class UserRepository {
  /** @param database D1 database capability used to prepare the repository's statements. */
  constructor(private readonly database: Pick<D1Database, "prepare">) {}

  /**
   * Record one authenticated request from `email`: insert a new directory row on first sight, or
   * refresh `last_seen_at` on every subsequent request. `display_name` is left untouched by the
   * update branch since no request-time source for it exists — see
   * `UserDirectoryEntry.displayName` (`./types.ts`).
   *
   * @param email Verified Cloudflare Access identity email.
   * @returns Promise resolved once the row has been inserted or refreshed.
   */
  async upsert(email: string): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.database
      .prepare(
        `INSERT INTO users (email, display_name, first_seen_at, last_seen_at)
         VALUES (?, NULL, ?, ?)
         ON CONFLICT(email) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .bind(email, timestamp, timestamp)
      .run();
  }
}
