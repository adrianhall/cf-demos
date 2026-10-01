import { Hono, type MiddlewareHandler } from 'hono';
import { describe, expect, it } from 'vitest';
import { forbidden } from '@adrianhall/cloudflare-toolkit/errors';
import { problemDetailsErrorHandler } from '@adrianhall/cloudflare-toolkit/hono';
import type {
  CloudflareAccessIdentity,
  CloudflareToolkitVariables
} from '@adrianhall/cloudflare-toolkit/hono';
import { createMeRouter } from '../src/me-router.ts';

type TestEnv = { Bindings: Record<string, never>; Variables: CloudflareToolkitVariables };

const VERIFIED: CloudflareAccessIdentity = {
  email: 'user@example.com',
  source: 'cookie',
  sub: 'user-sub-1'
};

/**
 * Mount the router behind a stub that seeds a verified identity, as the Access middleware would.
 */
function buildApp(
  identity: CloudflareAccessIdentity | undefined,
  middleware?: MiddlewareHandler<TestEnv>[]
): Hono<TestEnv> {
  const app = new Hono<TestEnv>();

  if (identity !== undefined) {
    app.use(async (context, next) => {
      context.set('Cloudflare_Access_Identity', identity);
      await next();
    });
  }

  app.route('/api/me', createMeRouter<TestEnv>(middleware === undefined ? {} : { middleware }));
  app.onError(problemDetailsErrorHandler());
  return app;
}

describe('createMeRouter', () => {
  it("reports the verified identity's email", async () => {
    const response = await buildApp(VERIFIED).request('/api/me');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: 'user@example.com' });
  });

  it('reports only the email, never the whole identity', async () => {
    const response = await buildApp(VERIFIED).request('/api/me');

    // `sub` and `source` are server-side detail and must not leak to a browser.
    expect(Object.keys((await response.json()) as object)).toEqual(['email']);
  });

  it('fails when mounted without the Access middleware', async () => {
    const response = await buildApp(undefined).request('/api/me');
    expect(response.status).toBe(500);
  });

  it('runs caller-supplied middleware before the handler', async () => {
    const denyEveryone: MiddlewareHandler<TestEnv> = () => {
      throw forbidden({ detail: 'Not the configured administrator.' });
    };

    const response = await buildApp(VERIFIED, [denyEveryone]).request('/api/me');

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      detail: 'Not the configured administrator.'
    });
  });

  it('admits the request when caller-supplied middleware passes', async () => {
    const allow: MiddlewareHandler<TestEnv> = async (_context, next) => {
      await next();
    };

    const response = await buildApp(VERIFIED, [allow]).request('/api/me');
    expect(response.status).toBe(200);
  });
});
