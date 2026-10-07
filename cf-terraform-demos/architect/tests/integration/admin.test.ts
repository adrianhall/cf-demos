import { applyD1Migrations } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';

/**
 * @file The administrative API exercised through the real Workers runtime against a real migrated
 *   D1 database. The unit suite already proves the directory read and the moderation cascade inside
 *   the service; what this suite proves is the thing only an end-to-end request can show — that
 *   **every** administrative route refuses **every** identity that is not the configured
 *   `ADMIN_EMAIL`, and that the refusal happens before any work is done. That last part is why
 *   several cases below assert a side effect's _absence_ as well as a status. A `403` that had
 *   already deleted the diagram would still be a `403`.
 */

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
 * address a real deployment — see `scripts/naming-contract.ts` for why that matters here.
 */
const ORIGIN = 'https://diagrams.test';

const testEnv = env as TestEnv;

/**
 * The configured administrator, matching `ADMIN_EMAIL` in `./vitest.config.ts`.
 */
const ADMIN = 'admin@example.com';

/**
 * An ordinary signed-in owner.
 */
const ALICE = 'alice@example.com';

/**
 * A second valid identity, used for every "a real, authenticated identity is still refused"
 * assertion. The point of the refusals below is that they apply to somebody Access was perfectly
 * happy to let in.
 */
const MALLORY = 'mallory@example.com';

/**
 * A syntactically valid id that no diagram has.
 */
const MISSING_ID = '11111111-1111-4111-8111-111111111111';

/**
 * The diagram shape the owner-scoped API returns.
 */
interface DiagramPayload {
  id: string;
  ownerEmail: string;
  title: string;
  graphData: string;
}

/**
 * One page of the administrative user directory, as the API returns it.
 */
interface DirectoryPayload {
  users: {
    email: string;
    displayName: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    diagramCount: number;
  }[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Builds a request carrying a development Access JWT for one identity.
 *
 * @param email Identity to sign the token for.
 * @param path API path to request.
 * @param init Additional request options.
 * @returns A request ready to dispatch through the Worker.
 */
async function requestAs(email: string, path: string, init: RequestInit = {}): Promise<Request> {
  const headers = new Headers(init.headers);
  headers.set(JWT_HEADER, await signDevJwt(email, { audience: AUD }));
  // The same-origin middleware refuses a state-changing request carrying no origin signal at all,
  // exactly as it would in a browser, so every request here carries the one a real `fetch` sends.
  headers.set('origin', ORIGIN);
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

/**
 * Builds an authenticated JSON write request.
 *
 * @param email Identity to sign the token for.
 * @param path API path to request.
 * @param method HTTP method to use.
 * @param body Value serialised as the JSON request body.
 * @returns A request ready to dispatch through the Worker.
 */
async function writeAs(
  email: string,
  path: string,
  method: 'POST' | 'PUT' | 'PATCH',
  body: unknown = {}
): Promise<Request> {
  return requestAs(email, path, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method
  });
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

/**
 * Creates a diagram as one identity and returns it.
 *
 * @param email Identity that will own the diagram.
 * @param title Title for the new diagram.
 * @returns The created diagram.
 * @throws {Error} When creation did not answer `201`, so a later assertion cannot fail for the
 *   wrong reason.
 */
async function createDiagram(email: string, title = 'A Diagram'): Promise<DiagramPayload> {
  const response = await send(await writeAs(email, '/api/diagrams', 'POST', { title }));
  if (response.status !== 201) {
    throw new Error(`Expected 201 creating a diagram, received ${response.status}.`);
  }
  return ((await response.json()) as { diagram: DiagramPayload }).diagram;
}

describe('the administrative API', () => {
  beforeAll(async () => {
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  describe('authorization', () => {
    /**
     * Every administrative route, as a method and path a request can be built from.
     *
     * Enumerated rather than spot-checked, because "only the administrator may use every
     * administrative endpoint" is a non-negotiable acceptance condition and a route added without
     * its refusal case would otherwise go unnoticed.
     */
    const ADMIN_ROUTES: [string, string][] = [
      ['GET', '/api/admin/users'],
      ['GET', `/api/admin/diagrams/${MISSING_ID}`],
      ['DELETE', `/api/admin/diagrams/${MISSING_ID}`]
    ];

    it.each(ADMIN_ROUTES)('rejects an unauthenticated %s %s with 401', async (method, path) => {
      const response = await send(
        new Request(`${ORIGIN}${path}`, { headers: { origin: ORIGIN }, method })
      );

      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    });

    // The heart of this suite. Mallory is a perfectly valid identity that Access admitted; the
    // application is what refuses, by comparing the verified email to `ADMIN_EMAIL`.
    it.each(ADMIN_ROUTES)(
      'rejects an ordinary authenticated identity on %s %s with 403',
      async (method, path) => {
        const response = await send(await requestAs(MALLORY, path, { method }));

        expect(response.status).toBe(403);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
      }
    );

    // Echoing `ADMIN_EMAIL` back would disclose the administrator's address to every rejected
    // caller, including one probing specifically to learn it.
    it('never names the configured administrator in a refusal', async () => {
      const response = await send(await requestAs(MALLORY, '/api/admin/users'));

      expect(await response.text()).not.toContain(ADMIN);
    });

    // Every Access application in a team shares one JWKS, so a correctly signed token minted for
    // another application passes signature validation. Being the administrator does not exempt a
    // token from the audience check.
    it('rejects an administrator token minted for a different Access application', async () => {
      const token = await signDevJwt(ADMIN, { audience: 'b'.repeat(64) });
      const response = await send(
        new Request(`${ORIGIN}/api/admin/users`, { headers: { [JWT_HEADER]: token } })
      );

      expect(response.status).toBe(401);
    });

    // Hono runs router middleware before matching a path, so the check covers a path that does
    // not exist as readily as one that does: a non-administrator never learns which
    // administrative routes are real.
    it('refuses a non-administrator for an administrative path that does not exist', async () => {
      const response = await send(await requestAs(MALLORY, '/api/admin/not-a-route'));

      expect(response.status).toBe(403);
    });

    it('answers the administrator with 404 for an administrative path that does not exist', async () => {
      const response = await send(await requestAs(ADMIN, '/api/admin/not-a-route'));

      expect(response.status).toBe(404);
    });

    // A rejected moderation attempt is a refusal, not a partial delete.
    it('leaves the diagram intact when a non-administrator attempts a moderation delete', async () => {
      const diagram = await createDiagram(ALICE, 'Not Mallory\u2019s to delete');

      const refused = await send(
        await requestAs(MALLORY, `/api/admin/diagrams/${diagram.id}`, { method: 'DELETE' })
      );
      expect(refused.status).toBe(403);

      const stillThere = await send(await requestAs(ALICE, `/api/diagrams/${diagram.id}`));
      expect(stillThere.status).toBe(200);
    });

    // The administrative router is one of the paths the authenticated Access application
    // enumerates, so the same-origin rule applies to it exactly as it does everywhere else — and
    // being the administrator does not exempt a cross-origin request.
    it('rejects a cross-origin moderation delete even from the administrator', async () => {
      const diagram = await createDiagram(ALICE, 'Cross-origin target');
      const token = await signDevJwt(ADMIN, { audience: AUD });

      const response = await send(
        new Request(`${ORIGIN}/api/admin/diagrams/${diagram.id}`, {
          headers: { [JWT_HEADER]: token, origin: 'https://evil.example' },
          method: 'DELETE'
        })
      );

      expect(response.status).toBe(403);

      const stillThere = await send(await requestAs(ALICE, `/api/diagrams/${diagram.id}`));
      expect(stillThere.status).toBe(200);
    });
  });

  describe('the user directory', () => {
    it('reports every identity that has authenticated, not only the administrator', async () => {
      const owner = 'directory-owner@example.com';
      await send(await requestAs(owner, '/api/me'));
      await createDiagram(owner, 'First');
      await createDiagram(owner, 'Second');

      const response = await send(await requestAs(ADMIN, '/api/admin/users'));
      expect(response.status).toBe(200);

      const page = (await response.json()) as DirectoryPayload;
      expect(page.users.find((user) => user.email === owner)).toMatchObject({
        diagramCount: 2,
        displayName: null
      });
      expect(page.total).toBeGreaterThanOrEqual(1);
    });

    // The directory is written as a best-effort side effect of authentication, so an identity
    // that has only ever read `/api/me` is still in it.
    it('reports an identity that has signed in but owns nothing', async () => {
      const lurker = 'lurker@example.com';
      await send(await requestAs(lurker, '/api/me'));

      const page = (await (
        await send(await requestAs(ADMIN, '/api/admin/users?limit=100'))
      ).json()) as DirectoryPayload;

      expect(page.users.find((user) => user.email === lurker)?.diagramCount).toBe(0);
    });

    it('paginates with limit and offset, echoing the window it used', async () => {
      for (let index = 0; index < 3; index += 1) {
        await send(await requestAs(`page-user-${index}@example.com`, '/api/me'));
      }

      const response = await send(await requestAs(ADMIN, '/api/admin/users?limit=1&offset=0'));
      expect(response.status).toBe(200);

      const page = (await response.json()) as DirectoryPayload;
      expect(page.users).toHaveLength(1);
      expect(page).toMatchObject({ limit: 1, offset: 0 });
      expect(page.total).toBeGreaterThan(1);
    });

    // Both parameters are optional, so a client that sends neither still has to be told which
    // window it got in order to ask for the next one.
    it('echoes the defaulted window when the caller sent no parameters', async () => {
      const page = (await (
        await send(await requestAs(ADMIN, '/api/admin/users'))
      ).json()) as DirectoryPayload;

      expect(page).toMatchObject({ limit: 20, offset: 0 });
    });

    it.each([
      ['a zero limit', '?limit=0'],
      ['a limit above the ceiling', '?limit=101'],
      ['a non-numeric limit', '?limit=all'],
      ['a negative offset', '?offset=-1']
    ])('rejects %s with 422', async (_description, query) => {
      const response = await send(await requestAs(ADMIN, `/api/admin/users${query}`));

      expect(response.status).toBe(422);
    });

    // The directory deliberately reports a count per identity rather than the diagrams
    // themselves, so it cannot become a per-user content browser.
    it('names no diagram in the directory response', async () => {
      const owner = 'titled-owner@example.com';
      await send(await requestAs(owner, '/api/me'));
      await createDiagram(owner, 'A Very Distinctive Title');

      const body = await (await send(await requestAs(ADMIN, '/api/admin/users?limit=100'))).text();

      expect(body).not.toContain('A Very Distinctive Title');
    });
  });

  describe('the moderation preview', () => {
    it('reads any identity\u2019s diagram for the administrator', async () => {
      const diagram = await createDiagram(ALICE, 'Reviewed Diagram');

      const response = await send(await requestAs(ADMIN, `/api/admin/diagrams/${diagram.id}`));
      expect(response.status).toBe(200);

      const body = (await response.json()) as { diagram: DiagramPayload };
      expect(body.diagram).toMatchObject({ id: diagram.id, title: 'Reviewed Diagram' });
    });

    // The same owner-blind projection the anonymous share viewer receives, so this endpoint can
    // never disclose more about a diagram than somebody holding any share link already could.
    it('never discloses who owns the diagram', async () => {
      const diagram = await createDiagram(ALICE, 'Owner Blind');

      const response = await send(await requestAs(ADMIN, `/api/admin/diagrams/${diagram.id}`));
      const raw = await response.text();

      expect(raw).not.toContain(ALICE);
      expect((JSON.parse(raw) as { diagram: object }).diagram).not.toHaveProperty('ownerEmail');
    });

    it('carries the diagram\u2019s current graph so it can be reviewed before deletion', async () => {
      const diagram = await createDiagram(ALICE, 'Has A Graph');
      await send(
        await writeAs(ALICE, `/api/diagrams/${diagram.id}/graph`, 'PUT', {
          graphData: JSON.stringify({
            edges: [],
            nodes: [{ id: 'reviewed-node' }],
            viewport: { x: 0, y: 0, zoom: 1 }
          })
        })
      );

      const body = (await (
        await send(await requestAs(ADMIN, `/api/admin/diagrams/${diagram.id}`))
      ).json()) as { diagram: DiagramPayload };

      expect(body.diagram.graphData).toContain('reviewed-node');
    });

    it.each([
      ['a diagram that does not exist', MISSING_ID],
      ['a malformed id', 'not-a-uuid']
    ])('answers 404 for %s', async (_description, id) => {
      const response = await send(await requestAs(ADMIN, `/api/admin/diagrams/${id}`));

      expect(response.status).toBe(404);
    });
  });

  describe('the moderation delete', () => {
    it('deletes a diagram the administrator does not own', async () => {
      const diagram = await createDiagram(ALICE, 'To Be Moderated');

      const response = await send(
        await requestAs(ADMIN, `/api/admin/diagrams/${diagram.id}`, { method: 'DELETE' })
      );
      expect(response.status).toBe(204);

      const owner = await send(await requestAs(ALICE, `/api/diagrams/${diagram.id}`));
      expect(owner.status).toBe(404);
    });

    // The property that makes routing moderation through the owner delete worthwhile: a
    // moderated diagram leaves no link still resolving, exactly as an owner's own delete does.
    it('cascades to revoke every share link to the deleted diagram', async () => {
      const diagram = await createDiagram(ALICE, 'Shared, Then Moderated');
      const share = await send(await writeAs(ALICE, `/api/diagrams/${diagram.id}/share`, 'POST'));
      const { token } = (await share.json()) as { token: string };

      // The link works before the moderation delete, so the `404` afterwards is caused by the
      // delete rather than by a link that never resolved in the first place.
      const before = await send(new Request(`${ORIGIN}/api/shares/${token}`));
      expect(before.status).toBe(200);

      await send(await requestAs(ADMIN, `/api/admin/diagrams/${diagram.id}`, { method: 'DELETE' }));

      const after = await send(new Request(`${ORIGIN}/api/shares/${token}`));
      expect(after.status).toBe(404);
    });

    it('leaves every other identity\u2019s diagrams alone', async () => {
      const target = await createDiagram(ALICE, 'Target');
      const bystander = await createDiagram(MALLORY, 'Bystander');

      await send(await requestAs(ADMIN, `/api/admin/diagrams/${target.id}`, { method: 'DELETE' }));

      const response = await send(await requestAs(MALLORY, `/api/diagrams/${bystander.id}`));
      expect(response.status).toBe(200);
    });

    it.each([
      ['a diagram that does not exist', MISSING_ID],
      ['a malformed id', 'not-a-uuid']
    ])('answers 404 for %s', async (_description, id) => {
      const response = await send(
        await requestAs(ADMIN, `/api/admin/diagrams/${id}`, { method: 'DELETE' })
      );

      expect(response.status).toBe(404);
    });

    it('answers 404 for a second delete of the same diagram', async () => {
      const diagram = await createDiagram(ALICE, 'Deleted Twice');
      await send(await requestAs(ADMIN, `/api/admin/diagrams/${diagram.id}`, { method: 'DELETE' }));

      const second = await send(
        await requestAs(ADMIN, `/api/admin/diagrams/${diagram.id}`, { method: 'DELETE' })
      );

      expect(second.status).toBe(404);
    });
  });
});
