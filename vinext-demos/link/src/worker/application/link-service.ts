import type { LinkRepository, ShortLink } from '../domain/link';
import { validateCode, validateLinkInput } from '../domain/link-validation';

/**
 * Business logic for short links — the tier between the HTTP API and persistence.
 *
 * Routes hand this service raw, untrusted values (a parsed JSON body, a path parameter) and receive
 * domain objects back. Validation and the order of operations live here rather than in the Hono
 * handlers, so the same rules apply no matter which transport calls them, and the routes stay thin
 * enough to read as a description of the API surface.
 *
 * The service depends on the {@link LinkRepository} port, not on Workers KV, so the storage
 * technology can change (or be faked in a test) without touching business logic.
 */
export class LinkService {
  /**
   * @param repository Persistence port used to store and retrieve links.
   */
  constructor(private readonly repository: LinkRepository) {}

  /**
   * Create a short link for a caller-supplied destination.
   *
   * @param body Unvalidated JSON body from the request.
   * @returns The newly created link.
   * @throws {ProblemDetailsError} When the body is not a valid link payload.
   */
  async createLink(body: unknown): Promise<ShortLink> {
    return this.repository.create(validateLinkInput(body));
  }

  /**
   * Delete a short link.
   *
   * @param code Unvalidated short code from the request path.
   * @returns A promise fulfilled after the repository deletes the matching link.
   * @throws {ProblemDetailsError} When the code is malformed or unknown.
   */
  async deleteLink(code: string): Promise<void> {
    await this.repository.delete(validateCode(code));
  }

  /**
   * Read one short link.
   *
   * @param code Unvalidated short code from the request path.
   * @returns The stored link.
   * @throws {ProblemDetailsError} When the code is malformed or unknown.
   */
  async getLink(code: string): Promise<ShortLink> {
    return this.repository.get(validateCode(code));
  }

  /**
   * List every short link for the administrative UI.
   *
   * @returns Links ordered by most recently updated first.
   */
  async listLinks(): Promise<ShortLink[]> {
    return this.repository.list();
  }

  /**
   * Replace a short link's destination, preserving its code.
   *
   * @param code Unvalidated short code from the request path.
   * @param body Unvalidated JSON body from the request.
   * @returns The updated link.
   * @throws {ProblemDetailsError} When the code or body is invalid, or the link is unknown.
   */
  async updateLink(code: string, body: unknown): Promise<ShortLink> {
    const validCode = validateCode(code);
    return this.repository.update(validCode, validateLinkInput(body));
  }

  /**
   * Resolve a public short code to its redirect destination.
   *
   * Separate from {@link LinkService.getLink} because it is the one use case reachable without
   * authentication: keeping it named distinctly makes the public surface obvious at the call site
   * and leaves room for redirect-only concerns such as click accounting.
   *
   * @param code Unvalidated short code from the request path.
   * @returns The link to redirect to.
   * @throws {ProblemDetailsError} When the code is malformed or unknown.
   */
  async resolveDestination(code: string): Promise<ShortLink> {
    return this.repository.get(validateCode(code));
  }
}
