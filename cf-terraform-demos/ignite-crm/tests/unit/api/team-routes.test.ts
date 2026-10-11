/**
 * @file Team and audit HTTP routes through the Hono app with real development-token Access
 *   verification, over the fake Data Worker: invite (201, Location, ETag), role and status changes
 *   with `If-Match`, the next request reflecting a role change, the directory, the role catalogue,
 *   the filtered audit trail, and the error mapping for 403/404/409/422/428, plus a wrong-audience
 *   token.
 */

import { describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';
import { createAccessMiddleware } from '@demos/worker-common';
import { buildAccessPolicies } from '../../../src/application-worker/api/access-policies.ts';
import { createApiApp } from '../../../src/application-worker/api/app.ts';
import type { ApiEnv } from '../../../src/application-worker/api/context.ts';
import { createFakeDataService, testRuntime } from '../../fakes/fake-data-service.ts';

/**
 * Accepted audience.
 */
const AUD = 'e'.repeat(64);

/**
 * Request origin.
 */
const ORIGIN = 'https://crm.example';

/**
 * Build the app over a fake with owner, manager, and sales users.
 *
 * @returns A request helper and user ids.
 */
function setup() {
  const { service, store } = createFakeDataService({
    runtime: testRuntime(new Date('2026-10-11T09:00:00.000Z'))
  });
  const ownerId = store.addUser('owner@example.com', 'owner');
  store.addUser('manager@example.com', 'manager');
  const salesId = store.addUser('sales@example.com', 'sales');
  const app = createApiApp({
    access: createAccessMiddleware<ApiEnv>({
      buildPolicies: buildAccessPolicies,
      enableDevTokens: true
    }),
    dataService: () => service,
    includeStack: false
  });
  const call = async (
    path: string,
    options: RequestInit & { as?: string; json?: unknown; audience?: string } = {}
  ): Promise<Response> => {
    const { as, json, audience, ...init } = options;
    const headers = new Headers(init.headers);
    if (as !== undefined) {
      headers.set(JWT_HEADER, await signDevJwt(as, { audience: audience ?? AUD }));
    }
    if (json !== undefined) {
      headers.set('Content-Type', 'application/json');
    }
    if ((init.method ?? 'GET') !== 'GET') {
      headers.set('Origin', ORIGIN);
    }
    return app.request(
      `${ORIGIN}${path}`,
      { ...init, headers, ...(json === undefined ? {} : { body: JSON.stringify(json) }) },
      { ACCESS_AUD: AUD, ENVIRONMENT: 'test' }
    );
  };
  return { call, ownerId, salesId };
}

/**
 * Read a JSON body.
 *
 * @param response The response.
 * @returns The body.
 */
async function body<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe('team routes', () => {
  it('invites (201 + Location + ETag) and lists the directory and role catalogue', async () => {
    const { call } = setup();
    const invited = await call('/api/v1/users', {
      as: 'owner@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-invite-1' },
      json: { email: 'Pat@Example.com', displayName: 'Pat', roles: ['delivery'] }
    });
    expect(invited.status).toBe(201);
    const member = await body<{ id: string; email: string }>(invited);
    expect(member.email).toBe('pat@example.com');
    expect(invited.headers.get('Location')).toBe(`/api/v1/users/${member.id}`);
    expect(invited.headers.get('ETag')).toBe('"1"');

    const team = await body<{ items: { email: string }[] }>(
      await call('/api/v1/users?q=pat', { as: 'manager@example.com' })
    );
    expect(team.items.map((item) => item.email)).toEqual(['pat@example.com']);
    const roles = await body<{ id: string }[]>(
      await call('/api/v1/roles', { as: 'owner@example.com' })
    );
    expect(roles.map((role) => role.id)).toEqual([
      'owner',
      'manager',
      'sales',
      'delivery',
      'read-only'
    ]);
  });

  it('changes a role with If-Match, and the very next request reflects it', async () => {
    const { call, salesId } = setup();
    expect((await call('/api/v1/audit', { as: 'sales@example.com' })).status).toBe(403);
    const changed = await call(`/api/v1/users/${salesId}/roles`, {
      as: 'owner@example.com',
      method: 'PUT',
      headers: { 'Idempotency-Key': 'http-roles-1', 'If-Match': '"1"' },
      json: { roles: ['sales', 'manager'] }
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('ETag')).toBe('"2"');
    const session = await body<{ permissions: string[] }>(
      await call('/api/v1/session', { as: 'sales@example.com' })
    );
    expect(session.permissions).toContain('audit.read');
    const audit = await call('/api/v1/audit?module=permissions&entityType=user', {
      as: 'sales@example.com'
    });
    expect(audit.status).toBe(200);
    expect(
      (await body<{ items: { action: string }[] }>(audit)).items.map((item) => item.action)
    ).toEqual(['roles-changed']);

    const stale = await call(`/api/v1/users/${salesId}/roles`, {
      as: 'owner@example.com',
      method: 'PUT',
      headers: { 'Idempotency-Key': 'http-roles-2', 'If-Match': '"1"' },
      json: { roles: ['sales'] }
    });
    expect(stale.status).toBe(409);
    expect((await body(stale)).code).toBe('VERSION_MISMATCH');
  });

  it('suspends a teammate, after which their next request is refused', async () => {
    const { call, salesId } = setup();
    const suspended = await call(`/api/v1/users/${salesId}/status`, {
      as: 'owner@example.com',
      method: 'PUT',
      headers: { 'Idempotency-Key': 'http-status-1', 'If-Match': '"1"' },
      json: { status: 'suspended' }
    });
    expect(suspended.status).toBe(200);
    expect((await call('/api/v1/session', { as: 'sales@example.com' })).status).toBe(403);
  });

  it('maps denials, absence, the final-owner rule, validation, and missing preconditions', async () => {
    const { call, ownerId, salesId } = setup();
    const managerInvite = await call('/api/v1/users', {
      as: 'manager@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-invite-2' },
      json: { email: 'x@example.com', displayName: 'X', roles: ['sales'] }
    });
    expect(managerInvite.status).toBe(403);
    expect((await call('/api/v1/users', { as: 'sales@example.com' })).status).toBe(403);

    const lastOwner = await call(`/api/v1/users/${ownerId}/roles`, {
      as: 'owner@example.com',
      method: 'PUT',
      headers: { 'Idempotency-Key': 'http-roles-3', 'If-Match': '"1"' },
      json: { roles: ['manager'] }
    });
    expect(lastOwner.status).toBe(409);
    expect((await body(lastOwner)).code).toBe('CONFLICT');

    const duplicate = await call('/api/v1/users', {
      as: 'owner@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-invite-3' },
      json: { email: 'sales@example.com', displayName: 'Dup', roles: ['sales'] }
    });
    expect(duplicate.status).toBe(409);
    expect((await body<{ fields: Record<string, string> }>(duplicate)).fields).toHaveProperty(
      'email'
    );

    const invalid = await call('/api/v1/users', {
      as: 'owner@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-invite-4' },
      json: { email: 'y@example.com', displayName: 'Y', roles: ['superuser'] }
    });
    expect(invalid.status).toBe(422);

    const noIfMatch = await call(`/api/v1/users/${salesId}/roles`, {
      as: 'owner@example.com',
      method: 'PUT',
      headers: { 'Idempotency-Key': 'http-roles-4' },
      json: { roles: ['sales'] }
    });
    expect(noIfMatch.status).toBe(428);
    const missing = await call('/api/v1/users/00000000-0000-4000-8000-00000000ffff/status', {
      as: 'owner@example.com',
      method: 'PUT',
      headers: { 'Idempotency-Key': 'http-status-2', 'If-Match': '"1"' },
      json: { status: 'suspended' }
    });
    expect(missing.status).toBe(404);
    expect(
      (await call('/api/v1/audit?entityType=secrets', { as: 'owner@example.com' })).status
    ).toBe(422);
    // A malformed path id is reported before any header precondition.
    expect(
      (await call('/api/v1/users/not-an-id/roles', { as: 'owner@example.com', method: 'PUT' }))
        .status
    ).toBe(422);
  });

  it('rejects a token for a different Access application before reaching the team', async () => {
    const { call } = setup();
    const response = await call('/api/v1/users', {
      as: 'owner@example.com',
      audience: 'f'.repeat(64)
    });
    expect(response.status).toBe(401);
  });
});
