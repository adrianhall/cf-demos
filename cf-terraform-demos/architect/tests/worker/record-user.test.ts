import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { CloudflareAccessIdentity } from '@adrianhall/cloudflare-toolkit/hono';
import { UserService } from '../../src/worker/application/user-service.ts';
import type { AppBindings } from '../../src/worker/bindings.ts';
import { recordUserMiddleware } from '../../src/worker/middleware/record-user.ts';

/**
 * @file Covers the directory side effect of authentication. Three properties make it safe to mount
 *   in the request path, and each is a test below: it writes nothing for an anonymous caller, it
 *   cannot fail the request, and a failure is still visible in observability rather than silently
 *   swallowed.
 */

/**
 * A verified identity, as the Access middleware would have set it.
 */
const VERIFIED: CloudflareAccessIdentity = {
  email: 'alice@example.com',
  source: 'cookie',
  sub: 'alice-sub'
};

/**
 * Builds an application with the middleware mounted behind a stubbed identity and service.
 *
 * @param identity Identity to seed, or `undefined` to simulate an anonymous request.
 * @param service Service the middleware should call.
 * @returns The application and the logger spy the middleware writes to.
 */
function buildApp(
  identity: CloudflareAccessIdentity | undefined,
  service: UserService
): { app: Hono<AppBindings>; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const app = new Hono<AppBindings>();

  app.use(async (context, next) => {
    context.set('USER_SERVICE', service);
    context.set('LOGGER', { warn } as never);
    if (identity !== undefined) {
      context.set('Cloudflare_Access_Identity', identity);
    }
    await next();
  });
  app.use(recordUserMiddleware);
  app.get('/api/thing', (context) => context.json({ ok: true }));

  return { app, warn };
}

/**
 * Builds a service whose write succeeds or fails.
 *
 * @param succeeds Whether the underlying write succeeds.
 * @returns The service, and the spy standing in for its repository.
 */
function serviceThatWrites(succeeds: boolean): {
  service: UserService;
  recordSeen: ReturnType<typeof vi.fn>;
} {
  const recordSeen = vi.fn(async () => {
    if (!succeeds) {
      throw new Error('D1 unavailable');
    }
  });
  return { recordSeen, service: new UserService({ recordSeen }) };
}

describe('recordUserMiddleware', () => {
  it('records the verified identity and continues to the route', async () => {
    const { recordSeen, service } = serviceThatWrites(true);
    const { app } = buildApp(VERIFIED, service);

    const response = await app.request('http://diagrams.test/api/thing');

    expect(response.status).toBe(200);
    expect(recordSeen).toHaveBeenCalledWith(VERIFIED.email, expect.any(String));
  });

  // A public route reaching this middleware — the health probe, and later the anonymous share
  // resolver — must leave no trace, or the administrative view would list identities that never
  // signed in.
  it('writes nothing for an anonymous request', async () => {
    const { recordSeen, service } = serviceThatWrites(true);
    const { app } = buildApp(undefined, service);

    const response = await app.request('http://diagrams.test/api/thing');

    expect(response.status).toBe(200);
    expect(recordSeen).not.toHaveBeenCalled();
  });

  // The directory is a convenience, not a dependency. A failed write must not turn a cosmetic
  // storage problem into an outage for every authenticated request.
  it('serves the request normally when the directory write fails', async () => {
    const { service } = serviceThatWrites(false);
    const { app } = buildApp(VERIFIED, service);

    const response = await app.request('http://diagrams.test/api/thing');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  // Absorbed is not the same as ignored. A persistently unwritable directory should be visible in
  // observability, rather than only as a mysteriously empty administrative table.
  it('logs a warning when the directory write fails', async () => {
    const { service } = serviceThatWrites(false);
    const { app, warn } = buildApp(VERIFIED, service);

    await app.request('http://diagrams.test/api/thing');

    expect(warn).toHaveBeenCalledWith('user_directory_write_failed', { email: VERIFIED.email });
  });

  it('logs nothing when the directory write succeeds', async () => {
    const { service } = serviceThatWrites(true);
    const { app, warn } = buildApp(VERIFIED, service);

    await app.request('http://diagrams.test/api/thing');

    expect(warn).not.toHaveBeenCalled();
  });
});
