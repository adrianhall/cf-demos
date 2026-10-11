/**
 * @file Permissions module: actor resolution, the role matrix, and fail-closed behaviour.
 */

import { describe, expect, it } from 'vitest';
import {
  evaluate,
  displayNameFromEmail,
  initialRoleFor
} from '../../../src/data-worker/domain/permissions/policy.ts';
import { PERMISSIONS, ROLES, SEED_ROLE_PERMISSIONS } from '../../../src/shared/permissions.ts';
import { createFakeDataService } from '../../fakes/fake-data-service.ts';

/**
 * Capture a rejection's code.
 *
 * @param promise The operation.
 * @returns The code.
 */
async function codeOf(promise: Promise<unknown>): Promise<{ code: string; retryable: boolean }> {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; retryable: boolean };
  }
  throw new Error('expected failure');
}

describe('policy', () => {
  it('denies by default and explains why', () => {
    expect(evaluate(null, 'crm.read')).toEqual({ allowed: false, reason: 'inactive-user' });
    expect(
      evaluate({ status: 'suspended', roles: ['owner'], permissions: [...PERMISSIONS] }, 'crm.read')
        .reason
    ).toBe('inactive-user');
    expect(evaluate({ status: 'active', roles: [], permissions: [] }, 'crm.read').reason).toBe(
      'no-role'
    );
    expect(
      evaluate({ status: 'active', roles: ['read-only'], permissions: ['crm.read'] }, 'crm.write')
        .reason
    ).toBe('missing-permission');
    expect(
      evaluate({ status: 'active', roles: ['read-only'], permissions: ['crm.read'] }, 'crm.read')
        .allowed
    ).toBe(true);
  });

  it('derives display names and initial roles', () => {
    expect(displayNameFromEmail('jane.doe@example.com')).toBe('Jane Doe');
    expect(displayNameFromEmail('...@example.com')).toBe('...@example.com');
    expect(initialRoleFor('boss@example.com', ' Boss@Example.com ')).toBe('owner');
    expect(initialRoleFor('someone@example.com', 'boss@example.com')).toBe('read-only');
  });

  it('gives owners everything and read-only users only reads', () => {
    expect(SEED_ROLE_PERMISSIONS.owner).toEqual([...PERMISSIONS]);
    expect(
      SEED_ROLE_PERMISSIONS['read-only'].every((permission) => permission.endsWith('.read'))
    ).toBe(true);
    for (const role of ROLES) {
      expect(SEED_ROLE_PERMISSIONS[role]).toContain('crm.read');
    }
  });
});

describe('PermissionsService through the data service', () => {
  it('resolves, provisions, and reports sessions', async () => {
    const { service, store } = createFakeDataService({ adminEmail: 'boss@example.com' });
    const owner = await service.resolveActor('BOSS@example.com', 'r1');
    const session = await service.permissions.getSession({
      email: owner.email,
      userId: owner.userId,
      requestId: 'r1',
      channel: 'api'
    });
    expect(session.roles).toEqual([{ id: 'owner', label: 'Owner' }]);
    expect(store.audit.filter((event) => event.action === 'provisioned')).toHaveLength(1);
    // A second resolution does not provision again.
    await service.resolveActor('boss@example.com', 'r2');
    expect(store.count('users')).toBe(1);
  });

  it('refuses suspended users everywhere', async () => {
    const { service, store } = createFakeDataService();
    const id = store.addUser('gone@example.com', 'sales', 'suspended');
    expect((await codeOf(service.resolveActor('gone@example.com', 'r'))).code).toBe('FORBIDDEN');
    expect(
      (
        await codeOf(
          service.permissions.getSession({
            email: 'gone@example.com',
            userId: id,
            requestId: 'r',
            channel: 'api'
          })
        )
      ).code
    ).toBe('FORBIDDEN');
    expect(await service.resolveUser(id)).toMatchObject({ status: 'inactive' });
  });

  it('rejects malformed authorization requests and actors', async () => {
    const { service } = createFakeDataService();
    expect(
      (await codeOf(service.authorize({ userId: 'x', permission: 'made.up' as never }))).code
    ).toBe('VALIDATION_FAILED');
    expect(
      (
        await codeOf(
          service.permissions.getSession({
            email: 'a@b.c',
            userId: 'nope',
            requestId: 'r',
            channel: 'api'
          })
        )
      ).code
    ).toBe('VALIDATION_FAILED');
    expect((await codeOf(service.crm.dashboard(null as never))).code).toBe('VALIDATION_FAILED');
  });

  it('fails closed and retryable when storage is down', async () => {
    const { service, store } = createFakeDataService();
    const id = store.addUser('sales@example.com', 'sales');
    store.failing = true;
    const failure = await codeOf(
      service.crm.dashboard({
        email: 'sales@example.com',
        userId: id,
        requestId: 'r',
        channel: 'api'
      })
    );
    expect(failure).toMatchObject({ code: 'DEPENDENCY_FAILURE', retryable: true });
    expect((await codeOf(service.resolveActor('sales@example.com', 'r'))).code).toBe(
      'DEPENDENCY_FAILURE'
    );
    expect((await codeOf(service.authorize({ userId: id, permission: 'crm.read' }))).code).toBe(
      'DEPENDENCY_FAILURE'
    );
  });

  it('passes non-dependency service errors through unchanged', async () => {
    const { service, store } = createFakeDataService();
    // A user that vanishes between provisioning and lookup surfaces as FORBIDDEN, not a dependency failure.
    store.afterNextCommit((db) => {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec("DELETE FROM users WHERE email = 'ghost@example.com'");
      db.exec('PRAGMA foreign_keys = ON');
    });
    expect((await codeOf(service.resolveActor('ghost@example.com', 'r'))).code).toBe('FORBIDDEN');
  });
});
