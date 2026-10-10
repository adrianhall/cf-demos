import { throwIfNull } from "@adrianhall/cloudflare-toolkit/guards";
import { type Business, type Geo, isBusiness, isGeo } from "./business";
import type { User } from "./types";

/** Raw snake-cased user row returned by D1. */
interface UserRow {
  email: string;
  is_admin: number;
  business: string | null;
  geo: string | null;
  created_at: string;
}

/** Convert D1's storage shape into the API representation. `row.business`/`row.geo` are
 * defensively coerced back to `null` for anything that is not a valid, currently-recognized
 * enum value (docs/06-AGENTIC-CHAT.md Section 6.4's "application-level enum, not a D1 CHECK
 * constraint" choice means the column itself never rejects an unrecognized string) -- mirrors
 * `../chats/repository.ts`'s own `toChat()` coercion for `route`. */
function toUser(row: UserRow): User {
  return {
    email: row.email,
    isAdmin: row.is_admin === 1,
    business: isBusiness(row.business) ? row.business : null,
    geo: isGeo(row.geo) ? row.geo : null,
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
    const user = await this.findByEmail(email);
    throwIfNull(
      user,
      `User ${email} not found in D1 immediately after ensureUser() upserted it`,
    );
    return user;
  }

  /**
   * Look up one user directory row by email, tolerant of a missing row -- unlike
   * `ensureUser()`'s own read-back (above), where "no row found immediately after this
   * repository's own upsert" is a defensive guard failure, here "no row yet" is an ordinary,
   * expected outcome: an identity that has never signed in (`requireAdmin`'s own `isAdmin()`
   * check, below), or an admin `PATCH`ing an email with no `users` row at all
   * (`updateMetadata()`, below, returns `null` rather than throwing).
   *
   * @param email Verified Cloudflare Access identity email.
   * @returns The persisted user, or `null` if no row exists for `email`.
   */
  async findByEmail(email: string): Promise<User | null> {
    const row = await this.database
      .prepare(
        "SELECT email, is_admin, business, geo, created_at FROM users WHERE email = ? LIMIT 1",
      )
      .bind(email)
      .first<UserRow>();
    return row === null ? null : toUser(row);
  }

  /**
   * Whether an identity currently holds this demo's D1-flagged administrator role
   * (docs/06-AGENTIC-CHAT.md Section 6.5) -- the one check `../middleware/require-admin.ts`
   * needs on every `/api/admin/*` route. An identity with no `users` row at all (one that has
   * never signed in) is correctly treated as non-administrator, not specially handled.
   *
   * @param email Verified Cloudflare Access identity email.
   * @returns Whether `email` holds the administrator role.
   */
  async isAdmin(email: string): Promise<boolean> {
    const user = await this.findByEmail(email);
    return user?.isAdmin ?? false;
  }

  /**
   * List every signed-in user, for the admin console's ranked cost table
   * (docs/06-AGENTIC-CHAT.md Phase 7, US-6, `GET /api/admin/users`). Ordered by email rather
   * than cost -- this repository has no visibility into `chat_usage`; the caller
   * (`../routes/admin.ts`) joins in each user's cost from `UsageRepository.aggregateForAllUsers()`
   * and re-sorts by that figure afterward.
   *
   * @returns Every user directory row.
   */
  async list(): Promise<User[]> {
    const { results } = await this.database
      .prepare(
        "SELECT email, is_admin, business, geo, created_at FROM users ORDER BY email ASC",
      )
      .all<UserRow>();
    return results.map(toUser);
  }

  /**
   * Set a user's admin-assigned business/geo segments (docs/06-AGENTIC-CHAT.md Phase 7, US-6),
   * always both together -- the caller (`../routes/admin.ts`) always sends both fields, so this
   * never has to guess whether an omitted field means "leave unchanged" or "clear it."
   *
   * @param email The user to update.
   * @param business The new business segment, or `null` to clear it.
   * @param geo The new geo segment, or `null` to clear it.
   * @returns The updated user, or `null` if no `users` row exists for `email` (the caller must
   * reject this as `404`, not silently succeed).
   */
  async updateMetadata(
    email: string,
    business: Business | null,
    geo: Geo | null,
  ): Promise<User | null> {
    const result = await this.database
      .prepare("UPDATE users SET business = ?, geo = ? WHERE email = ?")
      .bind(business, geo, email)
      .run();
    if (result.meta.changes === 0) {
      return null;
    }
    return this.findByEmail(email);
  }
}
