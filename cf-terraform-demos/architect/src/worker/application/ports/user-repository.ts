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
 * {@link UserRepository.listWithDiagramCounts} is the one read, and it takes no actor: "who may see
 * the directory?" is an administrator decision, and it is taken once in `../admin-service.ts`
 * rather than restated here where a second transport could reach storage without it.
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
