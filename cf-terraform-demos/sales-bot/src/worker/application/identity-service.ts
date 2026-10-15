import type { Role } from '../domain/role';

/**
 * Verified identity returned to the browser.
 */
export interface Identity {
  /**
   * Stable Access email identity.
   */
  email: string;
  /**
   * Role used by the Phase 1 navigation shell.
   */
  role: Role;
}

/**
 * Repository port for resolving roles independently from D1.
 */
export interface IdentityRepository {
  /**
   * Resolve a verified email to an enabled role.
   *
   * @param email Verified Access email.
   * @returns The configured role, or the least-privileged salesperson default.
   */
  findRole(email: string): Promise<Role>;
}

/**
 * Application use case for the authenticated `/api/me` endpoint.
 */
export class IdentityService {
  /**
   * @param identities Role repository injected at the composition root.
   */
  public constructor(private readonly identities: IdentityRepository) {}

  /**
   * Resolve the authenticated identity into a browser-safe representation.
   *
   * @param email Verified email supplied only by Access middleware.
   * @returns The identity and currently effective role.
   */
  public async getMe(email: string): Promise<Identity> {
    return { email, role: await this.identities.findRole(email) };
  }
}
