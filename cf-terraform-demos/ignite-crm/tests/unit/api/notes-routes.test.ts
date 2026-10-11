/**
 * @file Notes HTTP routes through the Hono app with real development-token Access verification,
 *   over the fake Data Worker: create (201, Location, ETag; 428 without a key), read, the
 *   linked-record feed, POST search (no query string), update with `If-Match`, and the error
 *   mapping for validation (422), authorization (403), absence (404), version conflicts (409), and
 *   oversized bodies (400).
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
const AUD = 'd'.repeat(64);

/**
 * Request origin.
 */
const ORIGIN = 'https://crm.example';

/**
 * Build the app over a fake with sales, delivery, and read-only users and one contact.
 *
 * @returns A request helper and the contact id.
 */
async function setup() {
  const { service, store } = createFakeDataService({
    runtime: testRuntime(new Date('2026-10-11T09:00:00.000Z'))
  });
  const salesId = store.addUser('sales@example.com', 'sales');
  store.addUser('delivery@example.com', 'delivery');
  store.addUser('reader@example.com', 'read-only');
  const contact = await service.crm.createContact(
    { email: 'sales@example.com', userId: salesId, requestId: 'seed', channel: 'api' },
    {
      firstName: 'Ada',
      lastName: null,
      email: null,
      phone: null,
      jobTitle: null,
      companyId: null,
      companyName: 'Engines'
    },
    { idempotencyKey: 'seed-contact' }
  );
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
    options: RequestInit & { as?: string; json?: unknown; raw?: string } = {}
  ): Promise<Response> => {
    const { as, json, raw, ...init } = options;
    const headers = new Headers(init.headers);
    if (as !== undefined) {
      headers.set(JWT_HEADER, await signDevJwt(as, { audience: AUD }));
    }
    if (json !== undefined || raw !== undefined) {
      headers.set('Content-Type', 'application/json');
    }
    if ((init.method ?? 'GET') !== 'GET') {
      headers.set('Origin', ORIGIN);
    }
    const payload = raw ?? (json === undefined ? undefined : JSON.stringify(json));
    return app.request(
      `${ORIGIN}${path}`,
      { ...init, headers, ...(payload === undefined ? {} : { body: payload }) },
      { ACCESS_AUD: AUD, ENVIRONMENT: 'test' }
    );
  };
  return { call, contactId: contact.id, companyId: contact.company!.id };
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

describe('notes routes', () => {
  it('creates (201 + Location + ETag), reads, lists by link, searches, and updates', async () => {
    const { call, contactId, companyId } = await setup();
    const created = await call('/api/v1/notes', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-note-1' },
      json: {
        title: 'Discovery call',
        markdown: 'Talked about **renewal** terms.',
        links: [
          { type: 'contact', id: contactId },
          { type: 'company', id: companyId }
        ]
      }
    });
    expect(created.status).toBe(201);
    const note = await body<{ id: string; version: number }>(created);
    expect(created.headers.get('Location')).toBe(`/api/v1/notes/${note.id}`);
    expect(created.headers.get('ETag')).toBe('"1"');

    const read = await call(`/api/v1/notes/${note.id}`, { as: 'reader@example.com' });
    expect(read.status).toBe(200);
    expect(read.headers.get('ETag')).toBe('"1"');

    const feed = await body<{ items: { id: string }[] }>(
      await call(`/api/v1/notes?linkType=company&linkId=${companyId}`, { as: 'reader@example.com' })
    );
    expect(feed.items.map((item) => item.id)).toEqual([note.id]);

    const search = await call('/api/v1/notes/search', {
      as: 'reader@example.com',
      method: 'POST',
      json: { q: 'renew' }
    });
    expect(search.status).toBe(200);
    expect((await body<{ items: unknown[] }>(search)).items).toHaveLength(1);

    const updated = await call(`/api/v1/notes/${note.id}`, {
      as: 'sales@example.com',
      method: 'PATCH',
      headers: { 'Idempotency-Key': 'http-note-2', 'If-Match': '"1"' },
      json: { title: 'Discovery call (follow-up)' }
    });
    expect(updated.status).toBe(200);
    expect(updated.headers.get('ETag')).toBe('"2"');

    const stale = await call(`/api/v1/notes/${note.id}`, {
      as: 'sales@example.com',
      method: 'PATCH',
      headers: { 'Idempotency-Key': 'http-note-3', 'If-Match': '"1"' },
      json: { title: 'Stale' }
    });
    expect(stale.status).toBe(409);
    expect((await body(stale)).code).toBe('VERSION_MISMATCH');
  });

  it('maps validation, authorization, absence, and missing preconditions', async () => {
    const { call, contactId } = await setup();
    const noLinks = await call('/api/v1/notes', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-note-4' },
      json: { title: 'T', markdown: 'B', links: [] }
    });
    expect(noLinks.status).toBe(422);
    expect((await body<{ fields: Record<string, string> }>(noLinks)).fields).toHaveProperty(
      'links'
    );

    const missingTarget = await call('/api/v1/notes', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-note-5' },
      json: {
        title: 'T',
        markdown: 'B',
        links: [{ type: 'deal', id: '00000000-0000-4000-8000-00000000ffff' }]
      }
    });
    expect(missingTarget.status).toBe(422);
    expect((await body<{ fields: Record<string, string> }>(missingTarget)).fields).toEqual({
      'links.0': 'This record does not exist or is no longer available.'
    });

    const forbidden = await call('/api/v1/notes', {
      as: 'reader@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-note-6' },
      json: { title: 'T', markdown: 'B', links: [{ type: 'contact', id: contactId }] }
    });
    expect(forbidden.status).toBe(403);

    const noKey = await call('/api/v1/notes', {
      as: 'sales@example.com',
      method: 'POST',
      json: { title: 'T', markdown: 'B', links: [{ type: 'contact', id: contactId }] }
    });
    expect(noKey.status).toBe(428);

    expect(
      (
        await call('/api/v1/notes/00000000-0000-4000-8000-00000000ffff', {
          as: 'reader@example.com'
        })
      ).status
    ).toBe(404);
    expect((await call('/api/v1/notes/not-an-id', { as: 'reader@example.com' })).status).toBe(422);
    expect(
      (await call(`/api/v1/notes?linkType=contact`, { as: 'reader@example.com' })).status
    ).toBe(422);
    const shortSearch = await call('/api/v1/notes/search', {
      as: 'reader@example.com',
      method: 'POST',
      json: { q: 'a' }
    });
    expect(shortSearch.status).toBe(422);
    expect(
      (await call('/api/v1/notes/search?q=pricing', { as: 'reader@example.com' })).status
    ).toBe(422);
  });

  it('accepts a 64 KiB note body but refuses a request body past the transport limit', async () => {
    const { call, contactId } = await setup();
    const atLimit = await call('/api/v1/notes', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-note-7' },
      json: {
        title: 'Big',
        markdown: 'x'.repeat(64 * 1024),
        links: [{ type: 'contact', id: contactId }]
      }
    });
    expect(atLimit.status).toBe(201);
    const tooLarge = await call('/api/v1/notes', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-note-8' },
      raw: JSON.stringify({ title: 'Huge', markdown: 'x'.repeat(600 * 1024), links: [] })
    });
    expect(tooLarge.status).toBe(400);
  });
});
