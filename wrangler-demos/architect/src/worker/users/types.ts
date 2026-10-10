/**
 * A row in the lightweight `users` directory (docs/09-ARCHITECT.md's Data Model). Backs only the
 * Phase 4 admin user-directory view — never consulted for authorization.
 */
export interface UserDirectoryEntry {
  /** Verified Cloudflare Access identity email, and the table's primary key. */
  email: string;
  /**
   * Human-readable display name. Always `null` today: `cloudflareAccess()`'s verified identity
   * exposes only `email`, `sub`, and `source` (no name claim), and this demo provisions no
   * Identity Provider of its own that could supply one (docs/09-ARCHITECT.md's Decisions #2).
   */
  displayName: string | null;
  /** ISO-8601 timestamp recorded the first time this identity authenticated. */
  firstSeenAt: string;
  /** ISO-8601 timestamp recorded on this identity's most recent authenticated request. */
  lastSeenAt: string;
}

/**
 * One row of the admin user directory (`GET /api/admin/users`): a {@link UserDirectoryEntry} plus
 * how many diagrams that identity currently owns. The count is computed at read time from the
 * `diagrams` table -- there is no denormalized counter column to keep in sync.
 */
export interface AdminUserDirectoryEntry extends UserDirectoryEntry {
  /** Number of diagrams currently owned by this identity. */
  diagramCount: number;
}

/** A page of the admin user directory, plus the total row count for pagination. */
export interface AdminUserDirectoryPage {
  /** Up to `limit` directory entries, most recently active first. */
  users: AdminUserDirectoryEntry[];
  /** Total number of distinct identities in the directory, independent of pagination. */
  total: number;
}
