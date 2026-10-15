import { describe, expect, it } from 'vitest';
import {
  ActorResolver,
  parseClearance,
  provisionalIdentityKey,
  type ActorIdentityRepository
} from '../../../src/worker/application/actor-resolver';
import type { IdentityRecord } from '../../../src/worker/application/actor-resolver';
import { MemoryProductRepository } from '../support/fake-repositories';

/**
 * Memory identity port keyed by email.
 */
class MemoryIdentities implements ActorIdentityRepository {
  /**
   * @param records Records keyed by verified email.
   */
  public constructor(private readonly records: Record<string, IdentityRecord> = {}) {}

  /**
   * Find one record.
   *
   * @param email Verified Access email.
   * @returns The stored record, or `null`.
   */
  public findByEmail(email: string): Promise<IdentityRecord | null> {
    return Promise.resolve(this.records[email] ?? null);
  }
}

describe('ActorResolver', () => {
  it('turns an unmapped verified identity into the least-privileged actor', async () => {
    const resolver = new ActorResolver(new MemoryIdentities(), new MemoryProductRepository());
    await expect(
      resolver.resolve('New@Example.com', new Date('2026-10-15'))
    ).resolves.toMatchObject({
      identityKey: 'web:new@example.com',
      role: 'salesperson',
      clearance: 'customer',
      productScopes: []
    });
  });

  it('reads PM scope at action time', async () => {
    const resolver = new ActorResolver(
      new MemoryIdentities({
        'pm@example.com': { identityKey: 'pm-key', role: 'pm', audienceClearance: null }
      }),
      new MemoryProductRepository([], { 'pm-key': ['d1', 'kv'] })
    );
    await expect(resolver.resolve('pm@example.com', new Date())).resolves.toMatchObject({
      role: 'pm',
      clearance: 'internal',
      productScopes: ['d1', 'kv']
    });
  });

  it('honors an explicit narrower clearance for a PM', async () => {
    const resolver = new ActorResolver(
      new MemoryIdentities({
        'pm@example.com': { identityKey: 'pm-key', role: 'pm', audienceClearance: 'nda' }
      }),
      new MemoryProductRepository()
    );
    await expect(resolver.resolve('pm@example.com', new Date())).resolves.toMatchObject({
      clearance: 'nda'
    });
  });

  it('derives a stable provisional key from a case-insensitive email', () =>
    expect(provisionalIdentityKey('SAM@Example.COM')).toBe('web:sam@example.com'));

  it.each([
    ['public', 'public'],
    ['customer', 'customer'],
    ['nda', 'nda'],
    ['internal', 'internal'],
    ['unexpected', null],
    [null, null]
  ])('parses %p clearance as %p', (value, expected) =>
    expect(parseClearance(value)).toBe(expected)
  );
});
