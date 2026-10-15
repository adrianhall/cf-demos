import { describe, expect, it } from 'vitest';
import {
  IdentityService,
  type IdentityRepository
} from '../../src/worker/application/identity-service';
import { canManage, type Role } from '../../src/worker/domain/role';

class MemoryIdentities implements IdentityRepository {
  public constructor(private readonly role: Role) {}
  public async findRole(): Promise<Role> {
    return this.role;
  }
}

describe('IdentityService', () => {
  it('uses the repository role for a verified identity', async () => {
    await expect(
      new IdentityService(new MemoryIdentities('pm')).getMe('pm@example.com')
    ).resolves.toEqual({ email: 'pm@example.com', role: 'pm' });
  });
  it.each<Role>(['pm', 'overseer', 'administrator'])('permits %s management navigation', (role) =>
    expect(canManage(role)).toBe(true)
  );
  it('does not permit salesperson management navigation', () =>
    expect(canManage('salesperson')).toBe(false));
});
