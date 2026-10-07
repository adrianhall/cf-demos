import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteAnyDiagram, getAnyDiagram, listUsers } from '../../src/client/api/admin.ts';

/**
 * @file Covers the administrative API client. Two things matter beyond the happy path: that a `403`
 *   — the answer every identity except the configured administrator receives — surfaces as a
 *   readable error rather than as a crash while rendering, and that a well-formed but unexpected
 *   body is reported at the call site rather than reaching a component as `undefined`.
 */

/**
 * The `fetch` stub installed for each test.
 */
let fetchMock: ReturnType<typeof vi.fn>;

/**
 * Stubs `fetch` with one response.
 *
 * @param body Value serialised as the response body, or `null` for an empty body.
 * @param init Response status and headers.
 */
function stubResponse(body: unknown, init: ResponseInit = {}): void {
  fetchMock = vi.fn(
    async () =>
      new Response(body === null ? null : JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        ...init
      })
  );
  vi.stubGlobal('fetch', fetchMock);
}

/**
 * Builds a directory row.
 *
 * @returns One row, as the API returns it.
 */
function user() {
  return {
    diagramCount: 3,
    displayName: null,
    email: 'alice@example.com',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-02T00:00:00.000Z'
  };
}

/**
 * One page of the directory, as the API returns it.
 */
const PAGE = { limit: 20, offset: 0, total: 1, users: [user()] };

/**
 * A diagram as the moderation preview returns it: owner-blind, by the server's construction.
 */
const DIAGRAM = {
  description: 'Notes',
  graphData: '{"nodes":[],"edges":[]}',
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Reviewed Diagram'
};

beforeEach(() => {
  stubResponse(PAGE);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listUsers', () => {
  it('reads the directory and returns the page', async () => {
    await expect(listUsers()).resolves.toEqual(PAGE);
  });

  it('asks for the whole directory when given no window', async () => {
    await listUsers();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/users');
  });

  it('sends the pagination window it was given', async () => {
    await listUsers({ limit: 10, offset: 40 });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/users?limit=10&offset=40');
  });

  it.each([
    ['only a limit', { limit: 5 }, '/api/admin/users?limit=5'],
    ['only an offset', { offset: 20 }, '/api/admin/users?offset=20'],
    ['a zero offset', { offset: 0 }, '/api/admin/users?offset=0']
  ])('sends %s', async (_description, options, expected) => {
    await listUsers(options);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(expected);
  });

  // The window travels back from the server, which owns the defaults, so a client that sent
  // nothing still learns which page it got.
  it('reports the window the server applied', async () => {
    stubResponse({ ...PAGE, limit: 20, offset: 0 });

    await expect(listUsers()).resolves.toMatchObject({ limit: 20, offset: 0 });
  });

  // The answer every identity except the configured administrator receives. It must read as an
  // error somebody can be shown, not as a crash while rendering.
  it('surfaces the refusal an ordinary identity receives', async () => {
    stubResponse(
      { detail: 'This Cloudflare Access identity is not the configured administrator.' },
      { status: 403 }
    );

    await expect(listUsers()).rejects.toThrow(/not the configured administrator/u);
  });

  it('surfaces a validation refusal', async () => {
    stubResponse({ detail: 'limit must be between 1 and 100.' }, { status: 422 });

    await expect(listUsers({ limit: 500 })).rejects.toThrow('limit must be between 1 and 100.');
  });

  it('falls back to a usable message when the failure carried no detail', async () => {
    stubResponse(null, { status: 500 });

    await expect(listUsers()).rejects.toThrow('The request could not be completed.');
  });

  it('prefers the problem title when there is no detail', async () => {
    stubResponse({ title: 'Service Unavailable' }, { status: 503 });

    await expect(listUsers()).rejects.toThrow('Service Unavailable');
  });

  // Reported here rather than reaching the table as `undefined`, which would fail while
  // rendering with no connection to the request that caused it.
  it.each([
    ['a body with no users', { total: 0 }],
    ['a body whose users are not a list', { total: 0, users: 'none' }],
    ['a body with no total', { users: [] }]
  ])('refuses %s', async (_description, body) => {
    stubResponse(body);

    await expect(listUsers()).rejects.toThrow('The server returned an unexpected response.');
  });

  // A `200` whose body is not a JSON object at all. Casting it would hand the table `undefined`
  // and fail later while rendering, with no connection to the request that caused it.
  it.each([
    ['an empty body', null],
    ['a body that is a list rather than an object', []]
  ])('refuses a successful response carrying %s', async (_description, body) => {
    stubResponse(body, { status: 200 });

    await expect(listUsers()).rejects.toThrow('The server returned an unexpected response.');
  });

  // The window is only trusted when the server actually reported it; a response missing either
  // value falls back rather than putting `undefined` into the paging arithmetic.
  it('falls back to a usable window when the server reported none', async () => {
    stubResponse({ total: 1, users: [user()] });

    await expect(listUsers()).resolves.toMatchObject({ limit: 1, offset: 0 });
  });
});

describe('getAnyDiagram', () => {
  it('reads one diagram by id', async () => {
    stubResponse({ diagram: DIAGRAM });

    await expect(getAnyDiagram(DIAGRAM.id)).resolves.toEqual(DIAGRAM);
  });

  it('escapes an id that would otherwise change the path', async () => {
    stubResponse({ diagram: DIAGRAM });

    await getAnyDiagram('../users');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/diagrams/..%2Fusers');
  });

  it('surfaces the refusal an ordinary identity receives', async () => {
    stubResponse(
      { detail: 'This Cloudflare Access identity is not the configured administrator.' },
      {
        status: 403
      }
    );

    await expect(getAnyDiagram(DIAGRAM.id)).rejects.toThrow(/not the configured administrator/u);
  });

  it('surfaces a diagram that does not exist', async () => {
    stubResponse({ detail: 'Diagram not found.' }, { status: 404 });

    await expect(getAnyDiagram(DIAGRAM.id)).rejects.toThrow('Diagram not found.');
  });

  it('refuses a successful response that carried no diagram', async () => {
    stubResponse({});

    await expect(getAnyDiagram(DIAGRAM.id)).rejects.toThrow(
      'The server returned an unexpected response.'
    );
  });
});

describe('deleteAnyDiagram', () => {
  it('deletes by id', async () => {
    stubResponse(null, { status: 204 });

    await expect(deleteAnyDiagram(DIAGRAM.id)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/admin/diagrams/${DIAGRAM.id}`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  // The Worker requires exactly this type on a mutation, so a cross-origin form submission —
  // which can only send safelisted types — cannot reach the endpoint at all.
  it('declares the JSON content type the Worker requires of a mutation', async () => {
    stubResponse(null, { status: 204 });

    await deleteAnyDiagram(DIAGRAM.id);

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'Content-Type': 'application/json' }
    });
  });

  it('surfaces the refusal an ordinary identity receives', async () => {
    stubResponse(
      { detail: 'This Cloudflare Access identity is not the configured administrator.' },
      {
        status: 403
      }
    );

    await expect(deleteAnyDiagram(DIAGRAM.id)).rejects.toThrow(/not the configured administrator/u);
  });

  it('surfaces a diagram that does not exist', async () => {
    stubResponse({ detail: 'Diagram not found.' }, { status: 404 });

    await expect(deleteAnyDiagram(DIAGRAM.id)).rejects.toThrow('Diagram not found.');
  });

  it('falls back to a usable message when the failure body was unreadable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json at all', { status: 500 }))
    );

    await expect(deleteAnyDiagram(DIAGRAM.id)).rejects.toThrow(
      'The request could not be completed.'
    );
  });
});
