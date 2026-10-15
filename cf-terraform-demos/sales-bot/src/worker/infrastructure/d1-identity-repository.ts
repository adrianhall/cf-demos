import type { IdentityRepository } from '../application/identity-service';
import type { Role } from '../domain/role';

/**
 * D1 adapter for the identity role port.
 */
export class D1IdentityRepository implements IdentityRepository {
  /**
   * @param database Authoritative D1 binding.
   */
  public constructor(private readonly database: D1Database) {}

  /**
   * Look up the enabled role for a verified email.
   *
   * @param email Verified email; never accepted from client input.
   * @returns Stored role, or salesperson when the identity is not mapped yet.
   */
  public async findRole(email: string): Promise<Role> {
    const row = await this.database
      .prepare('SELECT role FROM identities WHERE email = ?1 AND enabled = 1')
      .bind(email)
      .first<{ role: Role }>();
    return row?.role ?? 'salesperson';
  }
}
