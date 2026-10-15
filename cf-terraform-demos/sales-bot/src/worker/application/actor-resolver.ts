import type { Actor } from '../domain/actor';
import { defaultClearanceForRole, isAudience, type Audience } from '../domain/audience';
import type { ProductRepository } from '../domain/product';
import type { Role } from '../domain/role';

/**
 * What the identity store knows about a verified person.
 */
export interface IdentityRecord {
  /**
   * Stable identity key. For a web identity this is derived from the verified email.
   */
  identityKey: string;
  /**
   * Role resolved from D1.
   */
  role: Role;
  /**
   * Explicit audience clearance an administrator set, or `null` to use the role default.
   */
  audienceClearance: Audience | null;
}

/**
 * Repository port for reading the stored facts about a verified identity.
 *
 * Separate from the Phase 1 role lookup because the knowledge base needs the identity key and the
 * clearance as well, and because an unmapped identity must still resolve to something usable: a
 * person who has signed in but has not been mapped yet is a salesperson with the default clearance,
 * not an error.
 */
export interface ActorIdentityRepository {
  /**
   * Read the stored record for a verified email.
   *
   * @param email Verified Access email, supplied only by the Access middleware.
   * @returns The stored record, or `null` when the identity has not been mapped.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByEmail(email: string): Promise<IdentityRecord | null>;
}

/**
 * Derive the identity key for an email that is not yet mapped in D1.
 *
 * Signing in does not create a row — an administrator maps identities deliberately — but the actor
 * still needs a stable key so that anything they create is attributable and so the audit trail is
 * not full of nulls. The verified email is that key: it comes from the JWT, so it is as trustworthy
 * as the session itself.
 *
 * @param email Verified Access email.
 * @returns A stable identity key for an unmapped identity.
 */
export function provisionalIdentityKey(email: string): string {
  return `web:${email.toLowerCase()}`;
}

/**
 * Narrow a stored clearance column to an {@link Audience}.
 *
 * A value that is not one of the four audiences is treated as absent rather than trusted. The
 * column has a `CHECK` constraint, so this only matters if the schema is changed carelessly — in
 * which case falling back to the role default is the fail-closed outcome.
 *
 * @param value Raw column value.
 * @returns The audience, or `null` when the column is unset or unrecognized.
 */
export function parseClearance(value: unknown): Audience | null {
  return isAudience(value) ? value : null;
}

/**
 * Assembles the authorization subject for a request.
 *
 * This is the only place an {@link Actor} is built, which is what makes the authorization rules in
 * `../domain/actor.ts` trustworthy: every field they read comes from the verified Access identity
 * or from D1, and there is one function to audit rather than one per route.
 */
export class ActorResolver {
  /**
   * @param identities Identity record port.
   * @param products Product map port, used to evaluate scope at action time.
   */
  public constructor(
    private readonly identities: ActorIdentityRepository,
    private readonly products: ProductRepository
  ) {}

  /**
   * Resolve the verified email of the current request into an authorization subject.
   *
   * Product scope is read on every call rather than cached. An administrator can change the map
   * between two requests, and the second request has to use the new map — a cached scope would let
   * a PM keep acting on a product they no longer cover.
   *
   * @param email Verified Access email, supplied only by the Access middleware.
   * @param now Instant used to evaluate each product scope's effective window.
   * @returns The resolved actor. An unmapped identity resolves to a salesperson with the
   *   role-default clearance and no product scope, which is the least-privileged outcome.
   * @throws {Error} When either repository rejects its read.
   */
  public async resolve(email: string, now: Date): Promise<Actor> {
    const record = await this.identities.findByEmail(email);
    const identityKey = record?.identityKey ?? provisionalIdentityKey(email);
    const role: Role = record?.role ?? 'salesperson';
    const productScopes =
      role === 'pm' || role === 'overseer'
        ? await this.products.scopesFor(identityKey, now.toISOString())
        : [];

    return {
      identityKey,
      email,
      role,
      clearance: record?.audienceClearance ?? defaultClearanceForRole(role),
      productScopes
    };
  }
}
