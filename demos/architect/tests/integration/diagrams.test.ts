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
  body: unknown,
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

describe("Architect diagrams API", () => {
  beforeAll(async () => {
    const testEnv = env as TestEnv;
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  it("rejects an unauthenticated request to list diagrams", async () => {
    const response = await request(
      new Request(`${ORIGIN}/api/diagrams`, { headers: { origin: ORIGIN } }),
    );
    expect(response.status).toBe(401);
  });

  it("creates a diagram with default title, description, and an empty graph", async () => {
    const response = await request(
      await apiWrite("alice@example.com", "/api/diagrams", "POST", {}),
    );

    expect(response.status).toBe(201);
    const { diagram } = (await response.json()) as { diagram: DiagramPayload };
    expect(diagram).toMatchObject({
      description: null,
      ownerEmail: "alice@example.com",
      title: "Untitled Diagram",
    });
    expect(JSON.parse(diagram.graphData)).toEqual({
      edges: [],
      nodes: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
  });

  it("creates a diagram seeded from a blueprint's graph data", async () => {
    const response = await request(
      await apiWrite("alice@example.com", "/api/diagrams", "POST", {
        blueprintId: "api-gateway",
        title: "From Blueprint",
      }),
    );

    expect(response.status).toBe(201);
    const { diagram } = (await response.json()) as { diagram: DiagramPayload };
    expect(diagram.title).toBe("From Blueprint");
    const graph = JSON.parse(diagram.graphData) as { nodes: unknown[] };
    expect(graph.nodes.length).toBeGreaterThan(0);
  });

  it("rejects creation from an unknown blueprint id", async () => {
    const response = await request(
      await apiWrite("alice@example.com", "/api/diagrams", "POST", {
        blueprintId: "does-not-exist",
      }),
    );
    expect(response.status).toBe(404);
  });

  it("rejects a cross-origin create request", async () => {
    const token = await signDevJwt("alice@example.com");
    const response = await request(
      new Request(`${ORIGIN}/api/diagrams`, {
        body: "{}",
        headers: {
          "content-type": "application/json",
          [JWT_HEADER]: token,
          origin: "https://evil.example",
        },
        method: "POST",
      }),
    );
    expect(response.status).toBe(403);
  });

  it("lists only the caller's own diagrams, most recently updated first", async () => {
    const owner = "list-owner@example.com";
    const other = "list-other@example.com";

    const otherCreate = await request(
      await apiWrite(other, "/api/diagrams", "POST", {
        title: "Other's diagram",
      }),
    );
    const { diagram: otherDiagram } = (await otherCreate.json()) as {
      diagram: DiagramPayload;
    };
    const first = await request(
      await apiWrite(owner, "/api/diagrams", "POST", { title: "First" }),
    );
    const { diagram: firstDiagram } = (await first.json()) as {
      diagram: DiagramPayload;
    };
    await request(
      await apiWrite(owner, "/api/diagrams", "POST", { title: "Second" }),
    );

    // Touch the first diagram again so it sorts after the second by updated_at.
    await request(
      await apiWrite(owner, `/api/diagrams/${firstDiagram.id}`, "PATCH", {
        title: "First (renamed)",
      }),
    );

    const response = await request(await apiRequest(owner, "/api/diagrams"));
    expect(response.status).toBe(200);
    const { diagrams } = (await response.json()) as {
      diagrams: DiagramPayload[];
    };
    expect(diagrams.map((d) => d.title)).toEqual(["First (renamed)", "Second"]);
    expect(diagrams.every((d) => d.ownerEmail === owner)).toBe(true);
    expect(diagrams.some((d) => d.id === otherDiagram.id)).toBe(false);
  });

  it("returns a diagram the caller owns", async () => {
    const create = await request(
      await apiWrite("bob@example.com", "/api/diagrams", "POST", {
        title: "Bob's diagram",
      }),
    );
    const { diagram } = (await create.json()) as { diagram: DiagramPayload };

    const response = await request(
      await apiRequest("bob@example.com", `/api/diagrams/${diagram.id}`),
    );
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { diagram: DiagramPayload }).diagram.id,
    ).toBe(diagram.id);
  });

  it("reports a diagram owned by a different identity as not found, not forbidden", async () => {
    const create = await request(
      await apiWrite("carol@example.com", "/api/diagrams", "POST", {
        title: "Carol's diagram",
      }),
    );
    const { diagram } = (await create.json()) as { diagram: DiagramPayload };

    const response = await request(
      await apiRequest("mallory@example.com", `/api/diagrams/${diagram.id}`),
    );
    expect(response.status).toBe(404);
  });

  it("returns not found for a malformed diagram id", async () => {
    const response = await request(
      await apiRequest("alice@example.com", "/api/diagrams/not-a-uuid"),
    );
    expect(response.status).toBe(404);
  });

  it("updates title and description via PATCH", async () => {
    const create = await request(
      await apiWrite("dana@example.com", "/api/diagrams", "POST", {}),
    );
    const { diagram } = (await create.json()) as { diagram: DiagramPayload };

    const response = await request(
      await apiWrite(
        "dana@example.com",
        `/api/diagrams/${diagram.id}`,
        "PATCH",
        {
          description: "Updated description",
          title: "Updated Title",
        },
      ),
    );

    expect(response.status).toBe(200);
    const updated = ((await response.json()) as { diagram: DiagramPayload })
      .diagram;
    expect(updated).toMatchObject({
      description: "Updated description",
      title: "Updated Title",
    });
  });

  it("rejects a metadata update for a diagram the caller does not own", async () => {
    const create = await request(
      await apiWrite("erin@example.com", "/api/diagrams", "POST", {}),
    );
    const { diagram } = (await create.json()) as { diagram: DiagramPayload };

    const response = await request(
      await apiWrite(
        "mallory@example.com",
        `/api/diagrams/${diagram.id}`,
        "PATCH",
        {
          title: "Hijacked",
        },
      ),
    );
    expect(response.status).toBe(404);
  });

  it("autosaves graph data via PUT and reflects it in a subsequent GET", async () => {
    const create = await request(
      await apiWrite("frank@example.com", "/api/diagrams", "POST", {}),
    );
    const { diagram } = (await create.json()) as { diagram: DiagramPayload };

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

    const saveResponse = await request(
      await apiWrite(
        "frank@example.com",
        `/api/diagrams/${diagram.id}/graph`,
        "PUT",
        {
          graphData,
        },
      ),
    );
    expect(saveResponse.status).toBe(200);

    const getResponse = await request(
      await apiRequest("frank@example.com", `/api/diagrams/${diagram.id}`),
    );
    const saved = ((await getResponse.json()) as { diagram: DiagramPayload })
      .diagram;
    expect(JSON.parse(saved.graphData)).toMatchObject({
      nodes: [{ id: "n1" }],
    });
  });

  it("rejects a graph autosave for a diagram the caller does not own", async () => {
    const create = await request(
      await apiWrite("grace@example.com", "/api/diagrams", "POST", {}),
    );
    const { diagram } = (await create.json()) as { diagram: DiagramPayload };

    const response = await request(
      await apiWrite(
        "mallory@example.com",
        `/api/diagrams/${diagram.id}/graph`,
        "PUT",
        {
          graphData: "{}",
        },
      ),
    );
    expect(response.status).toBe(404);
  });

  it("deletes a diagram the caller owns", async () => {
    const create = await request(
      await apiWrite("heidi@example.com", "/api/diagrams", "POST", {}),
    );
    const { diagram } = (await create.json()) as { diagram: DiagramPayload };

    const deleteResponse = await request(
      await apiRequest("heidi@example.com", `/api/diagrams/${diagram.id}`, {
        method: "DELETE",
      }),
    );
    expect(deleteResponse.status).toBe(204);

    const getResponse = await request(
      await apiRequest("heidi@example.com", `/api/diagrams/${diagram.id}`),
    );
    expect(getResponse.status).toBe(404);
  });

  it("rejects deleting a diagram the caller does not own, leaving it intact", async () => {
    const create = await request(
      await apiWrite("ivan@example.com", "/api/diagrams", "POST", {}),
    );
    const { diagram } = (await create.json()) as { diagram: DiagramPayload };

    const deleteResponse = await request(
      await apiRequest("mallory@example.com", `/api/diagrams/${diagram.id}`, {
        method: "DELETE",
      }),
    );
    expect(deleteResponse.status).toBe(404);

    const getResponse = await request(
      await apiRequest("ivan@example.com", `/api/diagrams/${diagram.id}`),
    );
    expect(getResponse.status).toBe(200);
  });
});
