/**
 * @file The Data Worker entrypoint and seed data, in the Workers runtime.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { compose } from '../../../src/data-worker/composition.ts';
import { dataLogger, envelope, toErrorValue } from '../../../src/data-worker/entrypoint.ts';
import { serviceError } from '../../../src/shared/common/errors.ts';
import { PERMISSIONS, ROLES, SEED_ROLE_PERMISSIONS } from '../../../src/shared/permissions.ts';
import { migrate } from '../support.ts';

beforeAll(async () => {
  await migrate();
});

describe('seeded RBAC', () => {
  it('matches the shared role matrix exactly', async () => {
    const rows = await env.DATA_DB.prepare(
      'SELECT role_id, permission FROM role_permissions ORDER BY role_id, permission'
    ).all<{
      role_id: string;
      permission: string;
    }>();
    for (const role of ROLES) {
      const stored = rows.results
        .filter((row) => row.role_id === role)
        .map((row) => row.permission)
        .sort();
      expect(stored, role).toEqual([...SEED_ROLE_PERMISSIONS[role]].sort());
    }
    expect(
      rows.results.every((row) => (PERMISSIONS as readonly string[]).includes(row.permission))
    ).toBe(true);
  });
});

describe('envelopes', () => {
  const logger = dataLogger('test');

  it('wraps successes and service errors as values', async () => {
    expect(await envelope(logger, 'crm.x', 'r1', () => Promise.resolve(42))).toEqual({
      ok: true,
      value: 42
    });
    const failed = await envelope(logger, 'crm.x', 'r1', () =>
      Promise.reject(serviceError('NOT_FOUND', 'Gone', { fields: { id: 'x' } }))
    );
    expect(failed).toEqual({
      ok: false,
      error: {
        name: 'ServiceError',
        code: 'NOT_FOUND',
        message: 'Gone',
        retryable: false,
        requestId: 'r1',
        fields: { id: 'x' }
      }
    });
  });

  it('turns an unexpected throw into a safe INTERNAL value', async () => {
    const failed = await envelope(logger, 'crm.x', undefined, () =>
      Promise.reject(new Error('SQLITE internal detail'))
    );
    expect(failed).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL', message: 'An unexpected error occurred.' }
    });
    expect(toErrorValue('not an error', 'crm.y', logger)).toMatchObject({ code: 'INTERNAL' });
  });
});

describe('health', () => {
  it('reports an unmigrated database as a dependency failure', async () => {
    const empty = compose({ DATA_DB: env.DATA_DB, ADMIN_EMAIL: 'x@example.com' });
    expect(await empty.health()).toMatchObject({ status: 'ok' });
    const saved = await env.DATA_DB.prepare('SELECT * FROM d1_migrations').all<{
      id: number;
      name: string;
      applied_at: string;
    }>();
    await env.DATA_DB.prepare('DELETE FROM d1_migrations').run();
    await expect(empty.health()).rejects.toMatchObject({ code: 'DEPENDENCY_FAILURE' });
    for (const row of saved.results) {
      await env.DATA_DB.prepare('INSERT INTO d1_migrations (id, name, applied_at) VALUES (?, ?, ?)')
        .bind(row.id, row.name, row.applied_at)
        .run();
    }
  });
});
