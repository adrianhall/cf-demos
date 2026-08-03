import { throwIfNull } from "@adrianhall/cloudflare-toolkit/guards";
import type { User } from "./types";

/** Raw snake-cased user row returned by D1. */
interface UserRow {
  email: string;
  is_admin: number;
  created_at: string;
}

/** Convert D1's storage shape into the API representation. */
function toUser(row: UserRow): User {
  return {
    email: row.email,
    isAdmin: row.is_admin === 1,
    createdAt: row.created_at,
  };
}

/**
 * D1 persistence boundary for the user directory, including this demo's D1-flagged
 * administrator role (docs/06-AGENTIC-CHAT.md Section 6.5).
 */
export class UserRepository {
  /** @param database D1 capability used to prepare the repository's statements. */
  constructor(private readonly database: Pick<D1Database, "prepare">) {}

  /**
   * Idempotently ensure a D1 row exists for a verified identity, called after every successful
   * Access verification (`../routes/me.ts`) so a user never needs a separate registration step.
   *
   * The two outcomes are deliberately different SQL statements, not one parameterized branch:
   *
   * - An ordinary identity (`isAdmin = false`) only ever inserts a fresh row on first sign-in
   *   and never touches an existing row's `is_admin` -- preserving a manual promotion a future
   *   admin console (`docs/06-AGENTIC-CHAT.md` Phase 7) makes to a non-configured-administrator
   *   user.
   * - The configured administrator's identity (`isAdmin = true`, i.e. `email === ADMIN_EMAIL`)
   *   is idempotently re-forced to `is_admin = 1` on every sign-in regardless of prior D1 state,
   *   so the role survives a redeploy or a partial teardown that left a stale, demoted row
   *   behind.
   *
   * @param email Verified Cloudflare Access identity email.
   * @param isAdmin Whether this sign-in matches the Worker's configured `ADMIN_EMAIL`.
   * @returns The persisted user row reflecting this upsert.
   */
  async ensureUser(email: string, isAdmin: boolean): Promise<User> {
    const createdAt = new Date().toISOString();
    const statement = isAdmin
      ? this.database
          .prepare(
            `INSERT INTO users (email, is_admin, created_at) VALUES (?, 1, ?)
             ON CONFLICT (email) DO UPDATE SET is_admin = 1`,
          )
          .bind(email, createdAt)
      : this.database
          .prepare(
            `INSERT INTO users (email, is_admin, created_at) VALUES (?, 0, ?)
             ON CONFLICT (email) DO NOTHING`,
          )
          .bind(email, createdAt);
    await statement.run();
    return this.get(email);
  }

  /**
   * Read one user directory row.
   *
   * @param email Verified Cloudflare Access identity email.
   * @returns The persisted user.
   * @throws {ProblemDetailsError} `throwIfNull`'s `NullError` if no row exists for `email` --
   * this should never happen immediately after `ensureUser()` upserted it.
   */
  private async get(email: string): Promise<User> {
    const row = await this.database
      .prepare(
        "SELECT email, is_admin, created_at FROM users WHERE email = ? LIMIT 1",
      )
      .bind(email)
      .first<UserRow>();
    throwIfNull(
      row,
      `User ${email} not found in D1 immediately after ensureUser() upserted it`,
    );
    return toUser(row);
  }
}
