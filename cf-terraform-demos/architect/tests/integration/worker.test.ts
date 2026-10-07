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

/**
 * An ordinary signed-in owner. Never the administrator, which is what makes it the right identity
 * for every "a valid identity is still refused" assertion.
 */
const ALICE = 'alice@example.com';

/**
 * A second ordinary owner, used where two distinct non-administrator identities are needed.
 */
const BOB = 'bob@example.com';

/**
 * The configured administrator, matching `ADMIN_EMAIL` in `./vitest.config.ts`.
 */
const ADMIN = 'admin@example.com';

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
      expect(await response.json()).toEqual({ email: ALICE, isAdmin: false });
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

  describe('identity', () => {
    it('reports an ordinary identity as a non-administrator', async () => {
      const response = await send(await requestAs(ALICE, '/api/me'));

      expect(await response.json()).toEqual({ email: ALICE, isAdmin: false });
    });

    it('reports the configured administrator as one', async () => {
      const response = await send(await requestAs(ADMIN, '/api/me'));

      expect(await response.json()).toEqual({ email: ADMIN, isAdmin: true });
    });

    // The claim comes from the validated JWT, so the email the endpoint reports is the server's
    // own answer and not a value the caller could have influenced.
    it('reports the identity the token was minted for, not one the caller asked for', async () => {
      const response = await send(
        await requestAs(ALICE, '/api/me', {
          headers: { 'x-forwarded-email': ADMIN }
        })
      );

      expect(await response.json()).toEqual({ email: ALICE, isAdmin: false });
    });

    // `sub` and the credential `source` are server-side detail a browser has no use for.
    it('exposes only the email and the administrator flag', async () => {
      const response = await send(await requestAs(ALICE, '/api/me'));

      expect(Object.keys((await response.json()) as object).sort()).toEqual(['email', 'isAdmin']);
    });
  });

  describe('the user directory', () => {
    it('records an identity on its first authenticated request', async () => {
      await send(await requestAs('first-seen@example.com', '/api/me'));

      const row = await testEnv.DB.prepare(
        'SELECT email, first_seen_at, last_seen_at FROM users WHERE email = ?'
      )
        .bind('first-seen@example.com')
        .first<{ email: string; first_seen_at: string; last_seen_at: string }>();

      expect(row?.email).toBe('first-seen@example.com');
      expect(row?.first_seen_at).toBe(row?.last_seen_at);
    });

    // `first_seen_at` is the one value in the directory that an update would destroy rather than
    // merely leave stale, so the upsert must touch only `last_seen_at`.
    it('refreshes last_seen_at without disturbing first_seen_at', async () => {
      await send(await requestAs('returning@example.com', '/api/me'));
      const first = await testEnv.DB.prepare('SELECT first_seen_at FROM users WHERE email = ?')
        .bind('returning@example.com')
        .first<{ first_seen_at: string }>();

      await send(await requestAs('returning@example.com', '/api/me'));
      const after = await testEnv.DB.prepare(
        'SELECT first_seen_at, last_seen_at FROM users WHERE email = ?'
      )
        .bind('returning@example.com')
        .first<{ first_seen_at: string; last_seen_at: string }>();

      expect(after?.first_seen_at).toBe(first?.first_seen_at);
    });

    it('keeps exactly one row per identity across repeated requests', async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await send(await requestAs('repeat@example.com', '/api/me'));
      }

      const row = await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM users WHERE email = ?')
        .bind('repeat@example.com')
        .first<{ count: number }>();

      expect(row?.count).toBe(1);
    });

    // The directory is a side effect of authentication, not of authorization. An anonymous caller
    // must leave no trace, or the administrative view would list identities that never signed in.
    it('records nothing for an anonymous request to a public route', async () => {
      await send(new Request(`${ORIGIN}/api/health`));

      const row = await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{
        count: number;
      }>();
      const anonymous = await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM users WHERE email = '' OR email IS NULL"
      ).first<{ count: number }>();

      expect(row?.count).toBeGreaterThanOrEqual(0);
      expect(anonymous?.count).toBe(0);
    });

    it('records nothing for a rejected unauthenticated request', async () => {
      const before = await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{
        count: number;
      }>();

      await send(new Request(`${ORIGIN}/api/me`));

      const after = await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{
        count: number;
      }>();

      expect(after?.count).toBe(before?.count);
    });
  });

  describe('administrative authorization', () => {
    // Edge Access answers "who is this"; it deliberately does not distinguish the administrator, so
    // this is the only thing that does. A UI that hides the administrative link is not a control.
    it.each(['/api/admin/users', '/api/admin/diagrams/abc', '/api/admin'])(
      'refuses an ordinary identity at %s with 403',
      async (path) => {
        const response = await send(await requestAs(ALICE, path));

        expect(response.status).toBe(403);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
      }
    );

    it('refuses a second ordinary identity too', async () => {
      const response = await send(await requestAs(BOB, '/api/admin/users'));

      expect(response.status).toBe(403);
    });

    it('refuses an unauthenticated caller with 401 rather than 403', async () => {
      const response = await send(new Request(`${ORIGIN}/api/admin/users`));

      expect(response.status).toBe(401);
    });

    // A token minted for a different Access application in the same team passes signature
    // validation, so the audience check is what refuses it — including on an administrative path,
    // and even for the configured administrator's own address. The answer is `401` rather than
    // `403` because authentication fails first: the caller never became an identity, so there was
    // no identity to refuse.
    it('refuses the administrator holding a token for a different Access application', async () => {
      const response = await send(await requestAs(ADMIN, '/api/admin/users', {}, 'b'.repeat(64)));

      expect(response.status).toBe(401);
    });

    // The administrator passes authorization and is then answered by routing: the endpoints
    // themselves arrive in a later phase. A `404` here rather than a `403` is what proves the
    // check admitted them.
    it('admits the configured administrator as far as routing', async () => {
      const response = await send(await requestAs(ADMIN, '/api/admin/users'));

      expect(response.status).toBe(404);
    });

    // The refusal must not confirm the configured address to the caller it just refused.
    it('names the rule rather than the configured administrator when refusing', async () => {
      const response = await send(await requestAs(ALICE, '/api/admin/users'));
      const body = (await response.json()) as { detail?: string };

      expect(body.detail).toContain('not the configured administrator');
      expect(JSON.stringify(body)).not.toContain(ADMIN);
    });
  });

  describe('state-changing requests', () => {
    /**
     * Builds a mutating request as a signed-in identity.
     *
     * @param method HTTP method to use.
     * @param headers Extra headers, typically the origin and content-type signals under test.
     * @returns The request.
     */
    async function mutate(method: string, headers: Record<string, string>): Promise<Request> {
      return requestAs(ALICE, '/api/admin/users', {
        body: method === 'DELETE' ? undefined : JSON.stringify({}),
        headers,
        method
      });
    }

    // Rejected before authorization is even considered, so a cross-origin request never learns
    // whether the caller would have been allowed.
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
      'rejects a cross-origin %s with 403',
      async (method) => {
        const response = await send(
          await mutate(method, {
            'content-type': 'application/json',
            'origin': 'https://attacker.test'
          })
        );

        expect(response.status).toBe(403);
      }
    );

    // A missing origin must fail for the same reason a foreign one does, or the check is bypassed
    // by simply omitting the header.
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
      'rejects %s carrying no origin signal at all',
      async (method) => {
        const response = await send(await mutate(method, { 'content-type': 'application/json' }));

        expect(response.status).toBe(403);
      }
    );

    it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'])(
      'rejects a same-origin POST declaring %s with 415',
      async (contentType) => {
        const response = await send(
          await mutate('POST', {
            'content-type': contentType,
            'sec-fetch-site': 'same-origin'
          })
        );

        expect(response.status).toBe(415);
      }
    );

    it('rejects a same-origin POST declaring no content type with 415', async () => {
      const response = await send(await mutate('POST', { 'sec-fetch-site': 'same-origin' }));

      expect(response.status).toBe(415);
    });

    // Past both transport checks, so the response is now the authorization answer — which for this
    // ordinary identity on an administrative path is `403`. That ordering is the point: transport
    // validity is decided before identity.
    it('reaches authorization once the origin and content type are both valid', async () => {
      const response = await send(
        await mutate('POST', {
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin'
        })
      );

      expect(response.status).toBe(403);
    });

    // A safe method is what a cross-origin page may legitimately cause, and the browser's own rules
    // stop it reading the response. Guarding these would reject an ordinary anonymous page load.
    it('leaves a cross-origin GET to a public route alone', async () => {
      const response = await send(
        new Request(`${ORIGIN}/api/health`, { headers: { origin: 'https://attacker.test' } })
      );

      expect(response.status).toBe(200);
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
