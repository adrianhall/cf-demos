import { sqlCount } from "@adrianhall/cloudflare-toolkit/guards";
import type { AdminUserDirectoryEntry, AdminUserDirectoryPage } from "./types";

/** Raw snake-cased directory row, joined with a diagram count, as returned by D1. */
interface UserDirectoryRow {
  email: string;
  display_name: string | null;
  first_seen_at: string;
  last_seen_at: string;
  diagram_count: number;
}

/** Convert D1's storage shape into the API representation. */
function toDirectoryEntry(row: UserDirectoryRow): AdminUserDirectoryEntry {
  return {
    diagramCount: row.diagram_count,
    displayName: row.display_name,
    email: row.email,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

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

  /**
   * Report whether `email` has ever signed in to this Access application -- i.e. has at least
   * one row in the `users` directory. Used by
   * `../collaborators/repository.ts`'s `CollaboratorRepository.add()` to enforce
   * docs/09C-COLLABORATIVE-EDITING.md's Non-Goals: adding a collaborator requires that identity
   * to already exist here, never an open-ended invite-by-any-email flow.
   *
   * @param email Candidate email.
   * @returns Whether `email` has a row in the `users` directory.
   */
  async exists(email: string): Promise<boolean> {
    const row = await this.database
      .prepare(`SELECT 1 FROM users WHERE email = ? LIMIT 1`)
      .bind(email)
      .first();
    return row !== null;
  }

  /**
   * List a page of the directory, most recently active identity first, each row annotated with
   * how many diagrams it currently owns -- the admin user-directory view
   * (`GET /api/admin/users`, docs/09-ARCHITECT.md Phase 4). The count is computed with a
   * correlated subquery against `diagrams.owner_email` rather than a denormalized counter
   * column, so it can never drift from the diagrams a user actually owns.
   *
   * @param options Pagination window.
   * @param options.limit Maximum number of rows to return.
   * @param options.offset Number of rows to skip before the returned page.
   * @returns The requested page of directory entries, plus the total row count across every
   * page (unaffected by `limit`/`offset`).
   */
  async listWithDiagramCounts(options: {
    limit: number;
    offset: number;
  }): Promise<AdminUserDirectoryPage> {
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
         LIMIT ? OFFSET ?`,
      )
      .bind(options.limit, options.offset)
      .all<UserDirectoryRow>();

    const totalRow = await this.database
      .prepare(`SELECT COUNT(*) AS count FROM users`)
      .first<{ count: number }>();

    return {
      total: sqlCount(totalRow),
      users: results.map(toDirectoryEntry),
    };
  }
}
