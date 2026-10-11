/**
 * @file Delivery HTTP routes through the Hono app with real development-token Access verification,
 *   over the fake Data Worker: conversion (201, Location, ETag; 409 for ineligible deals; 428
 *   without preconditions), project and task CRUD with `If-Match`, the worklist, and the error
 *   mapping for validation (422), authorization (403), and absence (404).
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
 * Build the app over a fake with sales, delivery, and read-only users and one won deal.
 *
 * @returns A request helper and the won deal.
 */
async function setup() {
  const { service, store } = createFakeDataService({
    runtime: testRuntime(new Date('2026-10-11T09:00:00.000Z'))
  });
  const salesId = store.addUser('sales@example.com', 'sales');
  store.addUser('delivery@example.com', 'delivery');
  store.addUser('reader@example.com', 'read-only');
  const sales = {
    email: 'sales@example.com',
    userId: salesId,
    requestId: 'seed',
    channel: 'api' as const
  };
  const contact = await service.crm.createContact(
    sales,
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
  const deal = await service.crm.createDeal(
    sales,
    {
      title: 'Renewal',
      primaryContactId: contact.id,
      amountMinor: 0,
      statusLine: null,
      nextActionText: null,
      nextActionDate: null,
      expectedCloseDate: null
    },
    { idempotencyKey: 'seed-deal' }
  );
  const won = await service.crm.updateDeal(sales, deal.id, { status: 'won' }, 1, {
    idempotencyKey: 'seed-won'
  });
  const pending = await service.crm.createDeal(
    sales,
    {
      title: 'Still pending',
      primaryContactId: contact.id,
      amountMinor: 0,
      statusLine: null,
      nextActionText: null,
      nextActionDate: null,
      expectedCloseDate: null
    },
    { idempotencyKey: 'seed-pending' }
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
  return { call, won, pendingId: pending.id };
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

describe('conversion', () => {
  it('converts once (201 + Location), then answers 409 for a second attempt', async () => {
    const { call, won } = await setup();
    const converted = await call(`/api/v1/deals/${won.id}/convert`, {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-convert-1', 'If-Match': `"${won.version}"` }
    });
    expect(converted.status).toBe(201);
    const project = await body<{ id: string; sourceDeal: { id: string } }>(converted);
    expect(converted.headers.get('Location')).toBe(`/api/v1/projects/${project.id}`);
    expect(converted.headers.get('ETag')).toBe('"1"');
    expect(project.sourceDeal.id).toBe(won.id);

    const again = await call(`/api/v1/deals/${won.id}/convert`, {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-convert-2', 'If-Match': `"${won.version + 1}"` },
      json: { name: 'Second' }
    });
    expect(again.status).toBe(409);
    expect(await body(again)).toMatchObject({ code: 'CONFLICT' });
  });

  it('wins and converts a pending deal in one request with markWon', async () => {
    const { call, pendingId } = await setup();
    const response = await call(`/api/v1/deals/${pendingId}/convert`, {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-convert-mw', 'If-Match': '"1"' },
      json: { markWon: true }
    });
    expect(response.status).toBe(201);
    const deal = await body<{ deal: { status: string; project: { id: string } | null } }>(
      await call(`/api/v1/deals/${pendingId}`, { as: 'reader@example.com' })
    );
    expect(deal.deal.status).toBe('won');
    expect(deal.deal.project).not.toBeNull();
  });

  it('maps ineligible, forbidden, missing-precondition, and invalid conversions', async () => {
    const { call, won, pendingId } = await setup();
    const pending = await call(`/api/v1/deals/${pendingId}/convert`, {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-convert-p', 'If-Match': '"1"' }
    });
    expect(pending.status).toBe(409);
    expect(
      (
        await call(`/api/v1/deals/${won.id}/convert`, {
          as: 'delivery@example.com',
          method: 'POST',
          headers: { 'Idempotency-Key': 'http-convert-d', 'If-Match': `"${won.version}"` }
        })
      ).status
    ).toBe(403);
    expect(
      (
        await call(`/api/v1/deals/${won.id}/convert`, {
          as: 'sales@example.com',
          method: 'POST',
          headers: { 'Idempotency-Key': 'http-convert-n' }
        })
      ).status
    ).toBe(428);
    const invalid = await call(`/api/v1/deals/${won.id}/convert`, {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-convert-i', 'If-Match': `"${won.version}"` },
      json: { companyId: crypto.randomUUID() }
    });
    expect(invalid.status).toBe(422);
  });
});

describe('projects, tasks, and my work', () => {
  it('reads, edits, adds and moves tasks, and lists my work', async () => {
    const { call, won } = await setup();
    const project = await body<{ id: string }>(
      await call(`/api/v1/deals/${won.id}/convert`, {
        as: 'sales@example.com',
        method: 'POST',
        headers: { 'Idempotency-Key': 'http-flow-convert', 'If-Match': `"${won.version}"` },
        json: { name: 'Delivery' }
      })
    );
    const list = await body<{ items: unknown[] }>(
      await call('/api/v1/projects?q=deliv&status=active&limit=5', { as: 'reader@example.com' })
    );
    expect(list.items).toHaveLength(1);
    const detail = await call(`/api/v1/projects/${project.id}`, { as: 'reader@example.com' });
    expect(detail.headers.get('ETag')).toBe('"1"');

    const edited = await call(`/api/v1/projects/${project.id}`, {
      as: 'delivery@example.com',
      method: 'PATCH',
      headers: { 'Idempotency-Key': 'http-flow-edit', 'If-Match': '"1"' },
      json: { description: 'Go live' }
    });
    expect(edited.headers.get('ETag')).toBe('"2"');

    const me = await body<{ user: { id: string } }>(
      await call('/api/v1/session', { as: 'delivery@example.com' })
    );
    const created = await call(`/api/v1/projects/${project.id}/tasks`, {
      as: 'delivery@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-flow-task' },
      json: { title: 'Kickoff', priority: 'high', assigneeId: me.user.id }
    });
    expect(created.status).toBe(201);
    const task = await body<{ id: string; status: string }>(created);
    expect(task.status).toBe('todo');
    const moved = await call(`/api/v1/tasks/${task.id}`, {
      as: 'delivery@example.com',
      method: 'PATCH',
      headers: { 'Idempotency-Key': 'http-flow-move', 'If-Match': '"1"' },
      json: { status: 'in_progress' }
    });
    expect(await body(moved)).toMatchObject({ status: 'in_progress', version: 2 });
    const work = await body<{ items: { id: string }[] }>(
      await call('/api/v1/my-work', { as: 'delivery@example.com' })
    );
    expect(work.items.map((item) => item.id)).toEqual([task.id]);

    const stale = await call(`/api/v1/tasks/${task.id}`, {
      as: 'delivery@example.com',
      method: 'PATCH',
      headers: { 'Idempotency-Key': 'http-flow-stale', 'If-Match': '"1"' },
      json: { status: 'done' }
    });
    expect(stale.status).toBe(409);
  });

  it('maps validation, authorization, and absence', async () => {
    const { call } = await setup();
    expect((await call('/api/v1/projects/NOPE', { as: 'reader@example.com' })).status).toBe(422);
    expect(
      (await call(`/api/v1/projects/${crypto.randomUUID()}`, { as: 'reader@example.com' })).status
    ).toBe(404);
    expect((await call('/api/v1/projects?status=open', { as: 'reader@example.com' })).status).toBe(
      422
    );
    expect(
      (
        await call(`/api/v1/projects/${crypto.randomUUID()}/tasks`, {
          as: 'reader@example.com',
          method: 'POST',
          headers: { 'Idempotency-Key': 'http-ro-task' },
          json: { title: 'x' }
        })
      ).status
    ).toBe(403);
    const badPriority = await call(`/api/v1/projects/${crypto.randomUUID()}/tasks`, {
      as: 'delivery@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-bad-task' },
      json: { title: 'x', priority: 'p0' }
    });
    expect(badPriority.status).toBe(422);
    expect(
      (
        await call(`/api/v1/tasks/${crypto.randomUUID()}`, {
          as: 'delivery@example.com',
          method: 'PATCH',
          headers: { 'Idempotency-Key': 'http-no-match' },
          json: { title: 'x' }
        })
      ).status
    ).toBe(428);
    expect(
      (
        await call(`/api/v1/projects/${crypto.randomUUID()}`, {
          as: 'delivery@example.com',
          method: 'PATCH',
          headers: { 'Idempotency-Key': 'http-no-proj', 'If-Match': '"1"' },
          json: { name: 'x' }
        })
      ).status
    ).toBe(404);
  });
});
