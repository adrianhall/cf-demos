import { applyD1Migrations } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';

/**
 * Test-only bindings injected by the integration Vitest project (`./vitest.config.ts`).
 */
interface TestEnv extends Env {
  /**
   * Parsed D1 migrations used to build the schema in Miniflare's otherwise empty database.
   */
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/**
 * Audience the Worker is configured to accept, matching `ACCESS_AUD` in `./vitest.config.ts`.
 */
const AUD = 'a'.repeat(64);

/**
 * A deliberately fictional host. Derived from nothing and routable nowhere, so this suite can never
 * address a real deployment — see `scripts/naming-contract.ts` for why that matters here more than
 * it would in a sibling demo.
 */
const ORIGIN = 'https://diagrams.test';

const testEnv = env as TestEnv;

const ALICE = 'alice@example.com';

/**
 * Builds a request carrying a development Access JWT for one identity.
 *
 * @param email Identity to sign the token for.
 * @param path API path to request.
 * @param init Additional request options.
 * @param audience Audience to mint the token for. Defaults to the audience the Worker accepts; a
 *   test overrides it to prove cross-application tokens are refused.
 * @returns A request ready to dispatch through the Worker.
 */
async function requestAs(
  email: string,
  path: string,
  init: RequestInit = {},
  audience: string = AUD
): Promise<Request> {
  const token = await signDevJwt(email, { audience });
  const headers = new Headers(init.headers);
  headers.set(JWT_HEADER, token);
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

/**
 * Dispatches a request through the Worker under test.
 *
 * @param request Request to dispatch.
 * @returns The Worker's response.
 */
async function send(request: Request): Promise<Response> {
  return exports.default.fetch(request);
}

describe('Architect Worker', () => {
  beforeAll(async () => {
    // Builds the schema from the real migration SQL, so a broken migration fails these tests
    // rather than only failing a deploy.
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  describe('schema', () => {
    it.each(['diagrams', 'users'])('creates the %s table', async (table) => {
      const row = await testEnv.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
        .bind(table)
        .first<{ name: string }>();

      expect(row?.name).toBe(table);
    });

    // Not an omission. Exactly one identity is the administrator, named by the operator-configured
    // ADMIN_EMAIL Worker variable, so there is no role column for an attacker with write access to
    // this table to set.
    it('gives the users table no administrator column', async () => {
      const columns = await testEnv.DB.prepare('PRAGMA table_info(users)').all<{ name: string }>();

      expect(columns.results.map((column) => column.name)).toEqual([
        'email',
        'display_name',
        'first_seen_at',
        'last_seen_at'
      ]);
    });

    it('indexes the ownership predicate that enforces per-user isolation', async () => {
      const row = await testEnv.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'diagrams_owner_email_idx'"
      ).first<{ name: string }>();

      expect(row?.name).toBe('diagrams_owner_email_idx');
    });
  });

  describe('public surface', () => {
    it('answers the health probe without an identity', async () => {
      const response = await send(new Request(`${ORIGIN}/api/health`));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
    });

    it('answers the health probe for a signed-in caller too', async () => {
      const response = await send(await requestAs(ALICE, '/api/health'));

      expect(response.status).toBe(200);
    });
  });

  describe('authentication', () => {
    it('rejects an unauthenticated request to a protected API with 401', async () => {
      const response = await send(new Request(`${ORIGIN}/api/me`));

      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    });

    // The defence this demo most needs to prove: every Access application in a team shares one
    // JWKS, so a correctly signed token minted for a different application passes signature
    // validation. The audience check is the only thing that refuses it.
    it('rejects a valid token minted for a different Access application', async () => {
      const response = await send(await requestAs(ALICE, '/api/me', {}, 'b'.repeat(64)));

      expect(response.status).toBe(401);
    });

    it('accepts a token for the configured audience', async () => {
      const response = await send(await requestAs(ALICE, '/api/me'));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ email: ALICE });
    });

    // An API caller must receive a status it can render, not the HTML of a login page. This is
    // what `redirect: false` in the shared policy list buys, and it is asserted against an
    // `Accept: text/html` request because that is the case that would otherwise redirect.
    it('answers an HTML-accepting API caller with JSON rather than a login redirect', async () => {
      const response = await send(
        new Request(`${ORIGIN}/api/me`, { headers: { Accept: 'text/html' } })
      );

      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
      expect(response.headers.get('location')).toBeNull();
    });
  });

  describe('error shape', () => {
    it('answers an unknown API route with an RFC 9457 problem document', async () => {
      const response = await send(await requestAs(ALICE, '/api/nope'));

      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    });

    it('leaks no stack trace', async () => {
      const response = await send(await requestAs(ALICE, '/api/nope'));
      const body = (await response.json()) as Record<string, unknown>;

      expect(body).toMatchObject({ status: 404 });
      expect(body).not.toHaveProperty('stack');
    });
  });
});
