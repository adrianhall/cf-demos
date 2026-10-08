import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { problemDetailsErrorHandler } from '@adrianhall/cloudflare-toolkit/hono';
import { enforceSameOriginJson } from '../../src/worker/middleware/same-origin.ts';

/**
 * @file Covers the request-forgery and media-type guard every mutation passes through. The cases
 *   worth writing down are the _absences_: a request with no origin signal at all, and a
 *   body-carrying method with no JSON content type. Both must fail, because a check that only
 *   rejects a wrong value is bypassed by sending no value.
 */

/**
 * Origin the test application is served from. Clearly fictional and routable nowhere, so this suite
 * can never address a real deployment.
 */
const ORIGIN = 'https://diagrams.test';

/**
 * A different origin, standing in for an attacker's page.
 */
const FOREIGN_ORIGIN = 'https://attacker.test';

/**
 * Builds an application whose every method is guarded by the middleware under test.
 *
 * @returns An application answering any method on `/api/thing` or `/mcp` with `204`, if the guard
 *   admits it.
 */
function buildApp(): Hono {
  const app = new Hono();
  app.use(enforceSameOriginJson);
  app.all('/api/thing', (context) => context.body(null, 204));
  // This is deliberately only a middleware test, not an authentication test. The real application
  // has Access ahead of the guard; this route pins only the fact that the non-browser MCP request
  // reaches the handler, so a later tightening cannot silently make every tool call answer 403.
  app.all('/mcp', (context) => context.body(null, 204));
  app.onError(problemDetailsErrorHandler());
  return app;
}

/**
 * Dispatches a request through the guarded application.
 *
 * @param method HTTP method to use.
 * @param headers Headers to send.
 * @param path Path whose guard behaviour to exercise.
 * @returns The response.
 */
async function send(
  method: string,
  headers: Record<string, string> = {},
  path: '/api/thing' | '/mcp' = '/api/thing'
): Promise<Response> {
  return buildApp().request(`${ORIGIN}${path}`, { headers, method });
}

describe('enforceSameOriginJson', () => {
  describe('the bearer-authenticated MCP carve-out', () => {
    // An MCP client is not a browser and sends neither `Origin` nor `Sec-Fetch-Site`. This stays
    // admitted because the route is authenticated by Access before this middleware runs; a future
    // change that removes the path check would otherwise turn every tool call into a misleading
    // `403 Cross-origin requests are not permitted.` response.
    it('admits a POST to /mcp carrying neither browser origin signal nor a JSON content type', async () => {
      const response = await send('POST', {}, '/mcp');

      expect(response.status).toBe(204);
    });

    // Exact pathname only: `/mcp/anything` is not a route this phase serves and must not become an
    // accidental bypass for a later browser-facing mutation endpoint just because it shares a
    // prefix with MCP.
    it('does not exempt another path sharing the MCP prefix', async () => {
      const app = new Hono();
      app.use(enforceSameOriginJson);
      app.all('/mcp/anything', (context) => context.body(null, 204));
      app.onError(problemDetailsErrorHandler());

      const response = await app.request(`${ORIGIN}/mcp/anything`, { method: 'POST' });

      expect(response.status).toBe(403);
    });
  });

  describe('safe methods', () => {
    // A cross-origin page may legitimately cause these, and the browser's own rules stop it reading
    // the response. Guarding them would reject an ordinary anonymous page load.
    it.each(['GET', 'HEAD'])('admits %s with no origin signal at all', async (method) => {
      expect((await send(method)).status).toBe(204);
    });

    it.each(['GET', 'HEAD'])('admits %s from a foreign origin', async (method) => {
      expect((await send(method, { origin: FOREIGN_ORIGIN })).status).toBe(204);
    });
  });

  describe('Sec-Fetch-Site', () => {
    // Preferred over `Origin` because the browser sets it and page JavaScript cannot.
    it('admits a same-origin request', async () => {
      const response = await send('DELETE', { 'sec-fetch-site': 'same-origin' });

      expect(response.status).toBe(204);
    });

    it.each(['cross-site', 'same-site', 'none'])('rejects a %s request', async (site) => {
      const response = await send('DELETE', { 'sec-fetch-site': site });

      expect(response.status).toBe(403);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    });

    // The header a browser sets wins over one a page can set. A forged `Origin` paired with a
    // truthful `Sec-Fetch-Site` must not get through.
    it('prefers Sec-Fetch-Site over a matching Origin header', async () => {
      const response = await send('DELETE', {
        'origin': ORIGIN,
        'sec-fetch-site': 'cross-site'
      });

      expect(response.status).toBe(403);
    });
  });

  describe('Origin fallback', () => {
    it('admits a request whose Origin is exactly this origin', async () => {
      expect((await send('DELETE', { origin: ORIGIN })).status).toBe(204);
    });

    it('rejects a foreign Origin', async () => {
      expect((await send('DELETE', { origin: FOREIGN_ORIGIN })).status).toBe(403);
    });

    // Compared exactly rather than by prefix. Each of these is a different origin that a
    // `startsWith` comparison would wrongly admit.
    it.each([
      'https://diagrams.test.attacker.test',
      'http://diagrams.test',
      'https://diagrams.test:8443',
      'https://sub.diagrams.test'
    ])('rejects the similar origin %s', async (origin) => {
      expect((await send('DELETE', { origin })).status).toBe(403);
    });

    // The case a check that only rejects a *wrong* origin would miss entirely. A legitimate
    // same-origin browser fetch always sends at least one signal, so sending neither marks a
    // non-browser or forged request.
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
      'rejects %s carrying neither origin signal',
      async (method) => {
        expect((await send(method)).status).toBe(403);
      }
    );
  });

  describe('JSON media type', () => {
    it.each(['POST', 'PUT', 'PATCH'])('admits %s declaring application/json', async (method) => {
      const response = await send(method, {
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin'
      });

      expect(response.status).toBe(204);
    });

    it.each(['application/json; charset=utf-8', 'APPLICATION/JSON'])(
      'admits the equivalent content type %s',
      async (contentType) => {
        const response = await send('POST', {
          'content-type': contentType,
          'sec-fetch-site': 'same-origin'
        });

        expect(response.status).toBe(204);
      }
    );

    // `application/json` is not CORS-safelisted, so requiring it means a cross-origin form
    // submission — which can only send a safelisted type — cannot reach a mutating endpoint at all.
    // `application/jsonp` and `application/json-patch+json` are the near-misses that matter: a
    // `startsWith` comparison admits both, and neither is the media type this API accepts.
    it.each([
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data',
      'application/jsonp',
      'application/json-patch+json',
      'text/json'
    ])('rejects the non-JSON content type %s with 415', async (contentType) => {
      const response = await send('POST', {
        'content-type': contentType,
        'sec-fetch-site': 'same-origin'
      });

      expect(response.status).toBe(415);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    });

    it.each(['POST', 'PUT', 'PATCH'])(
      'rejects %s declaring no content type at all',
      async (method) => {
        const response = await send(method, { 'sec-fetch-site': 'same-origin' });

        expect(response.status).toBe(415);
      }
    );

    // `DELETE` changes state, so it needs the origin check — but it carries no body, so demanding a
    // JSON content type from it would reject a perfectly well-formed request.
    it('requires no content type for DELETE', async () => {
      const response = await send('DELETE', { 'sec-fetch-site': 'same-origin' });

      expect(response.status).toBe(204);
    });
  });

  describe('check order', () => {
    // The origin check runs first, so a cross-origin request is refused as `403` without its
    // content type being considered. Reporting `415` there would tell an attacker their forged
    // request reached the media-type stage.
    it('reports a cross-origin request as 403 even when its content type is also wrong', async () => {
      const response = await send('POST', {
        'content-type': 'text/plain',
        'origin': FOREIGN_ORIGIN
      });

      expect(response.status).toBe(403);
    });
  });
});
