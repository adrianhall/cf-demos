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

/** Build an authenticated JSON `POST` request, carrying the headers `enforceSameOriginJson`
 * requires for a same-origin state-changing request. */
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

/** Shape returned by `GET`/`POST /api/diagrams/:id/share`. */
interface ShareStatusPayload {
  active: boolean;
  createdAt: string | null;
}

/** Shape returned by `POST /api/diagrams/:id/share`. */
interface CreatedSharePayload extends ShareStatusPayload {
  token: string;
  url: string;
}

/** Create a diagram owned by `email` and return its id. */
async function createDiagram(
  email: string,
  title = "Shared Diagram",
): Promise<string> {
  const response = await request(
    await apiWrite(email, "/api/diagrams", "POST", { title }),
  );
  const { diagram } = (await response.json()) as { diagram: DiagramPayload };
  return diagram.id;
}

describe("Architect sharing API", () => {
  beforeAll(async () => {
    const testEnv = env as TestEnv;
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  it("reports no active share for a freshly created diagram", async () => {
    const diagramId = await createDiagram("share-owner-1@example.com");

    const response = await request(
      await apiRequest(
        "share-owner-1@example.com",
        `/api/diagrams/${diagramId}/share`,
      ),
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as ShareStatusPayload).toEqual({
      active: false,
      createdAt: null,
    });
  });

  it("rejects share status/create/revoke for a diagram the caller does not own", async () => {
    const diagramId = await createDiagram("share-owner-2@example.com");

    const statusResponse = await request(
      await apiRequest(
        "mallory@example.com",
        `/api/diagrams/${diagramId}/share`,
      ),
    );
    expect(statusResponse.status).toBe(404);

    const createResponse = await request(
      await apiWrite(
        "mallory@example.com",
        `/api/diagrams/${diagramId}/share`,
        "POST",
      ),
    );
    expect(createResponse.status).toBe(404);

    const deleteResponse = await request(
      await apiRequest(
        "mallory@example.com",
        `/api/diagrams/${diagramId}/share`,
        {
          method: "DELETE",
        },
      ),
    );
    expect(deleteResponse.status).toBe(404);
  });

  it("creates a share link, resolves it anonymously, and never leaks ownerEmail", async () => {
    const owner = "share-owner-3@example.com";
    const diagramId = await createDiagram(owner, "Public Preview");

    const createResponse = await request(
      await apiWrite(owner, `/api/diagrams/${diagramId}/share`, "POST"),
    );
    expect(createResponse.status).toBe(201);
    const share = (await createResponse.json()) as CreatedSharePayload;
    expect(share.token).toMatch(/^[\w-]{43}$/u);
    expect(share.url).toContain(`/s/${share.token}`);

    const statusResponse = await request(
      await apiRequest(owner, `/api/diagrams/${diagramId}/share`),
    );
    expect((await statusResponse.json()) as ShareStatusPayload).toMatchObject({
      active: true,
    });

    // The public resolver requires no Access identity at all.
    const publicResponse = await request(
      new Request(`${ORIGIN}/api/share/${share.token}`),
    );
    expect(publicResponse.status).toBe(200);
    const { diagram } = (await publicResponse.json()) as {
      diagram: Record<string, unknown>;
    };
    expect(diagram).toMatchObject({ id: diagramId, title: "Public Preview" });
    expect(diagram).not.toHaveProperty("ownerEmail");
  });

  it("resolves the diagram's live graph, not a snapshot taken at share time", async () => {
    const owner = "share-owner-4@example.com";
    const diagramId = await createDiagram(owner);

    const createResponse = await request(
      await apiWrite(owner, `/api/diagrams/${diagramId}/share`, "POST"),
    );
    const { token } = (await createResponse.json()) as CreatedSharePayload;

    const updatedGraph = JSON.stringify({
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
      await apiWrite(owner, `/api/diagrams/${diagramId}/graph`, "PUT", {
        graphData: updatedGraph,
      }),
    );
    expect(saveResponse.status).toBe(200);

    const publicResponse = await request(
      new Request(`${ORIGIN}/api/share/${token}`),
    );
    const { diagram } = (await publicResponse.json()) as {
      diagram: { graphData: string };
    };
    expect(JSON.parse(diagram.graphData)).toMatchObject({
      nodes: [{ id: "n1" }],
    });
  });

  it("stops resolving a revoked share, indistinguishably from an unknown one", async () => {
    const owner = "share-owner-5@example.com";
    const diagramId = await createDiagram(owner);

    const createResponse = await request(
      await apiWrite(owner, `/api/diagrams/${diagramId}/share`, "POST"),
    );
    const { token } = (await createResponse.json()) as CreatedSharePayload;

    const revokeResponse = await request(
      await apiRequest(owner, `/api/diagrams/${diagramId}/share`, {
        method: "DELETE",
      }),
    );
    expect(revokeResponse.status).toBe(204);

    const statusResponse = await request(
      await apiRequest(owner, `/api/diagrams/${diagramId}/share`),
    );
    expect((await statusResponse.json()) as ShareStatusPayload).toEqual({
      active: false,
      createdAt: null,
    });

    const revokedResponse = await request(
      new Request(`${ORIGIN}/api/share/${token}`),
    );
    const unknownResponse = await request(
      new Request(`${ORIGIN}/api/share/${"z".repeat(43)}`),
    );
    expect(revokedResponse.status).toBe(404);
    expect(unknownResponse.status).toBe(404);
    expect(await revokedResponse.json()).toEqual(await unknownResponse.json());
  });

  it("reports not found revoking a diagram with no active share", async () => {
    const owner = "share-owner-6@example.com";
    const diagramId = await createDiagram(owner);

    const response = await request(
      await apiRequest(owner, `/api/diagrams/${diagramId}/share`, {
        method: "DELETE",
      }),
    );
    expect(response.status).toBe(404);
  });

  it("rotating a share revokes the previous token and mints a new working one", async () => {
    const owner = "share-owner-7@example.com";
    const diagramId = await createDiagram(owner);

    const first = (await (
      await request(
        await apiWrite(owner, `/api/diagrams/${diagramId}/share`, "POST"),
      )
    ).json()) as CreatedSharePayload;
    const second = (await (
      await request(
        await apiWrite(owner, `/api/diagrams/${diagramId}/share`, "POST"),
      )
    ).json()) as CreatedSharePayload;

    expect(second.token).not.toBe(first.token);

    const oldTokenResponse = await request(
      new Request(`${ORIGIN}/api/share/${first.token}`),
    );
    expect(oldTokenResponse.status).toBe(404);

    const newTokenResponse = await request(
      new Request(`${ORIGIN}/api/share/${second.token}`),
    );
    expect(newTokenResponse.status).toBe(200);
  });

  it("returns not found for a malformed share token", async () => {
    const response = await request(
      new Request(`${ORIGIN}/api/share/not-a-real-token`),
    );
    expect(response.status).toBe(404);
  });

  it("cascades share revocation when the shared diagram itself is deleted", async () => {
    const owner = "share-owner-8@example.com";
    const diagramId = await createDiagram(owner);

    const createResponse = await request(
      await apiWrite(owner, `/api/diagrams/${diagramId}/share`, "POST"),
    );
    const { token } = (await createResponse.json()) as CreatedSharePayload;

    const deleteResponse = await request(
      await apiRequest(owner, `/api/diagrams/${diagramId}`, {
        method: "DELETE",
      }),
    );
    expect(deleteResponse.status).toBe(204);

    const publicResponse = await request(
      new Request(`${ORIGIN}/api/share/${token}`),
    );
    expect(publicResponse.status).toBe(404);
  });

  it("reports not found when a valid share token points at a diagram no longer in D1", async () => {
    // Simulates the narrow window this route's own defensive check exists for: a share that
    // still resolves (its `diagram_shares`/KV entries are intact) but whose diagram row is
    // gone. The owner-delete route (`../../src/worker/routes/diagrams.ts`) always cascades
    // `revokeAllForDiagram()` immediately after removing the diagram, so this state is not
    // reachable through the ordinary API -- exercised here by deleting the diagram row directly
    // against the test D1 binding, bypassing that cascade on purpose.
    const owner = "share-owner-10@example.com";
    const diagramId = await createDiagram(owner);
    const createResponse = await request(
      await apiWrite(owner, `/api/diagrams/${diagramId}/share`, "POST"),
    );
    const { token } = (await createResponse.json()) as CreatedSharePayload;

    await (env as TestEnv).DB.prepare("DELETE FROM diagrams WHERE id = ?")
      .bind(diagramId)
      .run();

    const response = await request(new Request(`${ORIGIN}/api/share/${token}`));
    expect(response.status).toBe(404);
  });

  it("allows the public share resolver to be called cross-origin, unlike the diagram API", async () => {
    const owner = "share-owner-9@example.com";
    const diagramId = await createDiagram(owner);
    const createResponse = await request(
      await apiWrite(owner, `/api/diagrams/${diagramId}/share`, "POST"),
    );
    const { token } = (await createResponse.json()) as CreatedSharePayload;

    const response = await request(
      new Request(`${ORIGIN}/api/share/${token}`, {
        headers: { origin: "https://not-this-worker.example" },
      }),
    );
    expect(response.status).toBe(200);
  });
});
