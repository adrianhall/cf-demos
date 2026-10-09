import { applyD1Migrations, evictAllDurableObjects } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';

/**
 * @file Collaboration exercised through the real Workers runtime, real Access JWTs and a real
 *   migrated D1 database — including `0003_create_diagram_collaborators.sql` itself, so a broken
 *   migration fails here rather than only at deploy time. The unit suites already prove the rules
 *   inside the services. What this file proves is that no layer between a request and those rules
 *   weakens them, and it asserts only outcomes a caller can actually observe: which status a
 *   stranger gets, which routes a collaborator may reach, and which rows exist afterwards. A test
 *   that checked a predicate instead would keep passing while the route in front of it was wrong.
 *   Every response body is consumed, including on error paths. An unread body keeps the call in
 *   flight, and the integration project's Durable Object teardown then waits on it — the failure
 *   mode recorded in `specs/architect/05-collaboration-spike.md` §4, which presents as a hook
 *   timeout rather than as anything resembling its cause.
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
 * A deliberately fictional host, routable nowhere — see `scripts/naming-contract.ts`.
 */
const ORIGIN = 'https://diagrams.test';

const testEnv = env as TestEnv;

/**
 * The diagram's owner throughout this suite.
 */
const OWNER = 'collab-owner@example.com';

/**
 * An identity the owner grants edit access to.
 */
const EDITOR = 'collab-editor@example.com';

/**
 * A second granted identity, used for the "a collaborator cannot evict another" case, which cannot
 * be expressed with only one.
 */
const OTHER_EDITOR = 'collab-other@example.com';

/**
 * A signed-in identity nobody has granted anything to.
 */
const STRANGER = 'collab-stranger@example.com';

/**
 * An address that has never authenticated against this deployment.
 *
 * Never passed to {@link requestAs}, because doing so would sign a token for it and the
 * user-directory middleware would then record it — which is precisely the state this constant
 * exists to represent the absence of.
 */
const NEVER_SIGNED_IN = 'ghost@example.com';

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
  graphData: string;
  updatedAt: string;
}

/**
 * The collaborator shape the API returns.
 */
interface CollaboratorPayload {
  diagramId: string;
  collaboratorEmail: string;
  addedBy: string;
  addedAt: string;
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
 * Dispatches a request and returns its status, having consumed the body.
 *
 * Every refusal assertion goes through this rather than reading `.status` off an undrained
 * response: an unread body keeps the call in flight and stalls Durable Object teardown. Draining it
 * at the point of assertion makes that impossible to forget.
 *
 * @param request Request to dispatch.
 * @returns The response status.
 */
async function statusOf(request: Request): Promise<number> {
  const response = await send(request);
  await response.text();
  return response.status;
}

/**
 * Dispatches a request and returns its status together with its parsed problem document.
 *
 * @param request Request to dispatch.
 * @returns The status and the body as text, so two refusals can be compared byte for byte.
 */
async function refusalOf(request: Request): Promise<{ status: number; body: string }> {
  const response = await send(request);
  return { body: await response.text(), status: response.status };
}

/**
 * Creates a diagram owned by one identity.
 *
 * @param email Identity that will own it.
 * @param title Title for the new diagram.
 * @returns The created diagram.
 * @throws {Error} When creation did not answer `201`, so a later assertion cannot fail for the
 *   wrong reason.
 */
async function createDiagram(email: string, title = 'Collaborative'): Promise<DiagramPayload> {
  const response = await send(await writeAs(email, '/api/diagrams', 'POST', { title }));
  if (response.status !== 201) {
    await response.text();
    throw new Error(`Expected 201 creating a diagram, received ${response.status}.`);
  }
  return ((await response.json()) as { diagram: DiagramPayload }).diagram;
}

/**
 * Grants one identity edit access to a diagram.
 *
 * @param diagramId Diagram to share.
 * @param owner Identity that owns it.
 * @param email Identity to grant access to.
 * @returns The recorded grant.
 * @throws {Error} When the grant did not answer `201`.
 */
async function grant(
  diagramId: string,
  owner: string,
  email: string
): Promise<CollaboratorPayload> {
  const response = await send(
    await writeAs(owner, `/api/diagrams/${diagramId}/collaborators`, 'POST', { email })
  );
  if (response.status !== 201) {
    await response.text();
    throw new Error(`Expected 201 granting access, received ${response.status}.`);
  }
  return ((await response.json()) as { collaborator: CollaboratorPayload }).collaborator;
}

/**
 * Reads a diagram's collaborator addresses.
 *
 * @param diagramId Diagram to read.
 * @param email Identity making the request, who must be the owner or a collaborator.
 * @returns The collaborator addresses, oldest grant first.
 */
async function collaboratorEmails(diagramId: string, email: string): Promise<string[]> {
  const response = await send(await requestAs(email, `/api/diagrams/${diagramId}/collaborators`));
  const { collaborators } = (await response.json()) as { collaborators: CollaboratorPayload[] };
  return collaborators.map((collaborator) => collaborator.collaboratorEmail);
}

/**
 * Creates a diagram owned by {@link OWNER} with {@link EDITOR} already granted access.
 *
 * @returns The diagram.
 */
async function sharedDiagram(): Promise<DiagramPayload> {
  const diagram = await createDiagram(OWNER);
  await grant(diagram.id, OWNER, EDITOR);
  return diagram;
}

describe('collaboration', () => {
  /**
   * Sockets opened by a test, closed and evicted after it.
   *
   * Only one test here opens one, but the cleanup is unconditional for the reason
   * `./live-sync.test.ts` records: awaiting an outbound close handshake is unreliable in this pool,
   * so eviction is the documented way to force a hibernatable socket closed — and a failed
   * assertion must not be able to leave one open and block the shared runtime's teardown.
   */
  const openSockets = new Set<WebSocket>();

  beforeAll(async () => {
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

    // Every identity that will be *granted* access has to exist in the directory first, which is
    // the rule under test rather than a fixture detail: the only way into that directory is an
    // authenticated request, exactly as it is for a real colleague told to "sign in once".
    for (const email of [EDITOR, OTHER_EDITOR, STRANGER]) {
      await statusOf(await requestAs(email, '/api/me'));
    }
  });

  afterEach(async () => {
    for (const socket of openSockets) {
      if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
        socket.close();
      }
    }
    openSockets.clear();
    await evictAllDurableObjects({ webSockets: 'close' });
  });

  describe('granting access', () => {
    it('records the grant and reports who made it', async () => {
      const diagram = await createDiagram(OWNER);

      const collaborator = await grant(diagram.id, OWNER, EDITOR);

      expect(collaborator).toMatchObject({
        addedBy: OWNER,
        collaboratorEmail: EDITOR,
        diagramId: diagram.id
      });
    });

    // The documented, actionable refusal. It is deliberately not the uniform "Diagram not found",
    // because the owner is looking at their own diagram and the thing that is wrong is the
    // address — telling them nothing would leave them retyping one that is spelled correctly.
    it('refuses an address that has never signed in, and says what to do', async () => {
      const diagram = await createDiagram(OWNER);

      const { status, body } = await refusalOf(
        await writeAs(OWNER, `/api/diagrams/${diagram.id}/collaborators`, 'POST', {
          email: NEVER_SIGNED_IN
        })
      );

      expect(status).toBe(404);
      expect(body).toContain('has not signed in');
      expect(await collaboratorEmails(diagram.id, OWNER)).toEqual([]);
    });

    it('refuses the owner adding their own address with 400', async () => {
      const diagram = await createDiagram(OWNER);

      const status = await statusOf(
        await writeAs(OWNER, `/api/diagrams/${diagram.id}/collaborators`, 'POST', {
          email: OWNER
        })
      );

      expect(status).toBe(400);
      expect(await collaboratorEmails(diagram.id, OWNER)).toEqual([]);
    });

    // Idempotent, and asserted as the outcome a client sees rather than as a repository call: the
    // second request succeeds and the list still has one entry.
    it('succeeds and adds no duplicate when the person is already a collaborator', async () => {
      const diagram = await sharedDiagram();

      const status = await statusOf(
        await writeAs(OWNER, `/api/diagrams/${diagram.id}/collaborators`, 'POST', {
          email: EDITOR
        })
      );

      expect(status).toBe(201);
      expect(await collaboratorEmails(diagram.id, OWNER)).toEqual([EDITOR]);
    });

    it('refuses a malformed address with 422', async () => {
      const diagram = await createDiagram(OWNER);

      const status = await statusOf(
        await writeAs(OWNER, `/api/diagrams/${diagram.id}/collaborators`, 'POST', {
          email: 'not-an-email'
        })
      );

      expect(status).toBe(422);
    });

    it('refuses a collaborator granting access to somebody else', async () => {
      const diagram = await sharedDiagram();

      const status = await statusOf(
        await writeAs(EDITOR, `/api/diagrams/${diagram.id}/collaborators`, 'POST', {
          email: OTHER_EDITOR
        })
      );

      expect(status).toBe(404);
      expect(await collaboratorEmails(diagram.id, OWNER)).toEqual([EDITOR]);
    });
  });

  describe('what a collaborator can do', () => {
    it('reads the diagram, and is told it is an editor rather than the owner', async () => {
      const diagram = await sharedDiagram();

      const response = await send(await requestAs(EDITOR, `/api/diagrams/${diagram.id}`));
      const body = (await response.json()) as { diagram: DiagramPayload; role: string };

      expect(response.status).toBe(200);
      expect(body.diagram.id).toBe(diagram.id);
      expect(body.role).toBe('editor');
    });

    it('is reported as owner to the diagram\u2019s owner', async () => {
      const diagram = await sharedDiagram();

      const response = await send(await requestAs(OWNER, `/api/diagrams/${diagram.id}`));
      const body = (await response.json()) as { role: string };

      expect(body.role).toBe('owner');
    });

    // The capability a grant exists to give. Asserted by reading the graph back as the *owner*,
    // so the test proves the collaborator's write reached the one durable copy rather than
    // merely that the request returned `200`.
    it('saves the graph, and the owner sees the change', async () => {
      const diagram = await sharedDiagram();
      const edited = JSON.stringify({
        edges: [],
        nodes: [{ data: { label: 'Added by the editor' }, id: 'n1', position: { x: 1, y: 2 } }],
        viewport: { x: 0, y: 0, zoom: 1 }
      });

      const saved = await statusOf(
        await writeAs(EDITOR, `/api/diagrams/${diagram.id}/graph`, 'PUT', { graphData: edited })
      );

      expect(saved).toBe(200);

      const response = await send(await requestAs(OWNER, `/api/diagrams/${diagram.id}`));
      const { diagram: stored } = (await response.json()) as { diagram: DiagramPayload };
      expect(stored.graphData).toContain('Added by the editor');
    });

    // A collaborator's save must not quietly transfer the diagram. The owner column is what every
    // owner-only rule is decided against, so a write that changed it would silently hand the
    // diagram over.
    it('does not become the owner by saving', async () => {
      const diagram = await sharedDiagram();

      await statusOf(
        await writeAs(EDITOR, `/api/diagrams/${diagram.id}/graph`, 'PUT', { graphData: '{}' })
      );

      const response = await send(await requestAs(OWNER, `/api/diagrams/${diagram.id}`));
      const { diagram: stored } = (await response.json()) as { diagram: DiagramPayload };
      expect(stored.ownerEmail).toBe(OWNER);
    });

    it('sees the diagram under shared-with-me', async () => {
      const diagram = await sharedDiagram();

      const response = await send(await requestAs(EDITOR, '/api/diagrams/shared-with-me'));
      const { diagrams } = (await response.json()) as { diagrams: DiagramPayload[] };

      expect(diagrams.map((shared) => shared.id)).toContain(diagram.id);
      expect(diagrams.find((shared) => shared.id === diagram.id)?.ownerEmail).toBe(OWNER);
    });

    it('can see who else has access', async () => {
      const diagram = await sharedDiagram();
      await grant(diagram.id, OWNER, OTHER_EDITOR);

      expect(await collaboratorEmails(diagram.id, EDITOR)).toEqual([EDITOR, OTHER_EDITOR]);
    });

    // A real upgrade, not a plain `GET`. The route checks the `Upgrade` header first, so a plain
    // `GET` answers `426` for everybody — including a stranger — and would prove nothing about
    // authorization. Only an actual upgrade reaches the access check, and only a `101` shows the
    // collaborator got through it.
    it('opens a live session on the diagram', async () => {
      const diagram = await sharedDiagram();

      const response = await send(
        await requestAs(EDITOR, `/api/diagrams/${diagram.id}/live`, {
          headers: { Upgrade: 'websocket' }
        })
      );

      expect(response.status).toBe(101);
      expect(response.webSocket).not.toBeNull();
      // Accepted and tracked so `afterEach` can force it closed. An unaccepted or untracked
      // hibernatable socket blocks Durable Object eviction, which surfaces as a hook timeout.
      response.webSocket?.accept();
      if (response.webSocket) {
        openSockets.add(response.webSocket);
      }
    });
  });

  describe('what a collaborator cannot do', () => {
    /**
     * Every owner-only endpoint, as the request a collaborator would make against it.
     */
    const ownerOnly: [string, (id: string) => Promise<Request>][] = [
      ['PATCH /:id', (id) => writeAs(EDITOR, `/api/diagrams/${id}`, 'PATCH', { title: 'Renamed' })],
      ['DELETE /:id', (id) => requestAs(EDITOR, `/api/diagrams/${id}`, { method: 'DELETE' })],
      ['POST /:id/duplicate', (id) => writeAs(EDITOR, `/api/diagrams/${id}/duplicate`, 'POST')],
      ['GET /:id/share', (id) => requestAs(EDITOR, `/api/diagrams/${id}/share`)],
      ['POST /:id/share', (id) => writeAs(EDITOR, `/api/diagrams/${id}/share`, 'POST')],
      [
        'DELETE /:id/share',
        (id) => requestAs(EDITOR, `/api/diagrams/${id}/share`, { method: 'DELETE' })
      ],
      [
        'POST /:id/collaborators',
        (id) =>
          writeAs(EDITOR, `/api/diagrams/${id}/collaborators`, 'POST', { email: OTHER_EDITOR })
      ]
    ];

    // `404`, never `403`, even though the collaborator can plainly see the diagram: giving every
    // refusal on a diagram route one shape is what keeps a `403` from appearing somewhere it
    // would be a signal.
    it.each(ownerOnly)('refuses %s with 404, not 403', async (_name, build) => {
      const diagram = await sharedDiagram();

      expect(await statusOf(await build(diagram.id))).toBe(404);
    });

    it('leaves the diagram untouched after every refused owner-only attempt', async () => {
      const diagram = await sharedDiagram();

      for (const [, build] of ownerOnly) {
        await statusOf(await build(diagram.id));
      }

      const response = await send(await requestAs(OWNER, `/api/diagrams/${diagram.id}`));
      const { diagram: stored } = (await response.json()) as { diagram: DiagramPayload };
      expect(stored).toMatchObject({ ownerEmail: OWNER, title: 'Collaborative' });
      expect(await collaboratorEmails(diagram.id, OWNER)).toEqual([EDITOR]);
    });

    // Two collaborators are needed to express this rule at all, which is why `OTHER_EDITOR`
    // exists: "a collaborator may remove themselves" and "a collaborator may remove anybody"
    // are indistinguishable with one.
    it('cannot remove a different collaborator', async () => {
      const diagram = await sharedDiagram();
      await grant(diagram.id, OWNER, OTHER_EDITOR);

      const status = await statusOf(
        await requestAs(EDITOR, `/api/diagrams/${diagram.id}/collaborators/${OTHER_EDITOR}`, {
          method: 'DELETE'
        })
      );

      expect(status).toBe(404);
      expect(await collaboratorEmails(diagram.id, OWNER)).toEqual([EDITOR, OTHER_EDITOR]);
    });
  });

  describe('a stranger', () => {
    /**
     * Every diagram endpoint, as the request a stranger would make against it — including the three
     * that widened for collaborators, which must not have widened for anybody else.
     */
    const endpoints: [string, (id: string) => Promise<Request>][] = [
      ['GET /:id', (id) => requestAs(STRANGER, `/api/diagrams/${id}`)],
      [
        'PATCH /:id',
        (id) => writeAs(STRANGER, `/api/diagrams/${id}`, 'PATCH', { title: 'Hijacked' })
      ],
      [
        'PUT /:id/graph',
        (id) => writeAs(STRANGER, `/api/diagrams/${id}/graph`, 'PUT', { graphData: '{}' })
      ],
      // A genuine upgrade, for the reason the collaborator's own live test gives: the route
      // checks the protocol before authorization, so a plain `GET` would answer `426` here and
      // prove nothing. A refused upgrade never produces a socket, so nothing needs cleaning up.
      [
        'GET /:id/live (upgrade)',
        (id) =>
          requestAs(STRANGER, `/api/diagrams/${id}/live`, { headers: { Upgrade: 'websocket' } })
      ],
      ['DELETE /:id', (id) => requestAs(STRANGER, `/api/diagrams/${id}`, { method: 'DELETE' })],
      ['GET /:id/collaborators', (id) => requestAs(STRANGER, `/api/diagrams/${id}/collaborators`)],
      [
        'POST /:id/collaborators',
        (id) => writeAs(STRANGER, `/api/diagrams/${id}/collaborators`, 'POST', { email: EDITOR })
      ],
      [
        'DELETE /:id/collaborators/:email',
        (id) =>
          requestAs(STRANGER, `/api/diagrams/${id}/collaborators/${EDITOR}`, { method: 'DELETE' })
      ]
    ];

    it.each(endpoints)('is refused %s with 404, never 403', async (_name, build) => {
      const diagram = await sharedDiagram();

      expect(await statusOf(await build(diagram.id))).toBe(404);
    });

    it.each(endpoints)('receives the same 404 for an unknown id on %s', async (_name, build) => {
      expect(await statusOf(await build(MISSING_ID))).toBe(404);
    });

    // The refusals must be byte-identical, or the body becomes the oracle the status code
    // deliberately is not: a caller comparing them could tell a real shared diagram apart from a
    // guessed id.
    it('cannot tell a real shared diagram from an unknown or malformed id', async () => {
      const diagram = await sharedDiagram();

      const bodies = await Promise.all(
        [diagram.id, MISSING_ID, 'not-a-uuid'].map(
          async (id) => (await refusalOf(await requestAs(STRANGER, `/api/diagrams/${id}`))).body
        )
      );

      expect(new Set(bodies).size).toBe(1);
    });

    it('sees nothing under shared-with-me', async () => {
      await sharedDiagram();

      const response = await send(await requestAs(STRANGER, '/api/diagrams/shared-with-me'));

      expect(await response.json()).toEqual({ diagrams: [] });
    });
  });

  describe('removing access', () => {
    it('lets the owner remove a collaborator, who then sees the uniform 404', async () => {
      const diagram = await sharedDiagram();

      const status = await statusOf(
        await requestAs(OWNER, `/api/diagrams/${diagram.id}/collaborators/${EDITOR}`, {
          method: 'DELETE'
        })
      );

      expect(status).toBe(204);
      expect(await statusOf(await requestAs(EDITOR, `/api/diagrams/${diagram.id}`))).toBe(404);
    });

    it('lets a collaborator leave, and the owner keeps full access', async () => {
      const diagram = await sharedDiagram();

      const status = await statusOf(
        await requestAs(EDITOR, `/api/diagrams/${diagram.id}/collaborators/${EDITOR}`, {
          method: 'DELETE'
        })
      );

      expect(status).toBe(204);
      expect(await statusOf(await requestAs(EDITOR, `/api/diagrams/${diagram.id}`))).toBe(404);
      expect(await statusOf(await requestAs(OWNER, `/api/diagrams/${diagram.id}`))).toBe(200);
    });

    it('removes the diagram from the former collaborator\u2019s shared list', async () => {
      const diagram = await sharedDiagram();
      await statusOf(
        await requestAs(EDITOR, `/api/diagrams/${diagram.id}/collaborators/${EDITOR}`, {
          method: 'DELETE'
        })
      );

      const response = await send(await requestAs(EDITOR, '/api/diagrams/shared-with-me'));
      const { diagrams } = (await response.json()) as { diagrams: DiagramPayload[] };

      expect(diagrams.map((shared) => shared.id)).not.toContain(diagram.id);
    });

    // Refused rather than reported as success, so a client repeating a removal is told the second
    // one did nothing.
    it('refuses a repeated removal with 404', async () => {
      const diagram = await sharedDiagram();
      const path = `/api/diagrams/${diagram.id}/collaborators/${EDITOR}`;

      expect(await statusOf(await requestAs(OWNER, path, { method: 'DELETE' }))).toBe(204);
      expect(await statusOf(await requestAs(OWNER, path, { method: 'DELETE' }))).toBe(404);
    });

    // Access can be given back. Worth asserting because the idempotent insert's conflict clause
    // is the kind of statement that could leave a tombstone behind if it were written as an
    // update of a `revoked_at` column instead of a delete.
    it('can be granted again after being removed', async () => {
      const diagram = await sharedDiagram();
      await statusOf(
        await requestAs(OWNER, `/api/diagrams/${diagram.id}/collaborators/${EDITOR}`, {
          method: 'DELETE'
        })
      );

      await grant(diagram.id, OWNER, EDITOR);

      expect(await statusOf(await requestAs(EDITOR, `/api/diagrams/${diagram.id}`))).toBe(200);
    });
  });

  describe('the two dashboard lists', () => {
    // The owner-scoped list's shape is the contract the MCP `list_diagrams` tool depends on, which
    // is why collaboration was added as a separate endpoint rather than a scope parameter. This
    // proves the two sets are disjoint from both directions, rather than only asserting the one
    // that changed.
    it('never overlap: owned here, shared there', async () => {
      const shared = await sharedDiagram();
      const ownedByEditor = await createDiagram(EDITOR, "The editor's own");

      const ownResponse = await send(await requestAs(EDITOR, '/api/diagrams'));
      const own = ((await ownResponse.json()) as { diagrams: DiagramPayload[] }).diagrams.map(
        (diagram) => diagram.id
      );
      const sharedResponse = await send(await requestAs(EDITOR, '/api/diagrams/shared-with-me'));
      const withMe = ((await sharedResponse.json()) as { diagrams: DiagramPayload[] }).diagrams.map(
        (diagram) => diagram.id
      );

      expect(own).toContain(ownedByEditor.id);
      expect(own).not.toContain(shared.id);
      expect(withMe).toContain(shared.id);
      expect(withMe).not.toContain(ownedByEditor.id);
      expect(own.filter((id) => withMe.includes(id))).toEqual([]);
    });

    // A literal path registered after `/:id` would be captured by it and answered as a diagram id.
    // The symptom would be a `404` from a route that exists, which is indistinguishable from the
    // uniform refusal everywhere else — so it is asserted rather than left to ordering.
    it('resolves shared-with-me as its own route rather than as a diagram id', async () => {
      const response = await send(await requestAs(OWNER, '/api/diagrams/shared-with-me'));
      const body = (await response.json()) as { diagrams?: unknown };

      expect(response.status).toBe(200);
      expect(Array.isArray(body.diagrams)).toBe(true);
    });

    it('answers an identity nobody has shared with as an empty list', async () => {
      const response = await send(
        await requestAs('nobody-shared@example.com', '/api/diagrams/shared-with-me')
      );

      expect(await response.json()).toEqual({ diagrams: [] });
    });
  });

  describe('authentication', () => {
    it.each([
      ['GET', '/api/diagrams/shared-with-me'],
      ['GET', `/api/diagrams/${MISSING_ID}/collaborators`],
      ['POST', `/api/diagrams/${MISSING_ID}/collaborators`]
    ])('rejects an unauthenticated %s %s with 401', async (method, path) => {
      const response = await send(
        new Request(`${ORIGIN}${path}`, {
          headers: { 'content-type': 'application/json', 'origin': ORIGIN },
          method
        })
      );
      await response.text();

      expect(response.status).toBe(401);
    });

    // Every Access application in a team shares one JWKS, so a correctly signed token minted for
    // another application passes signature validation. The audience check is the only refusal.
    it('rejects a token minted for a different Access application', async () => {
      const token = await signDevJwt(OWNER, { audience: 'b'.repeat(64) });
      const response = await send(
        new Request(`${ORIGIN}/api/diagrams/shared-with-me`, {
          headers: { [JWT_HEADER]: token }
        })
      );
      await response.text();

      expect(response.status).toBe(401);
    });
  });
});
