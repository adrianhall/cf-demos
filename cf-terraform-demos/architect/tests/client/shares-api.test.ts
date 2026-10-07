import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createShare,
  getSharedDiagram,
  getShareStatus,
  revokeShare
} from '../../src/client/api/shares.ts';

/**
 * @file Covers the browser's only route to share data. The requests themselves are simple; what
 *   these tests are really for is the failure behaviour and one security-adjacent property — the
 *   client never hashes, derives or interprets a token, it only carries one. A client that tried to
 *   be clever about tokens would be a second place the rule "only the server holds the digest"
 *   could be got wrong.
 */

/**
 * Builds a JSON response.
 *
 * @param body Value to serialise as the body.
 * @param status HTTP status. Defaults to `200`.
 * @returns The response.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status
  });
}

/**
 * Stubs `fetch` with a single response.
 *
 * @param response Response to answer with.
 * @returns The mock, so a test can assert on the request it received.
 */
function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => response);
  vi.stubGlobal('fetch', mock);
  return mock;
}

/**
 * A plausible token, of the length the server mints.
 */
const TOKEN = 't'.repeat(43);

/**
 * The shareable URL the server assembles for {@link TOKEN}.
 */
const CREATED_URL = `https://diagrams.test/s/${TOKEN}`;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getShareStatus', () => {
  it('reads the status from the owner-scoped endpoint', async () => {
    const fetchMock = stubFetch(
      jsonResponse({ active: true, createdAt: '2026-01-01T00:00:00.000Z' })
    );

    await expect(getShareStatus('d1')).resolves.toEqual({
      active: true,
      createdAt: '2026-01-01T00:00:00.000Z'
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/diagrams/d1/share', expect.anything());
  });

  it('encodes the diagram id in the path', async () => {
    const fetchMock = stubFetch(jsonResponse({ active: false, createdAt: null }));

    await getShareStatus('a/b');

    expect(fetchMock).toHaveBeenCalledWith('/api/diagrams/a%2Fb/share', expect.anything());
  });

  it('reports the problem document\u2019s detail when the diagram is not the caller\u2019s', async () => {
    stubFetch(jsonResponse({ detail: 'Diagram not found.' }, 404));

    await expect(getShareStatus('d1')).rejects.toThrow('Diagram not found.');
  });

  it('falls back to a fixed message when the error body is unreadable', async () => {
    stubFetch(new Response('not json', { status: 500 }));

    await expect(getShareStatus('d1')).rejects.toThrow('The request could not be completed.');
  });

  it('reports an unexpected successful body rather than handing back undefined', async () => {
    stubFetch(jsonResponse({ unexpected: true }));

    await expect(getShareStatus('d1')).rejects.toThrow(
      'The server returned an unexpected response.'
    );
  });

  // A successful response whose body cannot be read at all is an error, not a value to hand on:
  // casting it to the expected type would give the caller `undefined`, which surfaces later as a
  // crash while rendering rather than as a request failure anybody can act on.
  it('reports a successful response whose body is not JSON at all', async () => {
    stubFetch(new Response('', { status: 200 }));

    await expect(getShareStatus('d1')).rejects.toThrow(
      'The server returned an unexpected response.'
    );
  });

  // An active share always carries a timestamp; an inactive one carries an explicit null. A
  // response missing the field entirely is still answered coherently rather than with undefined.
  it('normalises a missing createdAt to null', async () => {
    stubFetch(jsonResponse({ active: false }));

    await expect(getShareStatus('d1')).resolves.toEqual({ active: false, createdAt: null });
  });
});

describe('createShare', () => {
  it('posts to the owner-scoped endpoint and returns the one-time link', async () => {
    const fetchMock = stubFetch(
      jsonResponse(
        { createdAt: '2026-01-01T00:00:00.000Z', token: TOKEN, url: `https://x.test/s/${TOKEN}` },
        201
      )
    );

    await expect(createShare('d1')).resolves.toEqual({
      createdAt: '2026-01-01T00:00:00.000Z',
      token: TOKEN,
      url: `https://x.test/s/${TOKEN}`
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/diagrams/d1/share',
      expect.objectContaining({ method: 'POST' })
    );
  });

  // Not CORS-safelisted, so requiring it on the server means a cross-origin form submission
  // cannot reach this endpoint at all. The client has to send it for the request to succeed.
  it('declares the exact JSON content type the server requires of a mutation', async () => {
    const fetchMock = stubFetch(jsonResponse({ createdAt: 'x', token: TOKEN, url: 'u' }, 201));

    await createShare('d1');

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'Content-Type': 'application/json' }
    });
  });

  it('reports a refusal with the server\u2019s detail', async () => {
    stubFetch(jsonResponse({ detail: 'Diagram not found.' }, 404));

    await expect(createShare('d1')).rejects.toThrow('Diagram not found.');
  });

  it('reports a response that carried no url', async () => {
    stubFetch(jsonResponse({ createdAt: 'x', token: TOKEN }, 201));

    await expect(createShare('d1')).rejects.toThrow('The server returned an unexpected response.');
  });

  it('tolerates a creation response that omitted its timestamp', async () => {
    stubFetch(jsonResponse({ token: TOKEN, url: CREATED_URL }, 201));

    await expect(createShare('d1')).resolves.toMatchObject({ createdAt: '', url: CREATED_URL });
  });
});

describe('revokeShare', () => {
  it('sends a delete and resolves on the empty success response', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));

    await expect(revokeShare('d1')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/diagrams/d1/share',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('reports a refusal with the server\u2019s detail', async () => {
    stubFetch(jsonResponse({ detail: 'No active share link for this diagram.' }, 404));

    await expect(revokeShare('d1')).rejects.toThrow('No active share link for this diagram.');
  });

  it('falls back to a fixed message when the refusal body is unreadable', async () => {
    stubFetch(new Response('', { status: 500 }));

    await expect(revokeShare('d1')).rejects.toThrow('The request could not be completed.');
  });
});

describe('getSharedDiagram', () => {
  it('reads the public resolver and unwraps the diagram', async () => {
    const fetchMock = stubFetch(
      jsonResponse({
        diagram: { description: null, graphData: '{}', id: 'd1', title: 'Shared' }
      })
    );

    await expect(getSharedDiagram(TOKEN)).resolves.toEqual({
      description: null,
      graphData: '{}',
      id: 'd1',
      title: 'Shared'
    });
    expect(fetchMock).toHaveBeenCalledWith(`/api/shares/${TOKEN}`, expect.anything());
  });

  // A token taken from the address bar may legitimately be percent-encoded; the server compares a
  // digest of the raw value, so the decoded token has to reach it as a single path segment.
  it('encodes the token in the path', async () => {
    const fetchMock = stubFetch(jsonResponse({ diagram: { id: 'd1' } }));

    await getSharedDiagram('a/b');

    expect(fetchMock).toHaveBeenCalledWith('/api/shares/a%2Fb', expect.anything());
  });

  // The client carries the token and nothing more: it never hashes it, shortens it or derives
  // anything from it, because only the server holds the digest it is compared against.
  it('sends the token unchanged and keeps it out of every other part of the request', async () => {
    const fetchMock = stubFetch(jsonResponse({ diagram: { id: 'd1' } }));

    await getSharedDiagram(TOKEN);

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(path).toBe(`/api/shares/${TOKEN}`);
    expect(JSON.stringify(init.headers)).not.toContain(TOKEN);
    expect(init.body).toBeUndefined();
  });

  it.each([
    ['an unknown token', { detail: 'Share link not found or revoked.' }],
    ['a revoked token', { detail: 'Share link not found or revoked.' }]
  ])('reports %s with the server\u2019s uniform detail', async (_label, body) => {
    stubFetch(jsonResponse(body, 404));

    await expect(getSharedDiagram(TOKEN)).rejects.toThrow('Share link not found or revoked.');
  });

  it('reports a successful response that carried no diagram', async () => {
    stubFetch(jsonResponse({}));

    await expect(getSharedDiagram(TOKEN)).rejects.toThrow(
      'The server returned an unexpected response.'
    );
  });
});
