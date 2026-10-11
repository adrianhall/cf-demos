/**
 * @file The SPA API client: request shaping, problem parsing, and response validation.
 */

import { describe, expect, it } from 'vitest';
import { createFormatters } from '../../src/client/composables/useFormat.ts';
import { ApiClient, ApiError } from '../../src/client/services/api-client.ts';
import { DEFAULT_CONFIGURATION } from '../../src/configuration.ts';

/**
 * A client whose fetch returns one canned response and records the request.
 *
 * @param status HTTP status.
 * @param body JSON body (or a raw string).
 * @returns The client and recorded calls.
 */
function canned(status: number, body: unknown) {
  const calls: { input: string; init: RequestInit }[] = [];
  const client = new ApiClient((input, init) => {
    calls.push({ input, init });
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
    );
  });
  return { client, calls };
}

/**
 * Capture an ApiError.
 *
 * @param promise The call.
 * @returns The error.
 */
async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected an ApiError');
}

describe('ApiClient', () => {
  it('sends JSON with the idempotency key and same-origin credentials', async () => {
    const contact = {
      id: crypto.randomUUID(),
      firstName: 'A',
      lastName: null,
      displayName: 'A',
      email: null,
      phone: null,
      jobTitle: null,
      company: null,
      owner: { id: crypto.randomUUID(), displayName: 'Me' },
      version: 1,
      createdAt: '2026-10-01T09:00:00.000Z',
      updatedAt: '2026-10-01T09:00:00.000Z'
    };
    const { client, calls } = canned(201, contact);
    expect(await client.createContact({ firstName: 'A' }, 'key-12345678')).toEqual(contact);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(calls[0]).toMatchObject({
      input: '/api/v1/contacts',
      init: { method: 'POST', credentials: 'same-origin' }
    });
    expect(headers).toMatchObject({
      'Idempotency-Key': 'key-12345678',
      'Content-Type': 'application/json'
    });
  });

  it('builds query strings, omitting empty values', async () => {
    const { client, calls } = canned(200, { items: [], nextCursor: null });
    await client.contacts({ q: 'ada lovelace', cursor: '' });
    await client.companies({});
    expect(calls.map((call) => call.input)).toEqual([
      '/api/v1/contacts?q=ada+lovelace',
      '/api/v1/companies'
    ]);
  });

  it('builds report and overview URLs and rejects malformed report and overview bodies', async () => {
    const { client, calls } = canned(200, { stages: 'wrong' });
    expect((await apiError(client.pipelineReport({ closedFrom: '2026-10-01' }))).kind).toBe(
      'malformed'
    );
    expect((await apiError(client.deliveryReport({ projectStatus: 'on_hold' }))).kind).toBe(
      'malformed'
    );
    const id = '00000000-0000-4000-8000-000000000001';
    expect((await apiError(client.contactOverview(id))).kind).toBe('malformed');
    expect((await apiError(client.companyOverview(id))).kind).toBe('malformed');
    expect(calls.map((call) => call.input)).toEqual([
      '/api/v1/reports/pipeline?closedFrom=2026-10-01',
      '/api/v1/reports/delivery?projectStatus=on_hold',
      `/api/v1/contacts/${id}/overview`,
      `/api/v1/companies/${id}/overview`
    ]);
  });

  it('rejects a malformed success body before it reaches UI state', async () => {
    const { client } = canned(200, { items: [{ id: 'nope' }], nextCursor: null });
    expect((await apiError(client.contacts({}))).kind).toBe('malformed');
  });

  it('parses problem details into a typed error', async () => {
    const { client } = canned(422, {
      type: 'about:blank',
      status: 422,
      title: 'Unprocessable',
      detail: 'Bad fields',
      code: 'VALIDATION_FAILED',
      requestId: 'r-1',
      fields: { email: 'Invalid' }
    });
    const error = await apiError(client.createContact({}, 'key-12345678'));
    expect(error).toMatchObject({
      kind: 'validation',
      message: 'Bad fields',
      status: 422,
      requestId: 'r-1'
    });
    expect(error.fields).toEqual({ email: 'Invalid' });
  });

  it('classifies each failure status', async () => {
    const cases: [number, string][] = [
      [401, 'unauthenticated'],
      [403, 'forbidden'],
      [404, 'not-found'],
      [409, 'conflict'],
      [503, 'unavailable'],
      [500, 'server']
    ];
    for (const [status, kind] of cases) {
      const { client } = canned(status, { type: 'about:blank', status, title: 'x' });
      expect((await apiError(client.session())).kind).toBe(kind);
    }
  });

  it('survives a non-problem error body', async () => {
    const { client } = canned(502, '<html>bad gateway</html>');
    const error = await apiError(client.dashboard());
    expect(error).toMatchObject({ kind: 'server', message: 'Request failed (502).' });
    expect(error.fields).toEqual({});
    expect(error.requestId).toBeUndefined();
  });

  it('reports network failures and passes aborts through', async () => {
    const offline = new ApiClient(() => Promise.reject(new TypeError('Failed to fetch')));
    expect((await apiError(offline.configuration())).kind).toBe('network');
    const aborted = new ApiClient(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    await expect(aborted.contact(crypto.randomUUID())).rejects.toMatchObject({
      name: 'AbortError'
    });
  });
});

describe('formatters', () => {
  it('formats money, dates, and counts for the UK installation', () => {
    const format = createFormatters(DEFAULT_CONFIGURATION);
    expect(format.money(123456)).toBe('£1,234.56');
    expect(format.date('2026-03-29')).toBe('29 Mar 2026');
    expect(format.count(12345)).toBe('12,345');
    // 23:30 UTC on 31 Mar is 00:30 BST on 1 Apr in London.
    expect(format.dateTime('2026-03-31T23:30:00.000Z')).toContain('1 Apr 2026');
  });
});
