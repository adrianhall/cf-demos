import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { problemDetailsErrorHandler } from '@adrianhall/cloudflare-toolkit/hono';
import type {
  CloudflareAccessIdentity,
  CloudflareToolkitVariables
} from '@adrianhall/cloudflare-toolkit/hono';
import { currentIdentity, currentIdentityEmail } from '../src/identity.ts';

type TestEnv = { Bindings: Record<string, never>; Variables: CloudflareToolkitVariables };

const VERIFIED: CloudflareAccessIdentity = {
  email: 'user@example.com',
  source: 'cookie',
  sub: 'user-sub-1'
};

/**
 * Build an app that optionally seeds a verified identity, then exposes both accessors.
 */
function buildApp(identity?: CloudflareAccessIdentity): Hono<TestEnv> {
  const app = new Hono<TestEnv>();

  if (identity !== undefined) {
    app.use(async (context, next) => {
      context.set('Cloudflare_Access_Identity', identity);
      await next();
    });
  }

  app.get('/email', (context) => context.json({ email: currentIdentityEmail(context) }));
  app.get('/identity', (context) => context.json({ identity: currentIdentity(context) }));
  app.onError(problemDetailsErrorHandler());
  return app;
}

describe('currentIdentity', () => {
  it('returns the whole verified identity', async () => {
    const response = await buildApp(VERIFIED).request('/identity');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ identity: VERIFIED });
  });

  it('fails when no identity was verified, rather than returning an anonymous one', async () => {
    const response = await buildApp().request('/identity');
    expect(response.status).toBe(500);
  });
});

describe('currentIdentityEmail', () => {
  it("returns the verified identity's email address", async () => {
    const response = await buildApp(VERIFIED).request('/email');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: 'user@example.com' });
  });

  it('fails when no identity was verified', async () => {
    const response = await buildApp().request('/email');
    expect(response.status).toBe(500);
  });

  it('ignores any caller-supplied identity in the request itself', async () => {
    // The accessor must read only the verified variable, never a header a client can set.
    const response = await buildApp(VERIFIED).request('/email', {
      headers: {
        'Cf-Access-Authenticated-User-Email': 'attacker@example.com',
        'X-Forwarded-Email': 'attacker@example.com'
      }
    });

    expect(await response.json()).toEqual({ email: 'user@example.com' });
  });
});
