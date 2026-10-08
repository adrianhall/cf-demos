import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDiagram,
  deleteDiagram,
  diagramLiveUrl,
  duplicateDiagram,
  getDiagram,
  listDiagrams,
  saveDiagramGraph,
  updateDiagram
} from '../../src/client/api/diagrams.ts';

/**
 * @file Covers the browser's only route to diagram data: the requests it sends, and — more
 *   importantly — how it behaves when a response is not what it expected. The "unexpected response"
 *   cases are the reason this file is as long as it is. A client that casts a successful-but-wrong
 *   body to its expected type hands the caller `undefined`, which fails later inside a component
 *   with no connection to the request that caused it. Failing here instead turns that into an error
 *   a view can actually report.
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
 * One diagram as the API returns it.
 */
const DIAGRAM = {
  createdAt: '2026-01-01T00:00:00.000Z',
  description: null,
  graphData: '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}',
  id: 'd1',
  ownerEmail: 'alice@example.com',
  title: 'My Diagram',
  updatedAt: '2026-01-02T00:00:00.000Z'
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requests', () => {
  it('lists diagrams from the collection endpoint', async () => {
    const fetchMock = stubFetch(jsonResponse({ diagrams: [DIAGRAM] }));

    expect(await listDiagrams()).toEqual([DIAGRAM]);
    expect(fetchMock).toHaveBeenCalledWith('/api/diagrams', expect.anything());
  });

  it('reads one diagram by id', async () => {
    const fetchMock = stubFetch(jsonResponse({ diagram: DIAGRAM }));

    expect(await getDiagram('d1')).toEqual(DIAGRAM);
    expect(fetchMock).toHaveBeenCalledWith('/api/diagrams/d1', expect.anything());
  });

  // An id reaches the server in the path, so it is encoded rather than concatenated. Without this
  // an id containing a slash would address an entirely different route.
  it.each([
    ['a slash', 'a/b', '/api/diagrams/a%2Fb'],
    ['a query delimiter', 'a?b', '/api/diagrams/a%3Fb'],
    ['a space', 'a b', '/api/diagrams/a%20b']
  ])('encodes %s in the path', async (_label, id, expected) => {
    const fetchMock = stubFetch(jsonResponse({ diagram: DIAGRAM }));

    await getDiagram(id);

    expect(fetchMock).toHaveBeenCalledWith(expected, expect.anything());
  });

  it('creates a diagram with the payload it was given', async () => {
    const fetchMock = stubFetch(jsonResponse({ diagram: DIAGRAM }, 201));

    expect(await createDiagram({ blueprintId: 'api-gateway', title: 'New' })).toEqual(DIAGRAM);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/diagrams',
      expect.objectContaining({
        body: JSON.stringify({ blueprintId: 'api-gateway', title: 'New' }),
        method: 'POST'
      })
    );
  });

  it('updates metadata with PATCH', async () => {
    const fetchMock = stubFetch(jsonResponse({ diagram: DIAGRAM }));

    await updateDiagram('d1', { title: 'Renamed' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/diagrams/d1',
      expect.objectContaining({ body: JSON.stringify({ title: 'Renamed' }), method: 'PATCH' })
    );
  });

  // `null` has to survive serialisation: it is how the client asks the server to clear the field,
  // and an implementation that stripped undefined-ish values would silently drop the request.
  it('sends an explicit null description when clearing it', async () => {
    const fetchMock = stubFetch(jsonResponse({ diagram: DIAGRAM }));

    await updateDiagram('d1', { description: null });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/diagrams/d1',
      expect.objectContaining({ body: JSON.stringify({ description: null }) })
    );
  });

  it('saves a graph with PUT and returns the new timestamp', async () => {
    const fetchMock = stubFetch(jsonResponse({ updatedAt: '2026-02-01T00:00:00.000Z' }));

    expect(await saveDiagramGraph('d1', '{"nodes":[]}')).toBe('2026-02-01T00:00:00.000Z');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/diagrams/d1/graph',
      expect.objectContaining({
        body: JSON.stringify({ graphData: '{"nodes":[]}' }),
        method: 'PUT'
      })
    );
  });

  // One request, not a read-create-save sequence: that sequence leaves an empty diagram behind if
  // its middle step fails.
  it('duplicates through the server in a single request', async () => {
    const fetchMock = stubFetch(jsonResponse({ diagram: DIAGRAM }, 201));

    expect(await duplicateDiagram('d1')).toEqual(DIAGRAM);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/diagrams/d1/duplicate',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('deletes with DELETE and tolerates the empty 204 body', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));

    await expect(deleteDiagram('d1')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/diagrams/d1',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  // Not CORS-safelisted, so requiring it server-side means a cross-origin form submission cannot
  // reach a mutating endpoint at all. The client has to actually send it.
  it('declares an exact JSON content type on every call', async () => {
    const fetchMock = stubFetch(jsonResponse({ diagrams: [] }));

    await listDiagrams();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/diagrams',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } })
    );
  });
});

describe('failures', () => {
  it('raises the server\u2019s own RFC 9457 detail', async () => {
    stubFetch(jsonResponse({ detail: 'Diagram not found.', status: 404 }, 404));

    await expect(getDiagram('d1')).rejects.toThrow('Diagram not found.');
  });

  it('falls back to the problem title when there is no detail', async () => {
    stubFetch(jsonResponse({ status: 404, title: 'Not Found' }, 404));

    await expect(getDiagram('d1')).rejects.toThrow('Not Found');
  });

  it.each([
    ['an unparseable body', new Response('<html>502</html>', { status: 502 })],
    ['an empty body', new Response(null, { status: 500 })],
    ['a non-object body', new Response('"a string"', { status: 500 })]
  ])('reports a generic failure for %s', async (_label, response) => {
    stubFetch(response);

    await expect(getDiagram('d1')).rejects.toThrow('The request could not be completed.');
  });

  it('reports a failed delete rather than resolving quietly', async () => {
    stubFetch(jsonResponse({ detail: 'Diagram not found.' }, 404));

    await expect(deleteDiagram('d1')).rejects.toThrow('Diagram not found.');
  });

  // A successful response that does not carry its documented field is an error here, not an
  // `undefined` handed to a component to fail on later.
  it.each([
    ['listDiagrams', async () => listDiagrams()],
    ['getDiagram', async () => getDiagram('d1')],
    ['createDiagram', async () => createDiagram({})],
    ['updateDiagram', async () => updateDiagram('d1', { title: 'x' })],
    ['saveDiagramGraph', async () => saveDiagramGraph('d1', '{}')],
    ['duplicateDiagram', async () => duplicateDiagram('d1')]
  ])('reports an unexpected response from %s', async (_label, call) => {
    stubFetch(jsonResponse({ somethingElse: true }));

    await expect(call()).rejects.toThrow('The server returned an unexpected response.');
  });

  it.each([
    ['listDiagrams', async () => listDiagrams()],
    ['getDiagram', async () => getDiagram('d1')],
    ['createDiagram', async () => createDiagram({})]
  ])('reports an unreadable successful body from %s', async (_label, call) => {
    stubFetch(new Response('not json', { status: 200 }));

    await expect(call()).rejects.toThrow('The server returned an unexpected response.');
  });

  it('propagates a network failure rather than swallowing it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    await expect(listDiagrams()).rejects.toThrow('Failed to fetch');
  });
});

describe('diagramLiveUrl', () => {
  /**
   * Points `window.location.href` at an origin, so the scheme can be derived from it.
   *
   * @param href Page URL to pretend the browser is on.
   */
  function onPage(href: string): void {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, href },
      writable: true
    });
  }

  // The scheme is derived rather than written as a literal, so the socket is secure exactly when
  // the page was.
  it.each([
    ['https:', 'https://diagrams.example/app/diagrams/d1', 'wss://diagrams.example'],
    ['http:', 'http://localhost:5173/app/diagrams/d1', 'ws://localhost:5173']
  ])('uses the page’s own %s scheme', (_label, href, expectedOrigin) => {
    onPage(href);

    expect(diagramLiveUrl('d1')).toBe(`${expectedOrigin}/api/diagrams/d1/live`);
  });

  it('escapes the diagram id', () => {
    onPage('https://diagrams.example/app');

    expect(diagramLiveUrl('a b/c')).toBe('wss://diagrams.example/api/diagrams/a%20b%2Fc/live');
  });

  // No credential in the URL. A browser's `WebSocket` constructor cannot set headers, so an API
  // expecting a bearer token here would have to put it in the query string, where it would land
  // in every proxy log. The Access cookie travels on the upgrade automatically instead.
  it('carries no credential', () => {
    onPage('https://diagrams.example/app');

    expect(diagramLiveUrl('d1')).not.toContain('?');
  });
});
