/**
 * @file Application Worker HTTP behaviour through the Hono app, over the fake Data Worker. Uses the
 *   real shared Access middleware with development tokens enabled — the same verifier the local dev
 *   server uses — so authentication outcomes here are real, not stubbed.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';
import { createAccessMiddleware } from '@demos/worker-common';
import { buildAccessPolicies } from '../../../src/application-worker/api/access-policies.ts';
import { createApiApp } from '../../../src/application-worker/api/app.ts';
import type { ApiEnv } from '../../../src/application-worker/api/context.ts';
import { withoutIdentityHeaders } from '../../../src/application-worker/api/middleware/protections.ts';
import { sameOrigin } from '../../../src/application-worker/api/middleware/protections.ts';
import { mapServiceError } from '../../../src/application-worker/api/problems.ts';
import { createDataClient, type DataRpc } from '../../../src/application-worker/data-client.ts';
import { serviceError } from '../../../src/shared/common/errors.ts';
import type { DataService } from '../../../src/shared/data-service/contract.ts';
import { createFakeDataService, type FakeStore } from '../../fakes/fake-data-service.ts';

/**
 * Accepted audience.
 */
const AUD = 'c'.repeat(64);

/**
 * Request origin.
 */
const ORIGIN = 'https://crm.example';

/**
 * Build the app over a data service.
 *
 * @param data The data service.
 * @returns A request helper.
 */
function harness(data: DataService) {
  const app = createApiApp({
    access: createAccessMiddleware<ApiEnv>({
      buildPolicies: buildAccessPolicies,
      enableDevTokens: true
    }),
    dataService: () => data,
    includeStack: false
  });
  return async (
    path: string,
    options: RequestInit & { as?: string; audience?: string; json?: unknown } = {}
  ): Promise<Response> => {
    const { as, audience, json, ...init } = options;
    const headers = new Headers(init.headers);
    if (as !== undefined) {
      headers.set(JWT_HEADER, await signDevJwt(as, { audience: audience ?? AUD }));
    }
    if (json !== undefined) {
      headers.set('Content-Type', 'application/json');
    }
    if ((init.method ?? 'GET') !== 'GET' && !headers.has('Origin')) {
      headers.set('Origin', ORIGIN);
    }
    return app.request(
      `${ORIGIN}${path}`,
      { ...init, headers, ...(json === undefined ? {} : { body: JSON.stringify(json) }) },
      { ACCESS_AUD: AUD, ENVIRONMENT: 'test' }
    );
  };
}

/**
 * Fake-backed app with seeded users.
 *
 * @returns The request helper and store.
 */
function setup(): { call: ReturnType<typeof harness>; store: FakeStore } {
  const { service, store } = createFakeDataService();
  store.addUser('sales@example.com', 'sales');
  store.addUser('reader@example.com', 'read-only');
  return { call: harness(service), store };
}

describe('authentication', () => {
  it('returns the verified identity from /api/me', async () => {
    const { call } = setup();
    const response = await call('/api/me', { as: 'sales@example.com' });
    expect(await response.json()).toEqual({ email: 'sales@example.com' });
    expect(response.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('answers 401 problem details for missing and wrong-audience tokens', async () => {
    const { call } = setup();
    for (const response of [
      await call('/api/v1/session'),
      await call('/api/v1/session', { as: 'sales@example.com', audience: 'd'.repeat(64) })
    ]) {
      expect(response.status).toBe(401);
      expect(response.headers.get('Content-Type')).toContain('application/problem+json');
    }
  });

  it('ignores a smuggled identity header (any casing)', async () => {
    const { call } = setup();
    const response = await call('/api/me', {
      as: 'reader@example.com',
      headers: {
        'cf-access-authenticated-user-email': 'sales@example.com',
        'CF-ACCESS-AUTHENTICATED-USER-EMAIL': 'owner@example.com'
      }
    });
    expect(await response.json()).toEqual({ email: 'reader@example.com' });
  });

  it('scrubs identity headers in one named function, case-insensitively, keeping the rest', () => {
    const clean = withoutIdentityHeaders(
      new Headers({
        'CF-ACCESS-AUTHENTICATED-USER-EMAIL': 'owner@example.com',
        'cf-access-authenticated-user-id': 'x',
        'X-Authenticated-User-Email': 'y',
        [JWT_HEADER]: 'token',
        'Content-Type': 'application/json'
      })
    );
    expect([...clean.keys()].sort()).toEqual(['content-type', JWT_HEADER.toLowerCase()].sort());
  });

  it('ignores a client-supplied request id', async () => {
    const { call } = setup();
    const response = await call('/api/me', {
      as: 'reader@example.com',
      headers: { 'X-Request-Id': 'forged' }
    });
    expect(response.headers.get('X-Request-Id')).not.toBe('forged');
  });
});

describe('session, health, configuration', () => {
  it('returns role summaries and capability hints', async () => {
    const { call } = setup();
    const session = (await (
      await call('/api/v1/session', { as: 'reader@example.com' })
    ).json()) as { roles: unknown; permissions: string[] };
    expect(session.roles).toEqual([{ id: 'read-only', label: 'Read-only' }]);
    expect(session.permissions).toContain('crm.read');
  });

  it('sets strict security headers on success and error responses', async () => {
    const { call } = setup();
    for (const response of [
      await call('/api/v1/configuration', { as: 'sales@example.com' }),
      await call('/api/v1/nope', { as: 'sales@example.com' }),
      await call('/api/v1/session')
    ]) {
      expect(response.headers.get('Content-Security-Policy')).toBe(
        "default-src 'none'; frame-ancestors 'none'"
      );
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('serves health and configuration', async () => {
    const { call } = setup();
    expect(await (await call('/api/v1/health', { as: 'reader@example.com' })).json()).toEqual({
      status: 'ok',
      data: { status: 'ok', migration: '0007_quarterly_pipeline.sql' }
    });
    expect(
      await (await call('/api/v1/configuration', { as: 'reader@example.com' })).json()
    ).toMatchObject({ currencySymbol: '£' });
  });

  it('returns 404 problem details for unknown API paths, including the reserved /mcp', async () => {
    const { call } = setup();
    expect((await call('/api/v1/nowhere', { as: 'reader@example.com' })).status).toBe(404);
  });
});

describe('contacts and companies', () => {
  it('creates a contact (201, Location, ETag) and reads it back', async () => {
    const { call } = setup();
    const created = await call('/api/v1/contacts', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-create-1' },
      json: { firstName: 'Ada', companyName: 'Engines' }
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('ETag')).toBe('"1"');
    const contact = (await created.json()) as { id: string; company: { id: string } };
    expect(
      (await call(`/api/v1/contacts/${contact.id}`, { as: 'reader@example.com' })).status
    ).toBe(200);
    const company = await call(`/api/v1/companies/${contact.company.id}`, {
      as: 'reader@example.com'
    });
    expect(company.headers.get('ETag')).toBe('"1"');
    const list = (await (
      await call('/api/v1/contacts?q=ada&limit=5', { as: 'reader@example.com' })
    ).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(1);
    const companies = (await (
      await call('/api/v1/companies', { as: 'reader@example.com' })
    ).json()) as { items: unknown[] };
    expect(companies.items).toHaveLength(1);
    const dashboard = (await (
      await call('/api/v1/dashboard', { as: 'reader@example.com' })
    ).json()) as { contacts: number };
    expect(dashboard.contacts).toBe(1);
  });

  it('creates and updates a company with If-Match', async () => {
    const { call } = setup();
    const created = (await (
      await call('/api/v1/companies', {
        as: 'sales@example.com',
        method: 'POST',
        headers: { 'Idempotency-Key': 'http-company-1' },
        json: { name: 'Acme' }
      })
    ).json()) as { id: string };
    const updated = await call(`/api/v1/companies/${created.id}`, {
      as: 'sales@example.com',
      method: 'PATCH',
      headers: { 'Idempotency-Key': 'http-company-2', 'If-Match': 'W/"1"' },
      json: { address: 'Here' }
    });
    expect(updated.status).toBe(200);
    expect(updated.headers.get('ETag')).toBe('"2"');
    const stale = await call(`/api/v1/companies/${created.id}`, {
      as: 'sales@example.com',
      method: 'PATCH',
      headers: { 'Idempotency-Key': 'http-company-3', 'If-Match': '"1"' },
      json: { address: 'There' }
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'VERSION_MISMATCH' });
  });

  it('updates a contact with If-Match, refusing a read-only user and a stale version', async () => {
    const { call } = setup();
    const created = (await (
      await call('/api/v1/contacts', {
        as: 'sales@example.com',
        method: 'POST',
        headers: { 'Idempotency-Key': 'http-contact-e1' },
        json: { firstName: 'Ada' }
      })
    ).json()) as { id: string };
    const updated = await call(`/api/v1/contacts/${created.id}`, {
      as: 'sales@example.com',
      method: 'PATCH',
      headers: { 'Idempotency-Key': 'http-contact-e2', 'If-Match': '"1"' },
      json: { lastName: 'Lovelace' }
    });
    expect(updated.status).toBe(200);
    expect(updated.headers.get('ETag')).toBe('"2"');
    expect(await updated.json()).toMatchObject({ displayName: 'Ada Lovelace' });
    const stale = await call(`/api/v1/contacts/${created.id}`, {
      as: 'sales@example.com',
      method: 'PATCH',
      headers: { 'Idempotency-Key': 'http-contact-e3', 'If-Match': '"1"' },
      json: { phone: '020 7946 0000' }
    });
    expect(stale.status).toBe(409);
    const forbidden = await call(`/api/v1/contacts/${created.id}`, {
      as: 'reader@example.com',
      method: 'PATCH',
      headers: { 'Idempotency-Key': 'http-contact-e4', 'If-Match': '"2"' },
      json: { phone: '1' }
    });
    expect(forbidden.status).toBe(403);
    const invalid = await call(`/api/v1/contacts/${created.id}`, {
      as: 'sales@example.com',
      method: 'PATCH',
      headers: { 'Idempotency-Key': 'http-contact-e5', 'If-Match': '"2"' },
      json: { email: 'ahall@cloudflarecom', ownerId: crypto.randomUUID() }
    });
    expect(invalid.status).toBe(422);
  });

  it('requires Idempotency-Key (428) and If-Match (428), and validates both (422)', async () => {
    const { call } = setup();
    expect(
      (
        await call('/api/v1/contacts', {
          as: 'sales@example.com',
          method: 'POST',
          json: { firstName: 'A' }
        })
      ).status
    ).toBe(428);
    expect(
      (
        await call('/api/v1/contacts', {
          as: 'sales@example.com',
          method: 'POST',
          headers: { 'Idempotency-Key': 'bad key!' },
          json: { firstName: 'A' }
        })
      ).status
    ).toBe(422);
    const id = crypto.randomUUID();
    expect(
      (
        await call(`/api/v1/companies/${id}`, {
          as: 'sales@example.com',
          method: 'PATCH',
          headers: { 'Idempotency-Key': 'patch-key-1' },
          json: { address: 'x' }
        })
      ).status
    ).toBe(428);
    const badIfMatch = await call(`/api/v1/companies/${id}`, {
      as: 'sales@example.com',
      method: 'PATCH',
      headers: { 'Idempotency-Key': 'patch-key-1', 'If-Match': 'v1' },
      json: { address: 'x' }
    });
    expect(badIfMatch.status).toBe(422);
    // Header problems name the header, not the query string.
    expect(await badIfMatch.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      detail: 'The If-Match header is invalid.',
      fields: { 'If-Match': 'If-Match must be a version ETag such as "3".' }
    });
    const badKey = await call('/api/v1/contacts', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'bad key!' },
      json: { firstName: 'A' }
    });
    expect(await badKey.json()).toMatchObject({
      detail: 'The Idempotency-Key header is invalid.',
      fields: { 'Idempotency-Key': 'Idempotency-Key contains unsupported characters.' }
    });
  });

  it('maps validation failures to 422 with field messages', async () => {
    const { call } = setup();
    const response = await call('/api/v1/contacts', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-invalid-1' },
      json: { email: 'nope' }
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { code: string; fields: Record<string, string> };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(body.fields)).toEqual(expect.arrayContaining(['email']));
    expect((await call('/api/v1/contacts/NOT-A-UUID', { as: 'sales@example.com' })).status).toBe(
      422
    );
    expect((await call('/api/v1/contacts?limit=0', { as: 'sales@example.com' })).status).toBe(422);
  });

  it('rejects malformed JSON, oversized bodies, and non-JSON bodies', async () => {
    const { call } = setup();
    const base = {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-body-1', 'Content-Type': 'application/json' }
    };
    expect((await call('/api/v1/contacts', { ...base, body: '{nope' })).status).toBe(400);
    expect(
      (
        await call('/api/v1/contacts', {
          ...base,
          body: JSON.stringify({ firstName: 'x'.repeat(9000) })
        })
      ).status
    ).toBe(400);
    expect(
      (
        await call('/api/v1/contacts', {
          ...base,
          headers: { 'Idempotency-Key': 'http-body-1', 'Content-Type': 'text/plain' },
          body: '{}'
        })
      ).status
    ).toBe(415);
  });

  it('rejects cross-site mutations', async () => {
    const { call } = setup();
    const evil = await call('/api/v1/contacts', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-csrf-1', 'Origin': 'https://evil.example' },
      json: { firstName: 'A' }
    });
    expect(evil.status).toBe(403);
    const fetchSite = await call('/api/v1/contacts', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-csrf-2', 'Sec-Fetch-Site': 'cross-site' },
      json: { firstName: 'A' }
    });
    expect(fetchSite.status).toBe(403);
  });

  it('fails closed when both Origin and Sec-Fetch-Site are absent', async () => {
    const app = new Hono<ApiEnv>();
    app.use(sameOrigin());
    app.post('/mutation', (context) => context.json({ ok: true }));
    // The protection does not depend on Access; it refuses the shape before any handler.
    const response = await app.request(
      'https://crm.example/mutation',
      { method: 'POST' },
      { ACCESS_AUD: AUD }
    );
    expect(response.status).toBe(403);
  });

  it('turns a Data Worker denial into 403 and a missing record into 404', async () => {
    const { call } = setup();
    const denied = await call('/api/v1/companies', {
      as: 'reader@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-deny-1' },
      json: { name: 'No' }
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'FORBIDDEN', retryable: false });
    expect(
      (await call(`/api/v1/companies/${crypto.randomUUID()}`, { as: 'reader@example.com' })).status
    ).toBe(404);
  });
});

describe('Data Worker failures', () => {
  it('reports an answered dependency failure as retryable 503', async () => {
    const { call, store } = setup();
    store.failing = true;
    const response = await call('/api/v1/dashboard', { as: 'sales@example.com' });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'DEPENDENCY_FAILURE', retryable: true });
  });

  it('reports an unreachable Data Worker as 503 without leaking the transport error', async () => {
    const errors: unknown[] = [];
    const broken: DataRpc = new Proxy({} as DataRpc, {
      get: () => () => Promise.reject(new Error('internal socket detail'))
    });
    const call = harness(
      createDataClient(broken, { onTransportError: (error) => errors.push(error) })
    );
    const response = await call('/api/v1/session', { as: 'sales@example.com' });
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('socket');
    expect(errors).toHaveLength(1);
  });

  it('times out a hung Data Worker call', async () => {
    const hung: DataRpc = new Proxy({} as DataRpc, {
      get: () => () => new Promise(() => undefined)
    });
    const call = harness(createDataClient(hung, { timeoutMs: 5 }));
    expect((await call('/api/v1/health', { as: 'sales@example.com' })).status).toBe(503);
  });

  it('hides INTERNAL details and leaves non-service errors to the default handler', () => {
    expect(mapServiceError(serviceError('INTERNAL', 'secret detail'))).toMatchObject({
      status: 500,
      detail: 'An unexpected error occurred.'
    });
    expect(mapServiceError(new Error('plain'))).toBeUndefined();
  });

  it('reports a response that breaks the shared schema as 500', async () => {
    const { service } = createFakeDataService();
    const broken: DataService = {
      ...service,
      health: () => Promise.resolve({ status: 'ok', migration: 42 as unknown as string })
    };
    const response = await harness(broken)('/api/v1/health', { as: 'sales@example.com' });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('migration');
  });
});
