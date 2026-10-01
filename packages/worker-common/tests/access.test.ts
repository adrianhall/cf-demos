import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { problemDetailsErrorHandler, type PathPolicy } from '@adrianhall/cloudflare-toolkit/hono';
import type { CloudflareToolkitVariables } from '@adrianhall/cloudflare-toolkit/hono';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';
import { createAccessMiddleware } from '../src/access.ts';
import { currentIdentityEmail } from '../src/identity.ts';

const AUDIENCE = 'test-audience-tag';
const OTHER_AUDIENCE = 'another-application-in-the-same-team';

type TestEnv = {
  Bindings: { ACCESS_AUD?: string };
  Variables: CloudflareToolkitVariables;
};

/**
 * Policy list mirroring the shape every demo uses: a fetch-only API prefix and a redirecting page
 * catch-all, both carrying the audience.
 */
function buildPolicies(audience: string): PathPolicy[] {
  return [
    { pattern: /^\/api(?:\/|$)/u, authenticate: true, redirect: false, audience },
    { pattern: /^\//u, authenticate: true, redirect: true, audience }
  ];
}

/**
 * Build an app behind the shared Access middleware.
 */
function buildApp(
  options: {
    enableDevTokens?: boolean;
    policies?: (audience: string) => PathPolicy[];
  } = {}
): Hono<TestEnv> {
  const app = new Hono<TestEnv>();

  app.use(
    createAccessMiddleware<TestEnv>({
      buildPolicies: options.policies ?? buildPolicies,
      enableDevTokens: options.enableDevTokens ?? true
    })
  );
  app.get('/api/me', (context) => context.json({ email: currentIdentityEmail(context) }));
  app.onError(problemDetailsErrorHandler());
  return app;
}

/**
 * Bindings for one request, standing in for what Terraform publishes to the Worker.
 */
function bindings(accessAud: string | undefined): { ACCESS_AUD?: string } {
  return accessAud === undefined ? {} : { ACCESS_AUD: accessAud };
}

/**
 * Dispatch a request carrying a development JWT minted for the given audience.
 */
async function requestAs(
  app: Hono<TestEnv>,
  email: string,
  options: { path?: string; audience?: string | undefined; accessAud?: string | undefined } = {}
): Promise<Response> {
  const audience = 'audience' in options ? options.audience : AUDIENCE;
  const accessAud = 'accessAud' in options ? options.accessAud : AUDIENCE;
  const token = await signDevJwt(email, audience === undefined ? {} : { audience });

  return app.request(
    options.path ?? '/api/me',
    { headers: { [JWT_HEADER]: token } },
    bindings(accessAud)
  );
}

describe('createAccessMiddleware', () => {
  it('admits a valid token minted for this application', async () => {
    const response = await requestAs(buildApp(), 'user@example.com');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: 'user@example.com' });
  });

  it('rejects an unauthenticated request with a 401 problem detail', async () => {
    const response = await buildApp().request('/api/me', undefined, bindings(AUDIENCE));

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });

  it('rejects a token minted for a different application in the same team', async () => {
    // The whole point of threading the audience through: every Access application in a team
    // shares one JWKS, so this token's signature is valid but its `aud` claim is not ours.
    const response = await requestAs(buildApp(), 'user@example.com', {
      audience: OTHER_AUDIENCE
    });

    expect(response.status).toBe(401);
  });

  it('rejects a token carrying no audience claim at all', async () => {
    const response = await requestAs(buildApp(), 'user@example.com', { audience: undefined });

    expect(response.status).toBe(401);
  });

  it('blocks a path no policy matches, rather than letting it through', async () => {
    const app = buildApp({
      // Deliberately covers only `/api`, leaving every other path unmatched.
      policies: (audience) => [
        { pattern: /^\/api(?:\/|$)/u, authenticate: true, redirect: false, audience }
      ]
    });
    app.get('/unlisted', (context) => context.text('reached'));

    const response = await app.request('/unlisted', undefined, bindings(AUDIENCE));
    expect(response.status).toBe(401);
  });

  it('refuses to serve traffic when ACCESS_AUD is not bound', async () => {
    const response = await requestAs(buildApp(), 'user@example.com', { accessAud: undefined });

    // A misconfigured deployment must fail rather than run without audience validation.
    expect(response.status).toBe(500);
  });

  it('refuses to serve traffic when ACCESS_AUD is bound but empty', async () => {
    const response = await requestAs(buildApp(), 'user@example.com', { accessAud: '' });
    expect(response.status).toBe(500);
  });

  it('rejects a development token when development tokens are disabled', async () => {
    // Mirrors a production build, where `import.meta.env.DEV` is statically `false`.
    const response = await requestAs(buildApp({ enableDevTokens: false }), 'user@example.com');

    expect(response.status).toBe(401);
  });

  it('builds the policy list once per audience rather than per request', async () => {
    const policies = vi.fn(buildPolicies);
    const app = buildApp({ policies });

    await requestAs(app, 'user@example.com');
    await requestAs(app, 'user@example.com');
    await requestAs(app, 'someone-else@example.com');

    expect(policies).toHaveBeenCalledTimes(1);
    expect(policies).toHaveBeenCalledWith(AUDIENCE);
  });
});
