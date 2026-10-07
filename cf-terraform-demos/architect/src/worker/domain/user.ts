/**
 * @file The administrator rule and the `users` directory's own data shapes. Pure: no bindings, no
 *   fetch, no storage and no identity headers, so every transport that needs to answer "is this
 *   caller the administrator?" answers it the same way — the HTTP API today, and the MCP tool layer
 *   in a later phase without a second implementation. Note what the directory is _not_ used for.
 *   Authentication writes a row as a best-effort side effect, and the only reader is the
 *   administrative view below; nothing consults it to decide what a caller may do. That is exactly
 *   the property that keeps a writable table from becoming an authorization source, and it is why
 *   {@link isAdministrator} reads a Worker variable rather than a column.
 */

/**
 * Reports whether a verified identity is this demo's single administrator.
 *
 * This is the _only_ administrator rule in the application. There is no role column, no
 * promote/demote flow and no first-user-wins bootstrap: exactly one identity is the administrator,
 * named by the operator through the `ADMIN_EMAIL` Worker variable. An attacker who could write to
 * the `users` table therefore still cannot grant themselves administrative access, because nothing
 * in that table is consulted here.
 *
 * Comparison is exact rather than case-insensitive or trimmed. An Access identity's email claim is
 * whatever the identity provider asserts, and treating two spellings as equivalent would widen the
 * set of accepted identities beyond the single value the operator configured.
 *
 * @param email Verified identity email, taken from the validated Access JWT and never from a
 *   request parameter, body or header.
 * @param adminEmail Value of the `ADMIN_EMAIL` Worker variable, or `undefined` when it is not
 *   bound.
 * @returns `true` only when `adminEmail` is a non-empty value that `email` exactly equals. An
 *   unbound or empty `ADMIN_EMAIL` makes _nobody_ an administrator, which fails closed: the
 *   alternative — treating the absent value as matching — would make every identity an
 *   administrator on a misconfigured deployment.
 */
export function isAdministrator(email: string, adminEmail: string | undefined): boolean {
  if (!adminEmail) {
    return false;
  }
  return email === adminEmail;
}

/**
 * One row of the lightweight `users` directory.
 *
 * Backs only the administrative directory view. There is deliberately no `isAdmin` field — and no
 * `is_admin` column behind it — because the administrator is operator configuration, not stored
 * state; see {@link isAdministrator}.
 */
export interface UserDirectoryEntry {
  /**
   * Verified Cloudflare Access identity email, and the table's primary key.
   */
  email: string;
  /**
   * Human-readable display name.
   *
   * Always `null` today, and shown anyway rather than dropped: the verified Access identity carries
   * only `email`, `sub` and `source`, and this demo provisions no identity provider of its own that
   * could supply a name claim. The column exists so the directory's documented shape is visible
   * rather than silently absent, and so a deployment whose provider _does_ assert a name has
   * somewhere to put it.
   */
  displayName: string | null;
  /**
   * ISO-8601 timestamp recorded the first time this identity authenticated.
   */
  firstSeenAt: string;
  /**
   * ISO-8601 timestamp recorded on this identity's most recent authenticated request.
   */
  lastSeenAt: string;
}

/**
 * A directory row annotated with how many diagrams that identity currently owns.
 *
 * The count is computed at read time from the `diagrams` table rather than held in a counter
 * column, so it cannot drift from the diagrams a user actually has. A denormalised counter would be
 * a second thing every create, duplicate and delete had to keep in step — including the
 * administrative delete, which is precisely the operation most likely to be forgotten.
 */
export interface AdminUserDirectoryEntry extends UserDirectoryEntry {
  /**
   * Number of diagrams currently owned by this identity.
   */
  diagramCount: number;
}

/**
 * Validated pagination window for the administrative directory read.
 */
export interface DirectoryPage {
  /**
   * Maximum number of rows to return.
   */
  limit: number;
  /**
   * Number of rows to skip before the returned page.
   */
  offset: number;
}

/**
 * The rows a directory read produced, and how many rows exist in total.
 *
 * What storage can answer, and no more. The window the rows were read with is the _caller's_ value
 * rather than the store's, so it is added above this tier — see {@link AdminUserDirectoryPage}.
 */
export interface DirectoryRows {
  /**
   * Up to `limit` directory entries, most recently active first.
   */
  users: AdminUserDirectoryEntry[];
  /**
   * Total number of distinct identities in the directory, independent of pagination. A page of rows
   * cannot say whether another page exists, so the count is read alongside it.
   */
  total: number;
}

/**
 * One page of the administrative user directory, as a caller receives it.
 *
 * The window travels back with the rows deliberately. Both parameters are optional on the way in,
 * so a client that sent neither would otherwise have no way to know which window it got — and
 * therefore no way to ask for the next one without guessing the server's defaults.
 */
export type AdminUserDirectoryPage = DirectoryRows & DirectoryPage;
