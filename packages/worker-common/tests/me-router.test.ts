import { Hono, type MiddlewareHandler } from 'hono';
import { describe, expect, it } from 'vitest';
import { forbidden } from '@adrianhall/cloudflare-toolkit/errors';
import { problemDetailsErrorHandler } from '@adrianhall/cloudflare-toolkit/hono';
import type {
  CloudflareAccessIdentity,
  CloudflareToolkitVariables
} from '@adrianhall/cloudflare-toolkit/hono';
import { createMeRouter, type MeRouterOptions } from '../src/me-router.ts';

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

  describe('additionalFields', () => {
    /**
     * Mount the router with an `additionalFields` deriver behind a verified-identity stub.
     *
     * @param additionalFields Deriver under test.
     * @returns An application answering `GET /api/me`.
     */
    function buildAppWithFields(
      additionalFields: NonNullable<MeRouterOptions<TestEnv>['additionalFields']>
    ): Hono<TestEnv> {
      const app = new Hono<TestEnv>();
      app.use(async (context, next) => {
        context.set('Cloudflare_Access_Identity', VERIFIED);
        await next();
      });
      app.route('/api/me', createMeRouter<TestEnv>({ additionalFields }));
      app.onError(problemDetailsErrorHandler());
      return app;
    }

    it('adds a derived field alongside the verified email', async () => {
      const response = await buildAppWithFields(() => ({ isAdmin: true })).request('/api/me');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ email: 'user@example.com', isAdmin: true });
    });

    it('derives the field from the request context', async () => {
      const response = await buildAppWithFields((context) => ({
        isAdmin: context.get('Cloudflare_Access_Identity')?.email === 'someone-else@example.com'
      })).request('/api/me');

      expect(await response.json()).toEqual({ email: 'user@example.com', isAdmin: false });
    });

    // The endpoint's entire value is that `email` is the server's own verified answer. A deriver
    // that could overwrite it would turn this into a field the caller's application code chooses,
    // which is exactly what a client must not be able to influence.
    it('never lets a derived field override the verified email', async () => {
      const response = await buildAppWithFields(() => ({ email: 'attacker@example.com' })).request(
        '/api/me'
      );

      expect(await response.json()).toEqual({ email: 'user@example.com' });
    });

    it('reports only the email when no deriver is configured', async () => {
      const response = await buildApp(VERIFIED).request('/api/me');

      expect(await response.json()).toEqual({ email: 'user@example.com' });
    });
  });
});
