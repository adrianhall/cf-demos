import type { Actor } from '../../../src/worker/domain/actor';
import type { Audience } from '../../../src/worker/domain/audience';
import type { Role } from '../../../src/worker/domain/role';

/**
 * Build an {@link Actor} for a test, filling in sensible defaults.
 *
 * Tests construct actors directly rather than going through the resolver because the rules under
 * test are about what an actor may do, not about how one is assembled. The resolver has its own
 * tests, which is where "the request cannot influence the actor" is proven.
 *
 * @param role Role the actor holds.
 * @param overrides Fields to change from the defaults.
 * @returns A complete actor.
 */
export function actorOf(role: Role, overrides: Partial<Actor> = {}): Actor {
  const clearance: Audience = role === 'salesperson' ? 'customer' : 'internal';
  return {
    identityKey: `${role}-key`,
    email: `${role}@example.com`,
    role,
    clearance,
    productScopes: [],
    ...overrides
  };
}
