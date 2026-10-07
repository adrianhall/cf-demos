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
 * The interface carries exactly what this phase uses. The paginated, diagram-count-annotated read
 * the administrative directory view needs is added in Phase 6 alongside the route that calls it,
 * rather than declared here in advance: a port method with no caller has no test that exercises it
 * for real, which makes it a guess about a future query rather than a contract.
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
}
