/**
 * @file Team administration against real D1 in workerd. Calls the production repository directly,
 *   skipping the service's friendly early check, to prove that the commit-time final-owner guard on
 *   D1 itself rolls back a write set that would leave no active owner — including its audit and
 *   idempotency rows.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { D1Adapter } from '../../../src/data-worker/infrastructure/d1/d1-port.ts';
import { D1TeamRepository } from '../../../src/data-worker/infrastructure/repositories/team-repository.ts';
import { migrate, seedUser } from '../support.ts';

let ownerId: string;

beforeAll(async () => {
  await migrate();
  ownerId = await seedUser('team-owner@example.com', 'owner');
});

/**
 * An envelope whose audit and idempotency rows can be counted afterwards.
 *
 * @param key Idempotency key.
 * @returns The envelope.
 */
function envelopeFor(key: string) {
  const at = new Date().toISOString();
  return {
    audit: [
      {
        id: crypto.randomUUID(),
        module: 'permissions' as const,
        entityType: 'user',
        entityId: ownerId,
        action: 'roles-changed',
        actorId: ownerId,
        channel: 'api' as const,
        requestId: 'it-team',
        metadata: { rolesAfter: 'manager' },
        occurredAt: at
      }
    ],
    idempotency: {
      actorId: ownerId,
      operation: 'permissions.setUserRoles',
      key,
      requestHash: 'h',
      resultJson: '{}',
      createdAt: at
    },
    purgeBefore: '2000-01-01T00:00:00.000Z'
  };
}

describe('final-owner guard on real D1', () => {
  it('rolls back a demotion of the only active owner, writing nothing', async () => {
    const repository = new D1TeamRepository(new D1Adapter(env.DATA_DB));
    const failure = await repository
      .updateMember({
        userId: ownerId,
        expectedVersion: 1,
        roles: ['manager'],
        status: null,
        grantedBy: ownerId,
        at: new Date().toISOString(),
        envelope: envelopeFor('it-team-last-owner')
      })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'CONFLICT' });
    const roles = await env.DATA_DB.prepare('SELECT role_id FROM user_roles WHERE user_id = ?')
      .bind(ownerId)
      .all<{ role_id: string }>();
    expect(roles.results.map((row) => row.role_id)).toEqual(['owner']);
    const version = await env.DATA_DB.prepare('SELECT version FROM users WHERE id = ?')
      .bind(ownerId)
      .first<{ version: number }>();
    expect(version?.version).toBe(1);
    const idempotency = await env.DATA_DB.prepare(
      "SELECT count(*) AS n FROM idempotency_records WHERE idempotency_key = 'it-team-last-owner'"
    ).first<{ n: number }>();
    expect(idempotency?.n).toBe(0);
  });

  it('allows the same demotion once a second active owner exists', async () => {
    await seedUser('team-owner-2@example.com', 'owner');
    const repository = new D1TeamRepository(new D1Adapter(env.DATA_DB));
    await repository.updateMember({
      userId: ownerId,
      expectedVersion: 1,
      roles: ['manager'],
      status: null,
      grantedBy: ownerId,
      at: new Date().toISOString(),
      envelope: envelopeFor('it-team-second-owner')
    });
    const roles = await env.DATA_DB.prepare('SELECT role_id FROM user_roles WHERE user_id = ?')
      .bind(ownerId)
      .all<{ role_id: string }>();
    expect(roles.results.map((row) => row.role_id)).toEqual(['manager']);
  });
});
