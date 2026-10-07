import { applyD1Migrations } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';

/**
 * @file The sharing API exercised through the real Workers runtime, against a real migrated D1
 *   database and a real KV namespace. The unit suites prove the rules inside the domain and the
 *   service; what this suite proves is that nothing between a request and those rules weakens them,
 *   and — uniquely — what is actually written into the two stores. The storage assertions are the
 *   reason this file reads D1 and KV directly rather than only through the API. "The raw token is
 *   never persisted" is a claim about bytes at rest, and the only way to hold it is to look at
 *   them.
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
 * A deliberately fictional host, routable nowhere, so this suite can never address a real
 * deployment — see `scripts/naming-contract.ts`.
 */
const ORIGIN = 'https://diagrams.test';

const testEnv = env as TestEnv;

/**
 * The diagram's owner throughout.
 */
const ALICE = 'alice@example.com';

/**
 * A second valid identity, used for every "a signed-in stranger is still refused" assertion.
 */
const MALLORY = 'mallory@example.com';

/**
 * A syntactically valid id that no diagram has.
 */
const MISSING_ID = '11111111-1111-4111-8111-111111111111';

/**
 * A well-formed token that was never minted.
 */
const UNKNOWN_TOKEN = 'z'.repeat(43);

/**
 * The diagram shape the API returns.
 */
interface DiagramPayload {
  id: string;
  ownerEmail: string;
  title: string;
  graphData: string;
}

/**
 * The share creation response.
 */
interface CreatedSharePayload {
  token: string;
  createdAt: string;
  url: string;
}

/**
 * The share status response.
 */
interface ShareStatusPayload {
  active: boolean;
  createdAt: string | null;
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
 * Creates a diagram owned by one identity.
 *
 * @param email Identity that will own the diagram.
 * @param title Title for the new diagram.
 * @returns The created diagram.
 * @throws {Error} When creation did not answer `201`, so a later assertion cannot fail for the
 *   wrong reason.
 */
async function createDiagram(email: string, title = 'Shared Diagram'): Promise<DiagramPayload> {
  const response = await send(await writeAs(email, '/api/diagrams', 'POST', { title }));
  if (response.status !== 201) {
    throw new Error(`Expected 201 creating a diagram, received ${response.status}.`);
  }
  return ((await response.json()) as { diagram: DiagramPayload }).diagram;
}

/**
 * Mints a share link for a diagram.
 *
 * @param email Identity that owns the diagram.
 * @param diagramId Diagram to share.
 * @returns The creation response, including the one-time raw token.
 * @throws {Error} When creation did not answer `201`.
 */
async function createShare(email: string, diagramId: string): Promise<CreatedSharePayload> {
  const response = await send(await writeAs(email, `/api/diagrams/${diagramId}/share`, 'POST'));
  if (response.status !== 201) {
    throw new Error(`Expected 201 creating a share, received ${response.status}.`);
  }
  return (await response.json()) as CreatedSharePayload;
}

/**
 * Resolves a share token as an anonymous visitor would: no identity, no origin header, exactly what
 * a browser following a pasted link sends.
 *
 * @param token Token to resolve.
 * @returns The Worker's response.
 */
async function resolveAnonymously(token: string): Promise<Response> {
  return send(new Request(`${ORIGIN}/api/shares/${token}`));
}

describe('the sharing API', () => {
  beforeAll(async () => {
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  describe('schema', () => {
    it('creates the diagram_shares table', async () => {
      const row = await testEnv.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'diagram_shares'"
      ).first<{ name: string }>();

      expect(row?.name).toBe('diagram_shares');
    });

    // Not an omission: there is no column a raw token could go in, which is what makes
    // digest-only storage structural rather than a convention this code happens to follow.
    it('gives the share table nowhere to put a raw token', async () => {
      const columns = await testEnv.DB.prepare('PRAGMA table_info(diagram_shares)').all<{
        name: string;
      }>();

      expect(columns.results.map((column) => column.name)).toEqual([
        'token_digest',
        'diagram_id',
        'created_at',
        'revoked_at'
      ]);
    });

    it('indexes the diagram predicate both owner queries filter on', async () => {
      const row = await testEnv.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'diagram_shares_diagram_id_idx'"
      ).first<{ name: string }>();

      expect(row?.name).toBe('diagram_shares_diagram_id_idx');
    });
  });

  describe('the one-time token', () => {
    it('returns a token and a shareable URL on creation', async () => {
      const diagram = await createDiagram(ALICE);

      const share = await createShare(ALICE, diagram.id);

      expect(share.token).toMatch(/^[\w-]{43}$/u);
      expect(share.url).toBe(`${ORIGIN}/s/${share.token}`);
    });

    // The claim the whole feature rests on, asserted against the bytes actually at rest rather
    // than against the code that wrote them.
    it('stores the digest and no trace of the token in D1', async () => {
      const diagram = await createDiagram(ALICE);
      const share = await createShare(ALICE, diagram.id);

      const rows = await testEnv.DB.prepare(
        'SELECT token_digest, diagram_id, created_at, revoked_at FROM diagram_shares WHERE diagram_id = ?'
      )
        .bind(diagram.id)
        .all<Record<string, unknown>>();

      expect(rows.results).toHaveLength(1);
      expect(JSON.stringify(rows.results)).not.toContain(share.token);
      expect(rows.results[0]?.token_digest).toMatch(/^[0-9a-f]{64}$/u);
    });

    it('stores no trace of the token in the KV lookup', async () => {
      const diagram = await createDiagram(ALICE);
      const share = await createShare(ALICE, diagram.id);

      const listed = await testEnv.SHARES.list();

      expect(listed.keys.length).toBeGreaterThan(0);
      for (const key of listed.keys) {
        expect(key.name).not.toContain(share.token);
        expect(key.name).toMatch(/^[0-9a-f]{64}$/u);
      }
      // Keyed by digest, valued by diagram id: there is no field a token could hide in.
      await expect(testEnv.SHARES.get(listed.keys[0]?.name ?? '')).resolves.toMatch(
        /^[0-9a-f-]{36}$/u
      );
    });

    // Every response other than the creation one. A status that leaked the URL would defeat the
    // digest-only storage entirely — it would mean something, somewhere, had kept the token.
    it('never returns the token from any other endpoint', async () => {
      const diagram = await createDiagram(ALICE);
      const share = await createShare(ALICE, diagram.id);

      const bodies = await Promise.all(
        [`/api/diagrams/${diagram.id}/share`, `/api/diagrams/${diagram.id}`, '/api/diagrams'].map(
          async (path) => (await send(await requestAs(ALICE, path))).text()
        )
      );
      bodies.push(await (await resolveAnonymously(share.token)).text());

      for (const body of bodies) {
        expect(body).not.toContain(share.token);
      }
    });

    it('reports an active share without reconstructing its URL', async () => {
      const diagram = await createDiagram(ALICE);
      const share = await createShare(ALICE, diagram.id);

      const response = await send(await requestAs(ALICE, `/api/diagrams/${diagram.id}/share`));
      const status = (await response.json()) as ShareStatusPayload;

      expect(response.status).toBe(200);
      expect(status).toEqual({ active: true, createdAt: share.createdAt });
    });

    it('reports no active share for a diagram that has never been shared', async () => {
      const diagram = await createDiagram(ALICE);

      const response = await send(await requestAs(ALICE, `/api/diagrams/${diagram.id}/share`));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ active: false, createdAt: null });
    });
  });

  describe('anonymous resolution', () => {
    it('serves the diagram to a caller with no identity at all', async () => {
      const diagram = await createDiagram(ALICE, 'Public Preview');
      const share = await createShare(ALICE, diagram.id);

      const response = await resolveAnonymously(share.token);
      const { diagram: shared } = (await response.json()) as {
        diagram: Record<string, unknown>;
      };

      expect(response.status).toBe(200);
      expect(shared).toMatchObject({ id: diagram.id, title: 'Public Preview' });
    });

    // A public link must never disclose whose diagram it points at.
    it('discloses neither the owner nor any field beyond the documented projection', async () => {
      const diagram = await createDiagram(ALICE);
      const share = await createShare(ALICE, diagram.id);

      const response = await resolveAnonymously(share.token);
      const body = await response.text();
      const { diagram: shared } = JSON.parse(body) as { diagram: Record<string, unknown> };

      expect(Object.keys(shared).sort()).toEqual(['description', 'graphData', 'id', 'title']);
      expect(body).not.toContain(ALICE);
    });

    // The live-pointer model: there is no snapshot, so a share always shows the diagram as it
    // stands rather than as it stood when the link was handed out.
    it('reflects a graph saved after the link was created', async () => {
      const diagram = await createDiagram(ALICE);
      const share = await createShare(ALICE, diagram.id);

      const graphData = JSON.stringify({
        edges: [],
        nodes: [{ data: { label: 'Workers', typeId: 'worker' }, id: 'n1' }],
        viewport: { x: 0, y: 0, zoom: 1 }
      });
      await send(await writeAs(ALICE, `/api/diagrams/${diagram.id}/graph`, 'PUT', { graphData }));

      const response = await resolveAnonymously(share.token);
      const { diagram: shared } = (await response.json()) as { diagram: { graphData: string } };

      expect(JSON.parse(shared.graphData)).toMatchObject({ nodes: [{ id: 'n1' }] });
    });

    // An anonymous viewer legitimately arrives cross-origin — from a link pasted into a chat
    // client, say — and this route is a read with no side effects, so that must be allowed. The
    // diagram API's own mutations are not, which the diagram suite asserts.
    it('serves a cross-origin read', async () => {
      const diagram = await createDiagram(ALICE);
      const share = await createShare(ALICE, diagram.id);

      const response = await send(
        new Request(`${ORIGIN}/api/shares/${share.token}`, {
          headers: { origin: 'https://somebody-elses-site.test' }
        })
      );

      expect(response.status).toBe(200);
    });

    it('reads a share while signed in as a different identity too', async () => {
      const diagram = await createDiagram(ALICE);
      const share = await createShare(ALICE, diagram.id);

      const response = await send(await requestAs(MALLORY, `/api/shares/${share.token}`));

      expect(response.status).toBe(200);
    });

    // The resolver must not be a way to reach anything else: it accepts a token and nothing that
    // could be read as an id or a path.
    it.each([
      ['an unknown token', UNKNOWN_TOKEN],
      ['a malformed token', 'not-a-token'],
      ['a diagram id', MISSING_ID],
      ['an empty token', '']
    ])('refuses %s with 404', async (_label, token) => {
      const response = await resolveAnonymously(token);

      expect(response.status).toBe(404);
    });

    it('answers every refusal with an RFC 9457 problem document and no stack', async () => {
      const response = await resolveAnonymously(UNKNOWN_TOKEN);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.headers.get('content-type')).toContain('application/problem+json');
      expect(body).toMatchObject({ status: 404 });
      expect(body).not.toHaveProperty('stack');
    });
  });

  describe('revocation and rotation', () => {
    it('stops a revoked link resolving', async () => {
      const diagram = await createDiagram(ALICE);
      const share = await createShare(ALICE, diagram.id);

      const revoke = await send(
        await requestAs(ALICE, `/api/diagrams/${diagram.id}/share`, { method: 'DELETE' })
      );

      expect(revoke.status).toBe(204);
      expect((await resolveAnonymously(share.token)).status).toBe(404);
      expect(
        await (await send(await requestAs(ALICE, `/api/diagrams/${diagram.id}/share`))).json()
      ).toEqual({ active: false, createdAt: null });
    });

    // Workers KV is eventually consistent after a delete. Simulate a remote location still
    // returning the old value after D1 has recorded the revocation: D1 must win, or revocation
    // would be a best-effort hint rather than an end to the bearer credential.
    it('refuses a stale KV hit after D1 has revoked the link', async () => {
      const diagram = await createDiagram(ALICE);
      const share = await createShare(ALICE, diagram.id);
      const digest = (
        await testEnv.DB.prepare('SELECT token_digest FROM diagram_shares WHERE diagram_id = ?')
          .bind(diagram.id)
          .first<{ token_digest: string }>()
      )?.token_digest;

      await send(await requestAs(ALICE, `/api/diagrams/${diagram.id}/share`, { method: 'DELETE' }));
      await testEnv.SHARES.put(digest ?? '', diagram.id);

      expect((await resolveAnonymously(share.token)).status).toBe(404);
      await expect(testEnv.SHARES.get(digest ?? '')).resolves.toBeNull();
    });

    // The revoked row survives as a record that the link once existed, with its digest intact and
    // still carrying no token.
    it('records the revocation rather than deleting the row', async () => {
      const diagram = await createDiagram(ALICE);
      await createShare(ALICE, diagram.id);
      await send(await requestAs(ALICE, `/api/diagrams/${diagram.id}/share`, { method: 'DELETE' }));

      const row = await testEnv.DB.prepare(
        'SELECT revoked_at FROM diagram_shares WHERE diagram_id = ?'
      )
        .bind(diagram.id)
        .first<{ revoked_at: string | null }>();

      expect(row?.revoked_at).toEqual(expect.any(String));
    });

    it('rotates: the new link works and the previous one does not', async () => {
      const diagram = await createDiagram(ALICE);
      const first = await createShare(ALICE, diagram.id);

      const second = await createShare(ALICE, diagram.id);

      expect(second.token).not.toBe(first.token);
      expect((await resolveAnonymously(first.token)).status).toBe(404);
      expect((await resolveAnonymously(second.token)).status).toBe(200);
    });

    it('leaves exactly one active row after repeated rotation', async () => {
      const diagram = await createDiagram(ALICE);
      await createShare(ALICE, diagram.id);
      await createShare(ALICE, diagram.id);
      await createShare(ALICE, diagram.id);

      const row = await testEnv.DB.prepare(
        'SELECT COUNT(*) AS count FROM diagram_shares WHERE diagram_id = ? AND revoked_at IS NULL'
      )
        .bind(diagram.id)
        .first<{ count: number }>();

      expect(row?.count).toBe(1);
    });

    it('refuses a revocation when no link is active', async () => {
      const diagram = await createDiagram(ALICE);

      const response = await send(
        await requestAs(ALICE, `/api/diagrams/${diagram.id}/share`, { method: 'DELETE' })
      );

      expect(response.status).toBe(404);
    });

    // A link must not outlive the diagram it points at.
    it('stops a link resolving when the diagram itself is deleted', async () => {
      const diagram = await createDiagram(ALICE);
      const share = await createShare(ALICE, diagram.id);

      expect(
        (await send(await requestAs(ALICE, `/api/diagrams/${diagram.id}`, { method: 'DELETE' })))
          .status
      ).toBe(204);

      expect((await resolveAnonymously(share.token)).status).toBe(404);
    });

    it('clears the lookup entry when the diagram is deleted', async () => {
      const diagram = await createDiagram(ALICE);
      await createShare(ALICE, diagram.id);
      const digest = (
        await testEnv.DB.prepare('SELECT token_digest FROM diagram_shares WHERE diagram_id = ?')
          .bind(diagram.id)
          .first<{ token_digest: string }>()
      )?.token_digest;

      await send(await requestAs(ALICE, `/api/diagrams/${diagram.id}`, { method: 'DELETE' }));

      await expect(testEnv.SHARES.get(digest ?? '')).resolves.toBeNull();
    });
  });

  describe('owner isolation', () => {
    /**
     * Every share endpoint, as the request a signed-in stranger would make against it.
     */
    const endpoints: [string, (id: string) => Promise<Request>][] = [
      ['GET /:id/share', async (id) => requestAs(MALLORY, `/api/diagrams/${id}/share`)],
      ['POST /:id/share', async (id) => writeAs(MALLORY, `/api/diagrams/${id}/share`, 'POST')],
      [
        'DELETE /:id/share',
        async (id) => requestAs(MALLORY, `/api/diagrams/${id}/share`, { method: 'DELETE' })
      ]
    ];

    it.each(endpoints)(
      'refuses %s for another identity\u2019s diagram with 404',
      async (_name, build) => {
        const diagram = await createDiagram(ALICE);

        const response = await send(await build(diagram.id));

        // `404`, never `403`: a `403` would confirm the guessed id is real.
        expect(response.status).toBe(404);
      }
    );

    it.each(endpoints)('answers %s for an unknown id with the same 404', async (_name, build) => {
      expect((await send(await build(MISSING_ID))).status).toBe(404);
    });

    it.each(endpoints)('answers %s for a malformed id with the same 404', async (_name, build) => {
      expect((await send(await build('not-a-uuid'))).status).toBe(404);
    });

    // The bodies must match too, or the response becomes the oracle the status code is not.
    it('refuses a foreign, an unknown and a malformed id identically', async () => {
      const diagram = await createDiagram(ALICE);

      const bodies = await Promise.all(
        [diagram.id, MISSING_ID, 'not-a-uuid'].map(async (id) =>
          (await send(await requestAs(MALLORY, `/api/diagrams/${id}/share`))).text()
        )
      );

      expect(new Set(bodies).size).toBe(1);
    });

    it('mints nothing when a stranger tries to share a diagram', async () => {
      const diagram = await createDiagram(ALICE);

      await send(await writeAs(MALLORY, `/api/diagrams/${diagram.id}/share`, 'POST'));

      const row = await testEnv.DB.prepare(
        'SELECT COUNT(*) AS count FROM diagram_shares WHERE diagram_id = ?'
      )
        .bind(diagram.id)
        .first<{ count: number }>();

      expect(row?.count).toBe(0);
    });

    it('leaves an owner\u2019s link working after a stranger tries to revoke it', async () => {
      const diagram = await createDiagram(ALICE);
      const share = await createShare(ALICE, diagram.id);

      await send(
        await requestAs(MALLORY, `/api/diagrams/${diagram.id}/share`, { method: 'DELETE' })
      );

      expect((await resolveAnonymously(share.token)).status).toBe(200);
    });

    // A share link grants reading one diagram and nothing else: it is not an identity, so it
    // cannot be used to reach the owner's other diagrams or their management endpoints.
    it('grants a holder no access to the owner\u2019s other diagrams', async () => {
      const shared = await createDiagram(ALICE, 'Shared');
      const private_ = await createDiagram(ALICE, 'Private');
      await createShare(ALICE, shared.id);

      expect((await resolveAnonymously(private_.id)).status).toBe(404);
      expect((await send(new Request(`${ORIGIN}/api/diagrams/${private_.id}`))).status).toBe(401);
    });
  });

  describe('authentication on the owner-only routes', () => {
    it.each([
      ['GET', `/api/diagrams/${MISSING_ID}/share`],
      ['DELETE', `/api/diagrams/${MISSING_ID}/share`]
    ])('rejects an unauthenticated %s %s with 401', async (method, path) => {
      const response = await send(
        new Request(`${ORIGIN}${path}`, { headers: { origin: ORIGIN }, method })
      );

      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    });

    // Every Access application in a team shares one JWKS, so a correctly signed token minted for
    // another application passes signature validation. The audience check is the only refusal.
    it('rejects a valid token minted for a different Access application', async () => {
      const token = await signDevJwt(ALICE, { audience: 'b'.repeat(64) });
      const response = await send(
        new Request(`${ORIGIN}/api/diagrams/${MISSING_ID}/share`, {
          headers: { [JWT_HEADER]: token }
        })
      );

      expect(response.status).toBe(401);
    });

    it('rejects a cross-origin share creation with 403 before it reaches the service', async () => {
      const diagram = await createDiagram(ALICE);
      const token = await signDevJwt(ALICE, { audience: AUD });

      const response = await send(
        new Request(`${ORIGIN}/api/diagrams/${diagram.id}/share`, {
          body: '{}',
          headers: {
            'content-type': 'application/json',
            [JWT_HEADER]: token,
            'origin': 'https://attacker.test'
          },
          method: 'POST'
        })
      );

      expect(response.status).toBe(403);
    });

    it('rejects a cross-origin revocation too', async () => {
      const diagram = await createDiagram(ALICE);
      const share = await createShare(ALICE, diagram.id);
      const token = await signDevJwt(ALICE, { audience: AUD });

      const response = await send(
        new Request(`${ORIGIN}/api/diagrams/${diagram.id}/share`, {
          headers: { [JWT_HEADER]: token, origin: 'https://attacker.test' },
          method: 'DELETE'
        })
      );

      expect(response.status).toBe(403);
      expect((await resolveAnonymously(share.token)).status).toBe(200);
    });
  });

  describe('the resolver\u2019s method surface', () => {
    // Read-only by construction: there is no mutating route here, which is what makes it safe for
    // the same-origin middleware to let an anonymous cross-origin request through.
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('answers %s with no success', async (method) => {
      const diagram = await createDiagram(ALICE);
      const share = await createShare(ALICE, diagram.id);

      const response = await send(
        new Request(`${ORIGIN}/api/shares/${share.token}`, {
          headers: { 'content-type': 'application/json', 'origin': ORIGIN },
          method
        })
      );

      expect(response.ok).toBe(false);
      expect((await resolveAnonymously(share.token)).status).toBe(200);
    });
  });
});
