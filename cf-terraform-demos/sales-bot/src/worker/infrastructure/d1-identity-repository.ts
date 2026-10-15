import type { ActorIdentityRepository, IdentityRecord } from '../application/actor-resolver';
import { parseClearance } from '../application/actor-resolver';
import type { IdentityRepository } from '../application/identity-service';
import type { Role } from '../domain/role';

/**
 * Raw identity row as stored in D1.
 */
interface IdentityRow {
  /**
   * Stable identity key.
   */
  identity_key: string;
  /**
   * Configured role.
   */
  role: Role;
  /**
   * Explicit audience clearance, or `null` to use the role default.
   */
  audience_clearance: string | null;
}

/**
 * D1 adapter for both identity ports.
 *
 * One class rather than two because both ports read the same row, and splitting them would mean two
 * queries per request for data that arrives together. The ports stay separate so that `/api/me`
 * depends only on the role lookup it uses, and the authorization subject depends on the richer
 * record it needs.
 *
 * Both methods filter on `enabled = 1`. A disabled identity therefore resolves exactly as an
 * unmapped one does — least-privileged salesperson, default clearance, no product scope — rather
 * than retaining whatever role it had when it was disabled.
 */
export class D1IdentityRepository implements IdentityRepository, ActorIdentityRepository {
  /**
   * @param database Authoritative D1 binding.
   */
  public constructor(private readonly database: Pick<D1Database, 'prepare'>) {}

  /**
   * Look up the enabled role for a verified email.
   *
   * @param email Verified email; never accepted from client input.
   * @returns Stored role, or salesperson when the identity is not mapped or is disabled.
   * @throws {Error} When D1 rejects the query.
   */
  public async findRole(email: string): Promise<Role> {
    return (await this.findByEmail(email))?.role ?? 'salesperson';
  }

  /**
   * Read the stored record for a verified email.
   *
   * @param email Verified email; never accepted from client input.
   * @returns The record, or `null` when the identity is unmapped or disabled.
   * @throws {Error} When D1 rejects the query.
   */
  public async findByEmail(email: string): Promise<IdentityRecord | null> {
    const row = await this.database
      .prepare(
        'SELECT identity_key, role, audience_clearance FROM identities '
          + 'WHERE email = ?1 AND enabled = 1'
      )
      .bind(email)
      .first<IdentityRow>();
    if (row === null) {
      return null;
    }
    return {
      identityKey: row.identity_key,
      role: row.role,
      audienceClearance: parseClearance(row.audience_clearance)
    };
  }
}
