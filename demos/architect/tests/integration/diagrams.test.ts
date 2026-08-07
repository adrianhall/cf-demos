/** @file Phase 2 integration coverage: the diagram library API and DiagramRoom, end to end. */
import { applyD1Migrations, evictAllDurableObjects } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { JWT_HEADER, signDevJwt } from "@adrianhall/cloudflare-toolkit/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/** Bind the generated Worker configuration to the Workers integration runtime. */
declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

/** Test-only D1 migrations binding injected by `tests/integration/vitest.config.ts`. */
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

/** Create a diagram and return its directory record. */
async function createDiagram(
  title: string,
  options: { blueprintId?: string; email?: string } = {},
): Promise<DiagramResponse> {
  const response = await authenticatedRequest("/api/diagrams", {
    body: { title, blueprintId: options.blueprintId },
    email: options.email,
    method: "POST",
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { diagram: DiagramResponse };
  return body.diagram;
}

describe("Phase 2 diagram library and DiagramRoom", () => {
  beforeAll(async () => {
    const testEnv = env as TestEnv;
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  afterEach(async () => {
    // This hand-written Durable Object never calls ctx.abort(); a graceful eviction is
    // appropriate. No test in this file opens a WebSocket, so there is nothing to close first.
    await evictAllDurableObjects({ webSockets: "close" });
  });

  it("creates a diagram, records owner membership, and seeds the blueprint document", async () => {
    const diagram = await createDiagram("My diagram", {
      blueprintId: "static-site",
      email: "creator@example.com",
    });
    expect(diagram.title).toBe("My diagram");

    const member = await env.DB.prepare(
      "SELECT role FROM diagram_members WHERE diagram_id = ? AND email = ?",
    )
      .bind(diagram.id, "creator@example.com")
      .first<{ role: string }>();
    expect(member).toMatchObject({ role: "owner" });

    const opened = await authenticatedRequest(`/api/diagrams/${diagram.id}`, {
      email: "creator@example.com",
    });
    expect(opened.status).toBe(200);
    const body = (await opened.json()) as {
      revision: number;
      document: { nodes: unknown[] };
    };
    // The static-site blueprint's seed document is applied as revision 1's replace_document
    // operation, so a freshly created diagram is never at revision 0.
    expect(body.revision).toBe(1);
    expect(body.document.nodes).toHaveLength(2);
  });

  it("reloads the same document and survives Durable Object eviction", async () => {
    const diagram = await createDiagram("Reload test", {
      email: "reload@example.com",
    });

    await evictAllDurableObjects({ webSockets: "close" });

    const response = await authenticatedRequest(`/api/diagrams/${diagram.id}`, {
      email: "reload@example.com",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { revision: number };
    expect(body.revision).toBe(1);
  });

  it("applies an accepted operation, persists it, and increments the revision", async () => {
    const diagram = await createDiagram("Operation test", {
      email: "editor@example.com",
    });

    const response = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/operations`,
      {
        body: {
          baseRevision: 1,
          kind: "add_node",
          operationId: crypto.randomUUID(),
          payload: {
            node: {
              id: "actor-1",
              type: "actor",
              position: { x: 10, y: 20 },
              data: { kind: "external-actor", label: "New actor" },
            },
          },
        },
        email: "editor@example.com",
        method: "POST",
      },
    );
    expect(response.status).toBe(200);
    const { result } = (await response.json()) as {
      result: { revision: number; status: string };
    };
    expect(result).toMatchObject({ revision: 2, status: "accepted" });

    // Persisted before broadcast/response — reload independently and confirm it stuck.
    const reopened = await authenticatedRequest(`/api/diagrams/${diagram.id}`, {
      email: "editor@example.com",
    });
    const body = (await reopened.json()) as {
      revision: number;
      document: { nodes: Array<{ id: string }> };
    };
    expect(body.revision).toBe(2);
    expect(body.document.nodes.map((node) => node.id)).toEqual(["actor-1"]);

    const directoryRow = await env.DB.prepare(
      "SELECT updated_at FROM diagrams WHERE id = ?",
    )
      .bind(diagram.id)
      .first<{ updated_at: string }>();
    expect(directoryRow?.updated_at).toBeDefined();
  });

  it("resyncs a stale operation with the full current document instead of applying it", async () => {
    const diagram = await createDiagram("Stale test", {
      email: "stale@example.com",
    });

    const response = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/operations`,
      {
        body: {
          baseRevision: 0, // the diagram is already at revision 1 after blueprint seeding
          kind: "add_node",
          operationId: crypto.randomUUID(),
          payload: {
            node: {
              id: "actor-1",
              type: "actor",
              position: { x: 0, y: 0 },
              data: { kind: "external-actor", label: "Should not apply" },
            },
          },
        },
        email: "stale@example.com",
        method: "POST",
      },
    );
    expect(response.status).toBe(200);
    const { result } = (await response.json()) as {
      result: {
        document: { nodes: unknown[] };
        revision: number;
        status: string;
      };
    };
    expect(result.status).toBe("stale");
    expect(result.revision).toBe(1);
    expect(result.document.nodes).toHaveLength(0); // full current document, not merged
  });

  it("rejects an operation that references an unknown node", async () => {
    const diagram = await createDiagram("Rejection test", {
      email: "reject@example.com",
    });

    const response = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/operations`,
      {
        body: {
          baseRevision: 1,
          kind: "move_node",
          operationId: crypto.randomUUID(),
          payload: { nodeId: "does-not-exist", position: { x: 1, y: 1 } },
        },
        email: "reject@example.com",
        method: "POST",
      },
    );
    expect(response.status).toBe(422);
  });

  it("returns 404, not 403, for a diagram owned by a different identity", async () => {
    const diagram = await createDiagram("Owner isolation", {
      email: "owner-a@example.com",
    });

    const response = await authenticatedRequest(`/api/diagrams/${diagram.id}`, {
      email: "owner-b@example.com",
    });
    expect(response.status).toBe(404);
  });

  it("returns 404 for a malformed diagram id", async () => {
    const response = await authenticatedRequest("/api/diagrams/not-a-uuid", {
      email: "anyone@example.com",
    });
    expect(response.status).toBe(404);
  });

  it("renames a diagram", async () => {
    const diagram = await createDiagram("Old title", {
      email: "renamer@example.com",
    });

    const response = await authenticatedRequest(`/api/diagrams/${diagram.id}`, {
      body: { title: "New title" },
      email: "renamer@example.com",
      method: "PATCH",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { diagram: DiagramResponse };
    expect(body.diagram.title).toBe("New title");
  });

  it("lists only diagrams owned by the caller", async () => {
    await createDiagram("Owned by lister", { email: "lister@example.com" });
    await createDiagram("Owned by someone else", {
      email: "other@example.com",
    });

    const response = await authenticatedRequest("/api/diagrams", {
      email: "lister@example.com",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { diagrams: DiagramResponse[] };
    expect(body.diagrams.length).toBeGreaterThan(0);
    for (const diagram of body.diagrams) {
      expect(diagram.ownerEmail).toBe("lister@example.com");
    }
  });

  it("rejects a diagram mutation from a foreign Origin", async () => {
    const response = await authenticatedRequest("/api/diagrams", {
      body: { title: "Cross-origin" },
      email: "origin-test@example.com",
      method: "POST",
      origin: "http://attacker.test",
    });
    expect(response.status).toBe(403);
  });

  it("rejects a diagram mutation with a missing Origin header", async () => {
    const response = await authenticatedRequest("/api/diagrams", {
      body: { title: "No origin" },
      email: "origin-test@example.com",
      method: "POST",
      origin: null,
    });
    expect(response.status).toBe(403);
  });

  it("destroys a room's storage and reinitializes an empty document", async () => {
    const diagram = await createDiagram("Destroy test", {
      email: "destroyer@example.com",
    });

    await env.DIAGRAM_ROOM.getByName(diagram.id).destroy();

    const snapshot = await env.DIAGRAM_ROOM.getByName(
      diagram.id,
    ).readDocument();
    expect(snapshot.revision).toBe(0);
    expect(snapshot.document.nodes).toHaveLength(0);
  });
});
