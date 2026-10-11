/**
 * @file Sales HTTP routes through the Hono app with real development-token Access verification,
 *   over the fake Data Worker. Each route is checked against its shared schema plus its error
 *   mapping: validation (422), missing preconditions (428), authorization (403), absence (404), and
 *   conflicts (409).
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
const AUD = 'c'.repeat(64);

/**
 * Request origin.
 */
const ORIGIN = 'https://crm.example';

/**
 * Build the app over a fresh fake with sales, read-only, and owner users and one contact.
 *
 * @returns A request helper and the seeded contact id.
 */
async function setup() {
  const { service, store } = createFakeDataService({
    runtime: testRuntime(new Date('2026-10-11T09:00:00.000Z'))
  });
  const salesId = store.addUser('sales@example.com', 'sales');
  store.addUser('reader@example.com', 'read-only');
  store.addUser('owner@example.com', 'owner');
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
    options: RequestInit & { as?: string; json?: unknown } = {}
  ): Promise<Response> => {
    const { as, json, ...init } = options;
    const headers = new Headers(init.headers);
    if (as !== undefined) {
      headers.set(JWT_HEADER, await signDevJwt(as, { audience: AUD }));
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

describe('pipeline and assignees', () => {
  it('serves the pipeline and active users to any reader', async () => {
    const { call } = await setup();
    const pipeline = await body<{ stages: unknown[] }>(
      await call('/api/v1/pipeline', { as: 'reader@example.com' })
    );
    expect(pipeline.stages).toHaveLength(4);
    const users = await body<unknown[]>(
      await call('/api/v1/assignees', { as: 'reader@example.com' })
    );
    expect(users).toHaveLength(3);
  });
});

describe('deals', () => {
  it('creates (201 + ETag), lists, reads, and updates with If-Match', async () => {
    const { call, contactId } = await setup();
    const created = await call('/api/v1/deals', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-deal-1' },
      json: { title: 'Renewal', primaryContactId: contactId, amountMinor: 120000 }
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('ETag')).toBe('"1"');
    const deal = await body<{ id: string }>(created);
    expect(created.headers.get('Location')).toBe(`/api/v1/deals/${deal.id}`);

    const list = await body<{ items: unknown[] }>(
      await call('/api/v1/deals?q=renew&status=pending&limit=5', { as: 'reader@example.com' })
    );
    expect(list.items).toHaveLength(1);
    // The seeded first stage (Lead) holds the new deal; another stage has none.
    const lead = '10000000-0000-4000-8000-000000000011';
    const qualified = '10000000-0000-4000-8000-000000000012';
    expect(
      (
        await body<{ items: unknown[] }>(
          await call(`/api/v1/deals?stage=${lead}`, { as: 'reader@example.com' })
        )
      ).items
    ).toHaveLength(1);
    expect(
      (
        await body<{ items: unknown[] }>(
          await call(`/api/v1/deals?stage=${qualified}`, { as: 'reader@example.com' })
        )
      ).items
    ).toHaveLength(0);
    expect((await call('/api/v1/deals?stage=nope', { as: 'reader@example.com' })).status).toBe(422);
    const detail = await call(`/api/v1/deals/${deal.id}`, { as: 'reader@example.com' });
    expect(detail.headers.get('ETag')).toBe('"1"');

    const updated = await call(`/api/v1/deals/${deal.id}`, {
      as: 'sales@example.com',
      method: 'PATCH',
      headers: { 'Idempotency-Key': 'http-deal-2', 'If-Match': '"1"' },
      json: { status: 'won' }
    });
    expect(updated.status).toBe(200);
    expect(updated.headers.get('ETag')).toBe('"2"');
    const stale = await call(`/api/v1/deals/${deal.id}`, {
      as: 'sales@example.com',
      method: 'PATCH',
      headers: { 'Idempotency-Key': 'http-deal-3', 'If-Match': '"1"' },
      json: { title: 'Again' }
    });
    expect(stale.status).toBe(409);
    expect(await body(stale)).toMatchObject({ code: 'VERSION_MISMATCH' });
  });

  it('maps validation, preconditions, authorization, and absence', async () => {
    const { call, contactId } = await setup();
    const invalid = await call('/api/v1/deals', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-deal-bad' },
      json: { title: '', primaryContactId: contactId }
    });
    expect(invalid.status).toBe(422);
    expect(await body(invalid)).toMatchObject({ fields: { title: 'Title is required.' } });
    expect(
      (
        await call('/api/v1/deals', {
          as: 'sales@example.com',
          method: 'POST',
          json: { title: 'x', primaryContactId: contactId }
        })
      ).status
    ).toBe(428);
    expect(
      (
        await call('/api/v1/deals', {
          as: 'reader@example.com',
          method: 'POST',
          headers: { 'Idempotency-Key': 'http-deal-ro' },
          json: { title: 'x', primaryContactId: contactId }
        })
      ).status
    ).toBe(403);
    expect(
      (await call(`/api/v1/deals/${crypto.randomUUID()}`, { as: 'reader@example.com' })).status
    ).toBe(404);
    expect((await call('/api/v1/deals/NOPE', { as: 'reader@example.com' })).status).toBe(422);
    expect((await call('/api/v1/deals?status=open', { as: 'reader@example.com' })).status).toBe(
      422
    );
    expect(
      (
        await call(`/api/v1/deals/${crypto.randomUUID()}`, {
          as: 'sales@example.com',
          method: 'PATCH',
          headers: { 'Idempotency-Key': 'http-deal-nomatch' },
          json: { title: 'x' }
        })
      ).status
    ).toBe(428);
  });
});

describe('activities', () => {
  it('creates a multi-linked meeting and rejects an empty contact list', async () => {
    const { call, contactId, companyId } = await setup();
    const created = await call('/api/v1/activities', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-activity-1' },
      json: {
        type: 'meeting',
        subject: 'Kickoff',
        occurredAt: '2026-10-11T08:00:00.000Z',
        contactIds: [contactId],
        companyId
      }
    });
    expect(created.status).toBe(201);
    expect(await body(created)).toMatchObject({ company: { id: companyId } });
    const contact = await body<{ activities: unknown[] }>(
      await call(`/api/v1/contacts/${contactId}`, { as: 'reader@example.com' })
    );
    expect(contact.activities).toHaveLength(1);
    const empty = await call('/api/v1/activities', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-activity-2' },
      json: { type: 'call', subject: 'x', occurredAt: '2026-10-11T08:00:00.000Z', contactIds: [] }
    });
    expect(empty.status).toBe(422);
    expect(await body(empty)).toMatchObject({
      fields: { contactIds: 'Choose at least one contact.' }
    });
  });
});

describe('contact next actions and action stream', () => {
  it('creates without If-Match, replaces with it, completes, and shows in the stream', async () => {
    const { call, contactId } = await setup();
    const path = `/api/v1/contacts/${contactId}/next-action`;
    const set = await call(path, {
      as: 'sales@example.com',
      method: 'PUT',
      headers: { 'Idempotency-Key': 'http-na-1' },
      json: { text: 'Call back', dueDate: '2026-10-11' }
    });
    expect(set.status).toBe(200);
    expect(set.headers.get('ETag')).toBe('"1"');
    const duplicate = await call(path, {
      as: 'sales@example.com',
      method: 'PUT',
      headers: { 'Idempotency-Key': 'http-na-2' },
      json: { text: 'Again' }
    });
    expect(duplicate.status).toBe(409);
    const replaced = await call(path, {
      as: 'sales@example.com',
      method: 'PUT',
      headers: { 'Idempotency-Key': 'http-na-3', 'If-Match': '"1"' },
      json: { text: 'Email instead', dueDate: null }
    });
    expect(await body(replaced)).toMatchObject({ version: 2, dueDate: null });

    const stream = await body<{ items: { text: string; urgency: string }[] }>(
      await call('/api/v1/action-stream', { as: 'sales@example.com' })
    );
    expect(stream.items).toEqual([
      expect.objectContaining({ text: 'Email instead', urgency: 'asap' })
    ]);

    const completed = await call(`${path}/complete`, {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-na-4', 'If-Match': '"2"' }
    });
    expect(completed.status).toBe(200);
    expect(
      (
        await body<{ items: unknown[] }>(
          await call('/api/v1/action-stream', { as: 'sales@example.com' })
        )
      ).items
    ).toEqual([]);
    expect(
      (
        await call(path, {
          as: 'sales@example.com',
          method: 'PUT',
          headers: { 'Idempotency-Key': 'http-na-5', 'If-Match': 'nope' },
          json: { text: 'x' }
        })
      ).status
    ).toBe(422);
  });
});

describe('pipeline report', () => {
  it('serves the bounded summary to readers', async () => {
    const { call } = await setup();
    const report = await call('/api/v1/reports/pipeline', { as: 'reader@example.com' });
    expect(report.status).toBe(200);
    expect(await body(report)).toMatchObject({ currency: 'GBP', open: { count: 0 } });
  });
});
