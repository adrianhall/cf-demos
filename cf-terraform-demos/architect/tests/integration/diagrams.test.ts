import { applyD1Migrations } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';

/**
 * @file The diagram API exercised through the real Workers runtime against a real migrated D1
 *   database. The unit suite already proves the ownership rule inside the service; what this suite
 *   proves is that no layer between a request and that rule weakens it — not the router, not the
 *   Access middleware, not the SQL. Every negative case is asserted as an outcome a caller can
 *   observe, because that is the only level at which "a stranger cannot read your diagram" is
 *   actually a guarantee.
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
 * An ordinary signed-in owner.
 */
const ALICE = 'alice@example.com';

/**
 * A second ordinary owner, used for every "a valid identity is still refused" assertion.
 */
const MALLORY = 'mallory@example.com';

/**
 * A syntactically valid id that no diagram has.
 */
const MISSING_ID = '11111111-1111-4111-8111-111111111111';

/**
 * The diagram shape the API returns.
 */
interface DiagramPayload {
  id: string;
  ownerEmail: string;
  title: string;
  description: string | null;
  graphData: string;
  createdAt: string;
  updatedAt: string;
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
 * @param body Create payload.
 * @returns The created diagram.
 * @throws {Error} When creation did not answer `201`, so a later assertion cannot fail for the
 *   wrong reason.
 */
async function createDiagram(email: string, body: unknown = {}): Promise<DiagramPayload> {
  const response = await send(await writeAs(email, '/api/diagrams', 'POST', body));
  if (response.status !== 201) {
    throw new Error(`Expected 201 creating a diagram, received ${response.status}.`);
  }
  return ((await response.json()) as { diagram: DiagramPayload }).diagram;
}

describe('the diagram API', () => {
  beforeAll(async () => {
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  describe('authentication', () => {
    it.each([
      ['GET', '/api/diagrams'],
      ['GET', `/api/diagrams/${MISSING_ID}`],
      ['DELETE', `/api/diagrams/${MISSING_ID}`]
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
        new Request(`${ORIGIN}/api/diagrams`, { headers: { [JWT_HEADER]: token } })
      );

      expect(response.status).toBe(401);
    });
  });

  describe('creating a diagram', () => {
    it('creates a blank canvas with the default title and an empty graph', async () => {
      const diagram = await createDiagram(ALICE);

      expect(diagram).toMatchObject({
        description: null,
        ownerEmail: ALICE,
        title: 'Untitled Diagram'
      });
      expect(JSON.parse(diagram.graphData)).toEqual({
        edges: [],
        nodes: [],
        viewport: { x: 0, y: 0, zoom: 1 }
      });
    });

    it('seeds a diagram from a blueprint', async () => {
      const diagram = await createDiagram(ALICE, {
        blueprintId: 'api-gateway',
        title: 'From Blueprint'
      });

      expect(diagram.title).toBe('From Blueprint');
      expect((JSON.parse(diagram.graphData) as { nodes: unknown[] }).nodes.length).toBeGreaterThan(
        0
      );
    });

    it('rejects an unknown blueprint with 404', async () => {
      const response = await send(
        await writeAs(ALICE, '/api/diagrams', 'POST', { blueprintId: 'does-not-exist' })
      );

      expect(response.status).toBe(404);
    });

    // The owner comes from the validated JWT, so a body naming somebody else changes nothing.
    it('owns the diagram to the verified identity, not one named in the body', async () => {
      const diagram = await createDiagram(ALICE, { ownerEmail: MALLORY });

      expect(diagram.ownerEmail).toBe(ALICE);
    });

    it('rejects an invalid title with 422', async () => {
      const response = await send(await writeAs(ALICE, '/api/diagrams', 'POST', { title: '' }));

      expect(response.status).toBe(422);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    });

    it('rejects a cross-origin create with 403 before it reaches the service', async () => {
      const token = await signDevJwt(ALICE, { audience: AUD });
      const response = await send(
        new Request(`${ORIGIN}/api/diagrams`, {
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

    it('rejects a create declaring a non-JSON content type with 415', async () => {
      const token = await signDevJwt(ALICE, { audience: AUD });
      const response = await send(
        new Request(`${ORIGIN}/api/diagrams`, {
          body: 'title=x',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            [JWT_HEADER]: token,
            'origin': ORIGIN
          },
          method: 'POST'
        })
      );

      expect(response.status).toBe(415);
    });

    // The bound is on the router, so a graph far beyond any real diagram is refused before the
    // Worker attempts to parse it.
    it('rejects a body beyond the documented size limit with 400', async () => {
      const response = await send(
        await writeAs(ALICE, '/api/diagrams', 'POST', { title: 'x'.repeat(600_000) })
      );

      expect(response.status).toBe(400);
    });
  });

  describe('listing diagrams', () => {
    it('lists only the caller\u2019s own diagrams, most recently updated first', async () => {
      const owner = 'list-owner@example.com';
      const stranger = 'list-stranger@example.com';
      const strangers = await createDiagram(stranger, { title: "Stranger's" });
      const first = await createDiagram(owner, { title: 'First' });
      await createDiagram(owner, { title: 'Second' });

      // Touch the first diagram so it sorts ahead of the second.
      await send(
        await writeAs(owner, `/api/diagrams/${first.id}`, 'PATCH', { title: 'First (renamed)' })
      );

      const response = await send(await requestAs(owner, '/api/diagrams'));
      const { diagrams } = (await response.json()) as { diagrams: DiagramPayload[] };

      expect(response.status).toBe(200);
      expect(diagrams.map((diagram) => diagram.title)).toEqual(['First (renamed)', 'Second']);
      expect(diagrams.some((diagram) => diagram.id === strangers.id)).toBe(false);
    });

    it('answers an identity with no diagrams with an empty list', async () => {
      const response = await send(await requestAs('newcomer@example.com', '/api/diagrams'));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ diagrams: [] });
    });
  });

  describe('owner isolation', () => {
    /**
     * Every single-diagram endpoint, as the request a stranger would make against it.
     */
    const endpoints: [string, (id: string) => Promise<Request>][] = [
      ['GET /:id', (id) => requestAs(MALLORY, `/api/diagrams/${id}`)],
      [
        'PATCH /:id',
        (id) => writeAs(MALLORY, `/api/diagrams/${id}`, 'PATCH', { title: 'Hijacked' })
      ],
      [
        'PUT /:id/graph',
        (id) => writeAs(MALLORY, `/api/diagrams/${id}/graph`, 'PUT', { graphData: '{}' })
      ],
      ['POST /:id/duplicate', (id) => writeAs(MALLORY, `/api/diagrams/${id}/duplicate`, 'POST')],
      ['DELETE /:id', (id) => requestAs(MALLORY, `/api/diagrams/${id}`, { method: 'DELETE' })]
    ];

    it.each(endpoints)(
      'refuses %s for another identity\u2019s diagram with 404',
      async (_name, build) => {
        const diagram = await createDiagram(ALICE, { title: "Alice's" });

        const response = await send(await build(diagram.id));

        // `404`, never `403`: a `403` would confirm the id is real.
        expect(response.status).toBe(404);
      }
    );

    it.each(endpoints)('answers %s for an unknown id with the same 404', async (_name, build) => {
      const response = await send(await build(MISSING_ID));

      expect(response.status).toBe(404);
    });

    it.each(endpoints)('answers %s for a malformed id with the same 404', async (_name, build) => {
      const response = await send(await build('not-a-uuid'));

      expect(response.status).toBe(404);
    });

    // The three refusals must be byte-identical, or the response body becomes the oracle the
    // status code is not.
    it('refuses a foreign, an unknown and a malformed id identically', async () => {
      const diagram = await createDiagram(ALICE, {});

      const bodies = await Promise.all(
        [diagram.id, MISSING_ID, 'not-a-uuid'].map(async (id) =>
          (await send(await requestAs(MALLORY, `/api/diagrams/${id}`))).text()
        )
      );

      expect(new Set(bodies).size).toBe(1);
    });

    it('leaves a refused diagram untouched', async () => {
      const diagram = await createDiagram(ALICE, { title: 'Original' });

      await send(
        await writeAs(MALLORY, `/api/diagrams/${diagram.id}`, 'PATCH', { title: 'Hijacked' })
      );
      await send(await requestAs(MALLORY, `/api/diagrams/${diagram.id}`, { method: 'DELETE' }));

      const response = await send(await requestAs(ALICE, `/api/diagrams/${diagram.id}`));

      expect(response.status).toBe(200);
      expect(((await response.json()) as { diagram: DiagramPayload }).diagram.title).toBe(
        'Original'
      );
    });

    // A refused duplicate must not land in the stranger's own dashboard either, which a naive
    // "copy first, check later" implementation would allow.
    it('creates nothing for the caller when duplication is refused', async () => {
      const diagram = await createDiagram(ALICE, { title: 'Private' });
      const stranger = 'dup-stranger@example.com';

      await send(await writeAs(stranger, `/api/diagrams/${diagram.id}/duplicate`, 'POST'));

      const response = await send(await requestAs(stranger, '/api/diagrams'));

      expect(await response.json()).toEqual({ diagrams: [] });
    });
  });

  describe('reading a diagram', () => {
    it('returns a diagram the caller owns', async () => {
      const diagram = await createDiagram(ALICE, { title: "Alice's own" });

      const response = await send(await requestAs(ALICE, `/api/diagrams/${diagram.id}`));

      expect(response.status).toBe(200);
      expect(((await response.json()) as { diagram: DiagramPayload }).diagram).toMatchObject({
        id: diagram.id,
        title: "Alice's own"
      });
    });
  });

  describe('updating metadata', () => {
    it('renames a diagram and changes its description', async () => {
      const diagram = await createDiagram(ALICE, { description: 'Before', title: 'Before' });

      const response = await send(
        await writeAs(ALICE, `/api/diagrams/${diagram.id}`, 'PATCH', {
          description: 'After',
          title: 'After'
        })
      );

      expect(response.status).toBe(200);
      expect(((await response.json()) as { diagram: DiagramPayload }).diagram).toMatchObject({
        description: 'After',
        title: 'After'
      });
    });

    it('clears a description when sent an explicit null', async () => {
      const diagram = await createDiagram(ALICE, { description: 'Notes' });

      const response = await send(
        await writeAs(ALICE, `/api/diagrams/${diagram.id}`, 'PATCH', { description: null })
      );

      expect(
        ((await response.json()) as { diagram: DiagramPayload }).diagram.description
      ).toBeNull();
    });

    it('leaves the description alone when the property is omitted', async () => {
      const diagram = await createDiagram(ALICE, { description: 'Notes' });

      const response = await send(
        await writeAs(ALICE, `/api/diagrams/${diagram.id}`, 'PATCH', { title: 'Renamed' })
      );

      expect(((await response.json()) as { diagram: DiagramPayload }).diagram).toMatchObject({
        description: 'Notes',
        title: 'Renamed'
      });
    });

    it('rejects an update carrying neither field with 422', async () => {
      const diagram = await createDiagram(ALICE, {});

      const response = await send(await writeAs(ALICE, `/api/diagrams/${diagram.id}`, 'PATCH', {}));

      expect(response.status).toBe(422);
    });
  });

  describe('saving a graph', () => {
    it('persists the graph and reflects it in a subsequent read', async () => {
      const diagram = await createDiagram(ALICE, {});
      const graphData = JSON.stringify({
        edges: [],
        nodes: [{ data: { label: 'Workers', typeId: 'worker' }, id: 'n1' }],
        viewport: { x: 0, y: 0, zoom: 1 }
      });

      const save = await send(
        await writeAs(ALICE, `/api/diagrams/${diagram.id}/graph`, 'PUT', { graphData })
      );

      expect(save.status).toBe(200);
      expect((await save.json()) as { updatedAt: string }).toMatchObject({
        updatedAt: expect.any(String) as string
      });

      const read = await send(await requestAs(ALICE, `/api/diagrams/${diagram.id}`));
      const saved = ((await read.json()) as { diagram: DiagramPayload }).diagram;

      expect(JSON.parse(saved.graphData)).toMatchObject({ nodes: [{ id: 'n1' }] });
    });

    // The editor's autosave sends the whole canvas, including every field the client invented for
    // itself. The Worker validates that each element is an object with a usable id and stores the
    // rest verbatim, which is what lets the editor add a field without a server change — so the
    // round trip has to return the payload byte for byte, not a server-reshaped version of it.
    it('returns an editor-shaped graph exactly as the editor saved it', async () => {
      const diagram = await createDiagram(ALICE, {});
      const graph = {
        edges: [
          {
            data: { edgeType: 'trigger', label: 'on schedule', protocol: 'queue' },
            id: 'e1',
            source: 'n1',
            sourceHandle: 'source-bottom',
            target: 'n2',
            targetHandle: 'target-top',
            type: 'cf-edge'
          }
        ],
        nodes: [
          {
            data: {
              description: 'Handles requests',
              label: 'API Worker',
              style: { accentColor: '#123456' },
              typeId: 'worker'
            },
            id: 'n1',
            position: { x: 16, y: 32 },
            type: 'cf-node'
          },
          {
            data: { label: 'Primary DB', typeId: 'd1' },
            id: 'n2',
            position: { x: 16, y: 240 },
            type: 'cf-node'
          }
        ],
        viewport: { x: -40, y: 12, zoom: 0.75 }
      };

      await send(
        await writeAs(ALICE, `/api/diagrams/${diagram.id}/graph`, 'PUT', {
          graphData: JSON.stringify(graph)
        })
      );

      const read = await send(await requestAs(ALICE, `/api/diagrams/${diagram.id}`));
      const saved = ((await read.json()) as { diagram: DiagramPayload }).diagram;

      expect(JSON.parse(saved.graphData)).toEqual(graph);
    });

    // A save is a complete statement of the canvas rather than a difference against what the
    // server holds, so deleting the last node has to leave an empty diagram — not the previous
    // one merged with an empty update.
    it('replaces the stored graph rather than merging into it', async () => {
      const diagram = await createDiagram(ALICE, { blueprintId: 'api-gateway' });

      expect((JSON.parse(diagram.graphData) as { nodes: unknown[] }).nodes.length).toBeGreaterThan(
        0
      );

      await send(
        await writeAs(ALICE, `/api/diagrams/${diagram.id}/graph`, 'PUT', {
          graphData: JSON.stringify({ edges: [], nodes: [], viewport: { x: 0, y: 0, zoom: 1 } })
        })
      );

      const read = await send(await requestAs(ALICE, `/api/diagrams/${diagram.id}`));
      const saved = ((await read.json()) as { diagram: DiagramPayload }).diagram;

      expect(JSON.parse(saved.graphData)).toEqual({
        edges: [],
        nodes: [],
        viewport: { x: 0, y: 0, zoom: 1 }
      });
    });

    // The editor shows the returned timestamp as its save state, so it has to actually move —
    // a stale one would leave the status bar reporting an earlier save than the one just made.
    it('advances the diagram\u2019s updated timestamp', async () => {
      const diagram = await createDiagram(ALICE, {});

      const save = await send(
        await writeAs(ALICE, `/api/diagrams/${diagram.id}/graph`, 'PUT', {
          graphData: JSON.stringify({ edges: [], nodes: [{ id: 'n1' }] })
        })
      );
      const { updatedAt } = (await save.json()) as { updatedAt: string };

      const read = await send(await requestAs(ALICE, `/api/diagrams/${diagram.id}`));
      const saved = ((await read.json()) as { diagram: DiagramPayload }).diagram;

      expect(saved.updatedAt).toBe(updatedAt);
      expect(Date.parse(updatedAt)).toBeGreaterThanOrEqual(Date.parse(diagram.createdAt));
    });

    it('rejects a malformed graph with 422 and keeps the stored one', async () => {
      const diagram = await createDiagram(ALICE, {});

      const response = await send(
        await writeAs(ALICE, `/api/diagrams/${diagram.id}/graph`, 'PUT', {
          graphData: '{"nodes":[{}]}'
        })
      );

      expect(response.status).toBe(422);

      const read = await send(await requestAs(ALICE, `/api/diagrams/${diagram.id}`));
      const saved = ((await read.json()) as { diagram: DiagramPayload }).diagram;

      expect(JSON.parse(saved.graphData)).toEqual({
        edges: [],
        nodes: [],
        viewport: { x: 0, y: 0, zoom: 1 }
      });
    });
  });

  describe('duplicating a diagram', () => {
    it('copies the graph into a new, independently owned diagram', async () => {
      const source = await createDiagram(ALICE, {
        blueprintId: 'api-gateway',
        title: 'Source'
      });

      const response = await send(
        await writeAs(ALICE, `/api/diagrams/${source.id}/duplicate`, 'POST')
      );
      const copy = ((await response.json()) as { diagram: DiagramPayload }).diagram;

      expect(response.status).toBe(201);
      expect(copy).toMatchObject({
        graphData: source.graphData,
        ownerEmail: ALICE,
        title: 'Source (copy)'
      });
      expect(copy.id).not.toBe(source.id);
    });

    it('leaves the source diagram in place', async () => {
      const source = await createDiagram(ALICE, { title: 'Kept' });

      await send(await writeAs(ALICE, `/api/diagrams/${source.id}/duplicate`, 'POST'));

      expect((await send(await requestAs(ALICE, `/api/diagrams/${source.id}`))).status).toBe(200);
    });
  });

  describe('deleting a diagram', () => {
    it('deletes a diagram the caller owns and then reports it absent', async () => {
      const diagram = await createDiagram(ALICE, {});

      const remove = await send(
        await requestAs(ALICE, `/api/diagrams/${diagram.id}`, { method: 'DELETE' })
      );

      expect(remove.status).toBe(204);
      expect((await send(await requestAs(ALICE, `/api/diagrams/${diagram.id}`))).status).toBe(404);
    });

    it('answers a repeated delete with the same 404', async () => {
      const diagram = await createDiagram(ALICE, {});
      await send(await requestAs(ALICE, `/api/diagrams/${diagram.id}`, { method: 'DELETE' }));

      const second = await send(
        await requestAs(ALICE, `/api/diagrams/${diagram.id}`, { method: 'DELETE' })
      );

      expect(second.status).toBe(404);
    });
  });

  describe('persistence', () => {
    // The diagram is stored against the verified identity, in the column the ownership index
    // covers. Read from D1 directly, because that is the claim: the isolation above is enforced by
    // data rather than only by the code path that happened to be taken.
    it('stores the verified owner in the indexed column', async () => {
      const diagram = await createDiagram(ALICE, { title: 'Stored' });

      const row = await testEnv.DB.prepare('SELECT owner_email FROM diagrams WHERE id = ?')
        .bind(diagram.id)
        .first<{ owner_email: string }>();

      expect(row?.owner_email).toBe(ALICE);
    });
  });
});
