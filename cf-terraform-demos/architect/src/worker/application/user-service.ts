import type { UserRepository } from './ports/user-repository.ts';

/**
 * Use cases for the user directory — the tier between the HTTP API and persistence.
 *
 * Routes hand this service a verified Cloudflare Access identity and nothing else. It depends only
 * on the {@link UserRepository} port, so the same use case will serve the MCP tool layer in a later
 * phase as an in-process function call rather than an internal HTTP round trip.
 */
export class UserService {
  /**
   * @param repository Persistence port backing the directory.
   */
  constructor(private readonly repository: UserRepository) {}

  /**
   * Records that a verified identity made an authenticated request.
   *
   * Called as a **best-effort side effect** of authentication, which is why it returns whether the
   * write succeeded rather than propagating a failure. The directory is a convenience for the
   * administrative view; it is not an authorization source, and nothing a signed-in user is trying
   * to do should fail because a directory row could not be refreshed. A caller that let this throw
   * would convert a cosmetic storage problem into an outage for every authenticated request.
   *
   * The failure is deliberately not silent: the caller logs it, so a persistently unwritable
   * directory is visible in observability rather than only as a mysteriously empty admin table.
   *
   * @param email Verified Cloudflare Access identity email, taken from the validated JWT.
   * @param now Clock used for the timestamp. Injected so a test asserts a known value; defaults to
   *   the real clock for production callers.
   * @returns `true` when the row was written, and `false` when the write failed.
   */
  async recordAuthenticatedRequest(
    email: string,
    now: () => Date = () => new Date()
  ): Promise<boolean> {
    try {
      await this.repository.recordSeen(email, now().toISOString());
      return true;
    } catch {
      return false;
    }
  }
}
