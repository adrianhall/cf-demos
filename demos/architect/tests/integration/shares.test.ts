/**
 * @file Phase 6 integration coverage: public publishing, end to end, against real D1, R2, KV,
 * and Durable Object bindings.
 *
 * Every anonymous request in this file is built without any `signDevJwt()`/`JWT_HEADER` at all —
 * see {@link anonymousRequest} — matching production's unauthenticated `POST /shared/resolve`
 * traffic exactly. `runInDurableObject` inspects `DiagramRoom` storage directly (per the
 * `testing-durable-objects` skill's storage-inspection-over-timer-race guidance) to prove
 * anonymous resolution never touches it, rather than racing an absence against a timer.
 */
import {
  applyD1Migrations,
  evictAllDurableObjects,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { JWT_HEADER, signDevJwt } from "@adrianhall/cloudflare-toolkit/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/** Bind the generated Worker configuration to the Workers integration runtime. */
declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

/** Test-only D1 migrations binding injected by `./vitest.config.ts`. */
interface TestEnv extends Env {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/** A diagram, as returned by the diagrams API. */
interface DiagramResponse {
  id: string;
  ownerEmail: string;
  title: string;
}

/** Build and send an authenticated request against the real Worker, matching production shape. */
async function authenticatedRequest(
  path: string,
  options: {
    body?: unknown;
    email?: string;
    method?: string;
    origin?: string | null;
  } = {},
): Promise<Response> {
  const {
    body,
    email = "owner@example.com",
    method = "GET",
    origin = "http://example.test",
  } = options;
  const token = await signDevJwt(email);
  const headers = new Headers({ [JWT_HEADER]: token });
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (method !== "GET" && method !== "HEAD" && origin !== null) {
    headers.set("origin", origin);
  }
  return exports.default.fetch(
    new Request(`http://example.test${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers,
      method,
    }),
  );
}

/**
 * Build and send a request with **no Access identity at all** — no `JWT_HEADER`, matching
 * exactly how an anonymous browser reaches `POST /shared/resolve` in production. Only this
 * helper is used against `/shared/*` in this file.
 */
async function anonymousRequest(
  path: string,
  options: { body?: unknown; method?: string } = {},
): Promise<Response> {
  const { body, method = "POST" } = options;
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("origin", "http://example.test");
  return exports.default.fetch(
    new Request(`http://example.test${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers,
      method,
    }),
  );
}

/** Create a diagram (seeded at revision 1 by its starter blueprint) and return its directory record. */
async function createDiagram(
  title: string,
  email = "owner@example.com",
): Promise<DiagramResponse> {
  const response = await authenticatedRequest("/api/diagrams", {
    body: { title },
    email,
    method: "POST",
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { diagram: DiagramResponse };
  return body.diagram;
}

/** Publish (or republish) a diagram as one identity, returning the parsed response body. */
async function publish(
  diagramId: string,
  email: string,
): Promise<{ published: boolean; revision: number; token: string | null }> {
  const response = await authenticatedRequest(
    `/api/diagrams/${diagramId}/share`,
    {
      body: {},
      email,
      method: "POST",
    },
  );
  return { ...(await response.json()), status: response.status } as {
    published: boolean;
    revision: number;
    token: string | null;
  } & { status: number };
}

/** Apply one `add_node` edit, bumping the diagram's revision by one. */
async function addNode(
  diagramId: string,
  baseRevision: number,
  email = "owner@example.com",
): Promise<void> {
  const response = await authenticatedRequest(
    `/api/diagrams/${diagramId}/operations`,
    {
      body: {
        baseRevision,
        kind: "add_node",
        operationId: crypto.randomUUID(),
        payload: {
          node: {
            data: { description: "", label: "Workers", productId: "workers" },
            id: `node-${crypto.randomUUID()}`,
            position: { x: 0, y: 0 },
            type: "product",
          },
        },
      },
      email,
      method: "POST",
    },
  );
  expect(response.status).toBe(200);
}

describe("Phase 6 public publishing", () => {
  beforeAll(async () => {
    const testEnv = env as TestEnv;
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  afterEach(async () => {
    // This hand-written Durable Object never calls ctx.abort(); a graceful eviction is
    // appropriate. No test in this file opens a WebSocket.
    await evictAllDurableObjects({ webSockets: "close" });
  });

  it("owner publishes and an anonymous request resolves only the immutable published fields", async () => {
    const diagram = await createDiagram(
      "Public diagram",
      "owner-1@example.com",
    );
    const published = await publish(diagram.id, "owner-1@example.com");
    expect(published.published).toBe(true);
    expect(published.revision).toBe(1);
    expect(published.token).toBeTruthy();

    const resolveResponse = await anonymousRequest("/shared/resolve", {
      body: { token: published.token },
    });
    expect(resolveResponse.status).toBe(200);
    const body = (await resolveResponse.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ revision: 1, title: "Public diagram" });
    expect(body.document).toBeDefined();
    // Never diagram ownership, id, or membership — only the immutable published fields.
    expect(body).not.toHaveProperty("ownerEmail");
    expect(body).not.toHaveProperty("diagramId");
    expect(body).not.toHaveProperty("diagram");
    expect(Object.keys(body).sort()).toEqual(["document", "revision", "title"]);
  });

  it("republishing after an edit keeps the same link but advances its resolved revision, without overwriting the old immutable object", async () => {
    const diagram = await createDiagram(
      "Evolving diagram",
      "owner-2@example.com",
    );
    const first = await publish(diagram.id, "owner-2@example.com");
    const token = first.token;
    expect(token).toBeTruthy();

    await addNode(diagram.id, 1, "owner-2@example.com");
    const second = await publish(diagram.id, "owner-2@example.com");
    expect(second.revision).toBe(2);
    // The link itself is stable across a republish — no new raw token is ever returned again.
    expect(second.token).toBeNull();

    const resolved = await anonymousRequest("/shared/resolve", {
      body: { token },
    });
    const body = (await resolved.json()) as { revision: number };
    expect(body.revision).toBe(2);

    // The old revision's object remains retrievable by its own key — publishing is additive,
    // never destructive, even though only the current revision is reachable through the token.
    const oldObject = await env.SNAPSHOTS.get(`snapshots/${diagram.id}/1.json`);
    expect(oldObject).not.toBeNull();
  });

  it("republishing with no intervening edit is a harmless no-op, not a conflict", async () => {
    const diagram = await createDiagram(
      "Unchanged diagram",
      "owner-3@example.com",
    );
    await publish(diagram.id, "owner-3@example.com");
    const secondResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/share`,
      { body: {}, email: "owner-3@example.com", method: "POST" },
    );
    expect(secondResponse.status).toBe(200);
    const body = (await secondResponse.json()) as { revision: number };
    expect(body.revision).toBe(1);
  });

  it("revoking makes the token resolve to not-found for a new anonymous request", async () => {
    const diagram = await createDiagram(
      "Revocable diagram",
      "owner-4@example.com",
    );
    const { token } = await publish(diagram.id, "owner-4@example.com");

    const revokeResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/share`,
      { body: {}, email: "owner-4@example.com", method: "DELETE" },
    );
    expect(revokeResponse.status).toBe(204);

    const resolved = await anonymousRequest("/shared/resolve", {
      body: { token },
    });
    expect(resolved.status).toBe(404);

    const statusResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/share`,
      { email: "owner-4@example.com" },
    );
    const status = (await statusResponse.json()) as {
      status: { published: boolean };
    };
    expect(status.status.published).toBe(false);
  });

  it("revoking an unpublished diagram is a harmless no-op", async () => {
    const diagram = await createDiagram(
      "Never published",
      "owner-5@example.com",
    );
    const response = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/share`,
      {
        body: {},
        email: "owner-5@example.com",
        method: "DELETE",
      },
    );
    expect(response.status).toBe(204);
  });

  it("rejects an unknown or malformed token with the same generic not-found response", async () => {
    const unknown = await anonymousRequest("/shared/resolve", {
      body: { token: "a".repeat(43) },
    });
    expect(unknown.status).toBe(404);

    const malformed = await anonymousRequest("/shared/resolve", {
      body: { token: "too-short" },
    });
    expect(malformed.status).toBe(404);
  });

  it("a non-owner editor cannot publish or revoke, but a non-member cannot even discover share status", async () => {
    const diagram = await createDiagram(
      "Owner-only diagram",
      "owner-6@example.com",
    );

    const invitationResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/invitations`,
      { body: {}, email: "owner-6@example.com", method: "POST" },
    );
    const { token: inviteToken } = (await invitationResponse.json()) as {
      token: string;
    };
    await authenticatedRequest("/api/invitations/redeem", {
      body: { token: inviteToken },
      email: "editor-6@example.com",
      method: "POST",
    });

    const editorPublish = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/share`,
      { body: {}, email: "editor-6@example.com", method: "POST" },
    );
    expect(editorPublish.status).toBe(403);

    const editorRevoke = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/share`,
      { body: {}, email: "editor-6@example.com", method: "DELETE" },
    );
    expect(editorRevoke.status).toBe(403);

    const nonMemberStatus = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/share`,
      { email: "stranger-6@example.com" },
    );
    expect(nonMemberStatus.status).toBe(404);
  });

  it("never reads or modifies DiagramRoom's live editable state for an anonymous resolve", async () => {
    const diagram = await createDiagram(
      "Isolated diagram",
      "owner-7@example.com",
    );
    const { token } = await publish(diagram.id, "owner-7@example.com");

    const before = await runInDurableObject(
      env.DIAGRAM_ROOM.getByName(diagram.id),
      (_instance, state) =>
        state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM operations")
          .one().count,
    );

    // A live edit that is never republished must never be visible through the stable, already-
    // published token — proving the anonymous path reads only the immutable R2 snapshot, not
    // DiagramRoom's current document.
    await addNode(diagram.id, 1, "owner-7@example.com");

    const resolved = await anonymousRequest("/shared/resolve", {
      body: { token },
    });
    const body = (await resolved.json()) as { revision: number };
    expect(body.revision).toBe(1);

    const after = await runInDurableObject(
      env.DIAGRAM_ROOM.getByName(diagram.id),
      (_instance, state) =>
        state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM operations")
          .one().count,
    );
    // The one operation recorded above came from the authenticated addNode() call, not from
    // resolving the share — an anonymous resolve leaves the room's own operation history
    // unchanged relative to whatever authenticated edits already happened.
    expect(after).toBe(before + 1);
  });
});
