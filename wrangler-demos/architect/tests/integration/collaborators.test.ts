import { applyD1Migrations } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { JWT_HEADER, signDevJwt } from "@adrianhall/cloudflare-toolkit/testing";
import { beforeAll, describe, expect, it } from "vitest";

/** Test-only Worker bindings injected by the integration Vitest project. */
interface TestEnv extends Env {
  /** Parsed D1 migrations that initialize Miniflare's otherwise empty D1 database. */
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

const ORIGIN = "https://architect.example";

/** Build an authenticated `GET`/`DELETE` request for one development Access identity. */
async function apiRequest(
  email: string,
  path: string,
  init: RequestInit = {},
): Promise<Request> {
  const token = await signDevJwt(email);
  return new Request(`${ORIGIN}${path}`, {
    ...init,
    headers: { ...init.headers, [JWT_HEADER]: token, origin: ORIGIN },
  });
}

/**
 * Build an authenticated JSON `POST`/`PUT`/`PATCH` request, carrying the `Origin` and
 * `Content-Type` headers a real same-origin browser `fetch()` sends -- required by
 * `enforceSameOriginJson` (`../../src/worker/middleware/same-origin.ts`) for every
 * state-changing request.
 */
async function apiWrite(
  email: string,
  path: string,
  method: "POST" | "PUT" | "PATCH",
  body: unknown = {},
): Promise<Request> {
  return apiRequest(email, path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
}

/** Dispatch a request through the configured Worker. */
async function request(requestValue: Request): Promise<Response> {
  return exports.default.fetch(requestValue);
}

/** Shape returned by the diagrams API for a single diagram. */
interface DiagramPayload {
  id: string;
  ownerEmail: string;
  title: string;
  description: string | null;
  graphData: string;
  createdAt: string;
  updatedAt: string;
}

/** Shape returned by the collaborators API for a single collaborator. */
interface CollaboratorPayload {
  diagramId: string;
  email: string;
  displayName: string | null;
  addedBy: string;
  addedAt: string;
}

/** Create a diagram owned by `email` and return its id. */
async function createDiagram(
  email: string,
  title = "Collaborative Diagram",
): Promise<string> {
  const response = await request(
    await apiWrite(email, "/api/diagrams", "POST", { title }),
  );
  const { diagram } = (await response.json()) as { diagram: DiagramPayload };
  return diagram.id;
}

/** Sign in `email` at least once, so it exists in the `users` directory. */
async function signIn(email: string): Promise<void> {
  const response = await request(await apiRequest(email, "/api/me"));
  expect(response.status).toBe(200);
}

describe("Architect collaborators API", () => {
  beforeAll(async () => {
    const testEnv = env as TestEnv;
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  it("rejects adding a collaborator who has never signed in, with a safe message", async () => {
    const owner = "collab-owner-1@example.com";
    const diagramId = await createDiagram(owner);

    const response = await request(
      await apiWrite(
        owner,
        `/api/diagrams/${diagramId}/collaborators`,
        "POST",
        { email: "never-signed-in@example.com" },
      ),
    );

    expect(response.status).toBe(404);
    const problem = (await response.json()) as { detail?: string };
    expect(problem.detail).not.toContain("never-signed-in@example.com");
  });

  it("rejects adding the diagram's own owner as a collaborator", async () => {
    const owner = "collab-owner-2@example.com";
    const diagramId = await createDiagram(owner);
    await signIn(owner);

    const response = await request(
      await apiWrite(
        owner,
        `/api/diagrams/${diagramId}/collaborators`,
        "POST",
        { email: owner },
      ),
    );

    expect(response.status).toBe(400);
  });

  it("grants a signed-in identity edit access, and lists it back", async () => {
    const owner = "collab-owner-3@example.com";
    const colleague = "collab-colleague-3@example.com";
    const diagramId = await createDiagram(owner);
    await signIn(colleague);

    const addResponse = await request(
      await apiWrite(
        owner,
        `/api/diagrams/${diagramId}/collaborators`,
        "POST",
        { email: colleague },
      ),
    );
    expect(addResponse.status).toBe(201);
    const { collaborator } = (await addResponse.json()) as {
      collaborator: CollaboratorPayload;
    };
    expect(collaborator).toMatchObject({
      addedBy: owner,
      diagramId,
      email: colleague,
    });

    const listResponse = await request(
      await apiRequest(owner, `/api/diagrams/${diagramId}/collaborators`),
    );
    expect(listResponse.status).toBe(200);
    const { collaborators } = (await listResponse.json()) as {
      collaborators: CollaboratorPayload[];
    };
    expect(collaborators.map((c) => c.email)).toEqual([colleague]);
  });

  it("is idempotent: adding an already-added collaborator does not duplicate the row", async () => {
    const owner = "collab-owner-4@example.com";
    const colleague = "collab-colleague-4@example.com";
    const diagramId = await createDiagram(owner);
    await signIn(colleague);

    await request(
      await apiWrite(
        owner,
        `/api/diagrams/${diagramId}/collaborators`,
        "POST",
        { email: colleague },
      ),
    );
    const secondResponse = await request(
      await apiWrite(
        owner,
        `/api/diagrams/${diagramId}/collaborators`,
        "POST",
        { email: colleague },
      ),
    );
    expect(secondResponse.status).toBe(201);

    const listResponse = await request(
      await apiRequest(owner, `/api/diagrams/${diagramId}/collaborators`),
    );
    const { collaborators } = (await listResponse.json()) as {
      collaborators: CollaboratorPayload[];
    };
    expect(collaborators).toHaveLength(1);
  });

  it("rejects adding a collaborator by anyone other than the diagram's owner", async () => {
    const owner = "collab-owner-5@example.com";
    const colleague = "collab-colleague-5@example.com";
    const diagramId = await createDiagram(owner);
    await signIn(colleague);

    const response = await request(
      await apiWrite(
        "mallory@example.com",
        `/api/diagrams/${diagramId}/collaborators`,
        "POST",
        { email: colleague },
      ),
    );

    expect(response.status).toBe(404);
  });

  it("lets a collaborator read and edit the diagram, but not rename, delete, manage sharing, or manage collaborators", async () => {
    const owner = "collab-owner-6@example.com";
    const colleague = "collab-colleague-6@example.com";
    const diagramId = await createDiagram(owner);
    await signIn(colleague);
    await request(
      await apiWrite(
        owner,
        `/api/diagrams/${diagramId}/collaborators`,
        "POST",
        { email: colleague },
      ),
    );

    // A collaborator can read the diagram.
    const getResponse = await request(
      await apiRequest(colleague, `/api/diagrams/${diagramId}`),
    );
    expect(getResponse.status).toBe(200);

    // A collaborator can edit the diagram's graph.
    const graphData = JSON.stringify({
      edges: [],
      nodes: [
        {
          data: { label: "Workers", typeId: "worker" },
          id: "n1",
          position: { x: 0, y: 0 },
        },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    const putResponse = await request(
      await apiWrite(colleague, `/api/diagrams/${diagramId}/graph`, "PUT", {
        graphData,
      }),
    );
    expect(putResponse.status).toBe(200);

    // A collaborator cannot rename the diagram.
    const patchResponse = await request(
      await apiWrite(colleague, `/api/diagrams/${diagramId}`, "PATCH", {
        title: "Hijacked",
      }),
    );
    expect(patchResponse.status).toBe(404);

    // A collaborator cannot delete the diagram.
    const deleteResponse = await request(
      await apiRequest(colleague, `/api/diagrams/${diagramId}`, {
        method: "DELETE",
      }),
    );
    expect(deleteResponse.status).toBe(404);

    // A collaborator cannot manage the anonymous share link.
    const shareResponse = await request(
      await apiWrite(colleague, `/api/diagrams/${diagramId}/share`, "POST"),
    );
    expect(shareResponse.status).toBe(404);

    // A collaborator cannot add another collaborator.
    await signIn("collab-third-6@example.com");
    const addResponse = await request(
      await apiWrite(
        colleague,
        `/api/diagrams/${diagramId}/collaborators`,
        "POST",
        { email: "collab-third-6@example.com" },
      ),
    );
    expect(addResponse.status).toBe(404);
  });

  it("PUT /:id/graph persists a collaborator's edit under the diagram's owner scope in D1", async () => {
    // Regression test for the owner-email-scoping nuance: `saveGraphData()`'s WHERE clause is
    // scoped by the diagram's *owner* email, not the acting editor's -- verify a collaborator's
    // write actually lands, rather than silently affecting zero rows.
    const owner = "collab-owner-7@example.com";
    const colleague = "collab-colleague-7@example.com";
    const diagramId = await createDiagram(owner);
    await signIn(colleague);
    await request(
      await apiWrite(
        owner,
        `/api/diagrams/${diagramId}/collaborators`,
        "POST",
        { email: colleague },
      ),
    );

    const graphData = JSON.stringify({
      edges: [],
      nodes: [
        {
          data: { label: "D1", typeId: "d1" },
          id: "collab-node",
          position: { x: 10, y: 20 },
        },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    const putResponse = await request(
      await apiWrite(colleague, `/api/diagrams/${diagramId}/graph`, "PUT", {
        graphData,
      }),
    );
    expect(putResponse.status).toBe(200);

    // Read back as the owner, straight from D1 via GET, to confirm the write really landed.
    const getResponse = await request(
      await apiRequest(owner, `/api/diagrams/${diagramId}`),
    );
    const saved = ((await getResponse.json()) as { diagram: DiagramPayload })
      .diagram;
    expect(JSON.parse(saved.graphData)).toMatchObject({
      nodes: [{ id: "collab-node" }],
    });
  });

  it("a non-owner, non-collaborator identity gets 404 (not 403) on every diagram route this phase touches", async () => {
    const owner = "collab-owner-8@example.com";
    const diagramId = await createDiagram(owner);
    const stranger = "collab-stranger-8@example.com";

    const getResponse = await request(
      await apiRequest(stranger, `/api/diagrams/${diagramId}`),
    );
    expect(getResponse.status).toBe(404);

    const putResponse = await request(
      await apiWrite(stranger, `/api/diagrams/${diagramId}/graph`, "PUT", {
        graphData: "{}",
      }),
    );
    expect(putResponse.status).toBe(404);

    const collaboratorsGetResponse = await request(
      await apiRequest(stranger, `/api/diagrams/${diagramId}/collaborators`),
    );
    expect(collaboratorsGetResponse.status).toBe(404);

    await signIn(stranger);
    const addResponse = await request(
      await apiWrite(
        stranger,
        `/api/diagrams/${diagramId}/collaborators`,
        "POST",
        { email: stranger },
      ),
    );
    expect(addResponse.status).toBe(404);
  });

  it("lets the owner remove any collaborator", async () => {
    const owner = "collab-owner-9@example.com";
    const colleague = "collab-colleague-9@example.com";
    const diagramId = await createDiagram(owner);
    await signIn(colleague);
    await request(
      await apiWrite(
        owner,
        `/api/diagrams/${diagramId}/collaborators`,
        "POST",
        { email: colleague },
      ),
    );

    const deleteResponse = await request(
      await apiRequest(
        owner,
        `/api/diagrams/${diagramId}/collaborators/${encodeURIComponent(colleague)}`,
        { method: "DELETE" },
      ),
    );
    expect(deleteResponse.status).toBe(204);

    const listResponse = await request(
      await apiRequest(owner, `/api/diagrams/${diagramId}/collaborators`),
    );
    const { collaborators } = (await listResponse.json()) as {
      collaborators: CollaboratorPayload[];
    };
    expect(collaborators).toEqual([]);
  });

  it("lets a collaborator remove themselves (Leave diagram)", async () => {
    const owner = "collab-owner-10@example.com";
    const colleague = "collab-colleague-10@example.com";
    const diagramId = await createDiagram(owner);
    await signIn(colleague);
    await request(
      await apiWrite(
        owner,
        `/api/diagrams/${diagramId}/collaborators`,
        "POST",
        { email: colleague },
      ),
    );

    const deleteResponse = await request(
      await apiRequest(
        colleague,
        `/api/diagrams/${diagramId}/collaborators/${encodeURIComponent(colleague)}`,
        { method: "DELETE" },
      ),
    );
    expect(deleteResponse.status).toBe(204);

    // The owner still has full access after the collaborator left.
    const getResponse = await request(
      await apiRequest(owner, `/api/diagrams/${diagramId}`),
    );
    expect(getResponse.status).toBe(200);
  });

  it("rejects a collaborator removing a different collaborator", async () => {
    const owner = "collab-owner-11@example.com";
    const colleagueA = "collab-colleague-11a@example.com";
    const colleagueB = "collab-colleague-11b@example.com";
    const diagramId = await createDiagram(owner);
    await signIn(colleagueA);
    await signIn(colleagueB);
    await request(
      await apiWrite(
        owner,
        `/api/diagrams/${diagramId}/collaborators`,
        "POST",
        { email: colleagueA },
      ),
    );
    await request(
      await apiWrite(
        owner,
        `/api/diagrams/${diagramId}/collaborators`,
        "POST",
        { email: colleagueB },
      ),
    );

    const deleteResponse = await request(
      await apiRequest(
        colleagueA,
        `/api/diagrams/${diagramId}/collaborators/${encodeURIComponent(colleagueB)}`,
        { method: "DELETE" },
      ),
    );
    expect(deleteResponse.status).toBe(404);

    const listResponse = await request(
      await apiRequest(owner, `/api/diagrams/${diagramId}/collaborators`),
    );
    const { collaborators } = (await listResponse.json()) as {
      collaborators: CollaboratorPayload[];
    };
    expect(collaborators).toHaveLength(2);
  });

  it("returns 404 removing a collaborator row that does not exist", async () => {
    const owner = "collab-owner-12@example.com";
    const diagramId = await createDiagram(owner);

    const deleteResponse = await request(
      await apiRequest(
        owner,
        `/api/diagrams/${diagramId}/collaborators/${encodeURIComponent("nobody@example.com")}`,
        { method: "DELETE" },
      ),
    );
    expect(deleteResponse.status).toBe(404);
  });

  it("GET /api/diagrams/shared-with-me returns exactly the diagrams the caller collaborates on, not owns", async () => {
    const owner = "collab-owner-13@example.com";
    const colleague = "collab-colleague-13@example.com";
    const ownDiagramId = await createDiagram(colleague, "Colleague's own");
    const sharedDiagramId = await createDiagram(owner, "Shared with colleague");
    await signIn(colleague);
    await request(
      await apiWrite(
        owner,
        `/api/diagrams/${sharedDiagramId}/collaborators`,
        "POST",
        { email: colleague },
      ),
    );

    const response = await request(
      await apiRequest(colleague, "/api/diagrams/shared-with-me"),
    );

    expect(response.status).toBe(200);
    const { diagrams } = (await response.json()) as {
      diagrams: DiagramPayload[];
    };
    expect(diagrams.map((d) => d.id)).toEqual([sharedDiagramId]);
    expect(diagrams[0]?.ownerEmail).toBe(owner);
    expect(diagrams.some((d) => d.id === ownDiagramId)).toBe(false);
  });

  it("GET /api/diagrams/shared-with-me is not swallowed by the GET /:id route", async () => {
    const colleague = "collab-colleague-14@example.com";

    const response = await request(
      await apiRequest(colleague, "/api/diagrams/shared-with-me"),
    );

    // If Hono ever matched this path against `/:id` instead, `id` would be the literal string
    // "shared-with-me", which `validateDiagramId()` rejects as malformed (`404`) -- a 200 here
    // (with an empty list, since `colleague` collaborates on nothing) proves the dedicated route
    // handled the request, not the `/:id` fallback.
    expect(response.status).toBe(200);
    const { diagrams } = (await response.json()) as { diagrams: unknown[] };
    expect(diagrams).toEqual([]);
  });
});
