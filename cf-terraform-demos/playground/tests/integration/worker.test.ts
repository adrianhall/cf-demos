import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';
import { TASK_DESCRIPTORS } from '../../src/tasks';

/**
 * Audience the Worker is configured to accept, matching `ACCESS_AUD` in `./vitest.config.ts`.
 */
const AUD = 'a'.repeat(64);

/**
 * Build a request carrying a development Access JWT for one identity.
 *
 * @param email Identity to sign the token for.
 * @param path API path to request.
 * @param audience Audience to mint the token for. Defaults to the audience the Worker accepts; a
 *   test overrides it to prove cross-application tokens are refused.
 * @returns A request ready to dispatch through the Worker.
 */
async function requestAs(email: string, path: string, audience: string = AUD): Promise<Request> {
  const token = await signDevJwt(email, { audience });
  return new Request(`https://playground.example${path}`, {
    headers: { [JWT_HEADER]: token }
  });
}

/**
 * Dispatch a request through the Worker under test.
 *
 * @param request Request to dispatch.
 * @returns The Worker's response.
 */
async function send(request: Request): Promise<Response> {
  return exports.default.fetch(request);
}

describe('authentication', () => {
  // The Playground has no anonymous surface, and that matters more here than in a read-only demo:
  // every panel can spend real inference credit against a shared account.
  it.each(['/api/me', '/api/catalogue'])('refuses %s without a token', async (path) => {
    const response = await send(new Request(`https://playground.example${path}`));
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });

  // Two identities, because the demo's attribution story depends on the Worker distinguishing
  // them. A harness that only ever signs in as one user could not catch an identity being pinned
  // or cached across requests.
  it.each(['alice@example.com', 'bob@example.com'])(
    'accepts %s and reports them back',
    async (email) => {
      const response = await send(await requestAs(email, '/api/me'));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ email });
    }
  );

  // Every Access application in a team shares one JWKS, so without an audience check a token
  // minted for an unrelated application in the same team would be accepted here too.
  it('refuses a token minted for a different Access application', async () => {
    const response = await send(await requestAs('alice@example.com', '/api/me', 'b'.repeat(64)));
    expect(response.status).toBe(401);
  });
});

describe('GET /api/catalogue', () => {
  it('returns every panel to an authenticated caller', async () => {
    const response = await send(await requestAs('alice@example.com', '/api/catalogue'));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      tasks: { id: string; name: string; gateway: string }[];
      models: { task: string }[];
      gatewayExceptions: unknown[];
    };

    expect(body.tasks).toHaveLength(TASK_DESCRIPTORS.length);
    expect(body.gatewayExceptions).toEqual([
      expect.objectContaining({ id: 'flux-2-workers-ai-multipart-stream', panel: 'Remix Image' })
    ]);

    // A reviewed model is only advertised for a panel that is built, so the catalogue never offers
    // a choice that goes nowhere.
    const delivered = new Set(
      TASK_DESCRIPTORS.filter((task) => task.availability === 'available').map((task) => task.id)
    );
    for (const model of body.models) {
      expect(delivered.has(model.task as (typeof TASK_DESCRIPTORS)[number]['id'])).toBe(true);
    }
  });

  it('marks every inference panel as gateway-routed', async () => {
    const response = await send(await requestAs('alice@example.com', '/api/catalogue'));
    const body = (await response.json()) as { tasks: { id: string; gateway: string }[] };

    const exempt = body.tasks.filter((task) => task.gateway !== 'required');
    expect(exempt.map((task) => task.id)).toEqual(['view-tokens']);
  });
});

describe('unknown routes', () => {
  // An unmatched API path must answer with a problem document, not an HTML page or an empty body:
  // the single-page application parses every API failure the same way.
  it('answers an unknown API path with problem details', async () => {
    const response = await send(await requestAs('alice@example.com', '/api/nonexistent'));
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });

  // A deployed Worker must never emit a stack trace. `includeStack` is gated on
  // `import.meta.env.DEV`, and this asserts the gate holds for the built Worker under test.
  it('leaks no stack trace in an error response', async () => {
    const response = await send(await requestAs('alice@example.com', '/api/nonexistent'));
    const text = await response.text();
    expect(text).not.toContain('at ');
    expect(text).not.toContain('.ts:');
  });
});
