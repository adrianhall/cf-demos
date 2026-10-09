import type { DirectoryPage, DirectoryRows } from '../../domain/user.ts';

/**
 * Persistence port for the lightweight user directory.
 *
 * The application service depends on this interface, never on D1, so the storage choice can change
 * — or be replaced by an in-memory fake in a unit test — without touching a business rule.
 *
 * Every method here is **authorization-neutral** by design. A port that took an "is this caller
 * allowed?" decision would put the same rule in two places once a second transport (the MCP tool
 * layer in a later phase) calls the same use cases. Ownership and administrator decisions therefore
 * live in the application tier, and this port only stores and retrieves.
 *
 * Neither read here takes an actor. "Who may see the directory?" is an administrator decision taken
 * once in `../admin-service.ts`, and "who may add a collaborator?" is an ownership decision taken
 * once in `../collaborator-service.ts`; restating either here would put it somewhere a second
 * transport could reach storage without it.
 */
export interface UserRepository {
  /**
   * Records one authenticated request from an identity: inserts a directory row on first sight, or
   * refreshes only `lastSeenAt` on every subsequent request.
   *
   * `firstSeenAt` is deliberately never updated after insert — it is the one value in the directory
   * that would be destroyed rather than merely stale if the update branch touched it.
   *
   * @param email Verified Cloudflare Access identity email.
   * @param seenAt ISO-8601 timestamp to record. Passed in rather than read from the clock inside
   *   the adapter so a test can assert the stored value instead of tolerating whatever "now" was.
   * @returns A promise fulfilled once the row has been inserted or refreshed.
   * @throws {Error} When the underlying store rejects the write.
   */
  recordSeen(email: string, seenAt: string): Promise<void>;

  /**
   * Reports whether an identity has ever authenticated against this deployment.
   *
   * The one read of the directory that is **not** administrative, and the one place this demo uses
   * the directory for anything beyond the administrative view. It backs a single rule: a diagram's
   * owner may only grant edit access to somebody who has signed in through this Access application
   * at least once — see `../collaborator-service.ts`.
   *
   * That rule is what keeps this demo free of an invitation system. The alternative, accepting any
   * email, would mean writing a grant for an identity that may never exist, and then needing a mail
   * product to tell them about it. Requiring a prior sign-in hands the problem back to the two
   * people involved, exactly as the anonymous share link already does.
   *
   * Note what this does **not** become. The directory is still not an authorization source: the
   * answer here widens nothing on its own, it only decides whether a grant the owner is already
   * authorized to make may name this particular address. Whether that grant then permits anything
   * is decided by the grant row, not by this table.
   *
   * @param email Verified Cloudflare Access identity email to look for. Compared exactly, because
   *   every other identity comparison in this application is exact and two spellings must not
   *   silently resolve to one identity.
   * @returns `true` when the directory holds a row for that email, and `false` otherwise.
   * @throws {Error} When the underlying store rejects the read.
   */
  exists(email: string): Promise<boolean>;

  /**
   * Reads one page of the directory, most recently active identity first, each row annotated with
   * how many diagrams that identity currently owns.
   *
   * The ordering is part of the contract rather than an adapter's choice: the administrative view
   * exists to answer "who has been using this deployment", and a page ordered by anything else
   * would make the first page the least interesting one. The total is returned alongside the rows
   * because a page of rows cannot say whether another page exists.
   *
   * Returns the rows and the total only. Echoing the window back is the application tier's job,
   * since it is the caller's own value and storage merely obeyed it.
   *
   * @param page Validated pagination window.
   * @returns The requested rows and the directory's total row count.
   * @throws {Error} When the underlying store rejects the read.
   */
  listWithDiagramCounts(page: DirectoryPage): Promise<DirectoryRows>;
}
