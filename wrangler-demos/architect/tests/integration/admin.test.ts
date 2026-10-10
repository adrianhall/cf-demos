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

/** Matches `tests/integration/vitest.config.ts`'s fixed `ADMIN_EMAIL` Miniflare binding. */
const ADMIN_EMAIL = "admin@example.com";

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

/** Build an authenticated JSON `POST`/`PUT`/`PATCH` request with same-origin headers. */
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
}

/** Shape returned by `GET /api/admin/users`. */
interface AdminUsersPayload {
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

describe("Architect admin API", () => {
  beforeAll(async () => {
    const testEnv = env as TestEnv;
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  it("rejects an unauthenticated request to list users", async () => {
    const response = await request(
      new Request(`${ORIGIN}/api/admin/users`, {
        headers: { origin: ORIGIN },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a non-administrator authenticated identity with 403", async () => {
    const response = await request(
      await apiRequest("mallory@example.com", "/api/admin/users"),
    );
    expect(response.status).toBe(403);
  });

  it("rejects a non-administrator identity attempting a moderation delete with 403", async () => {
    const create = await request(
      await apiWrite("victim1@example.com", "/api/diagrams", "POST", {
        title: "Victim's diagram",
      }),
    );
    const { diagram } = (await create.json()) as { diagram: DiagramPayload };

    const response = await request(
      await apiRequest(
        "mallory@example.com",
        `/api/admin/diagrams/${diagram.id}`,
        { method: "DELETE" },
      ),
    );
    expect(response.status).toBe(403);

    // The diagram must remain intact -- a rejected moderation attempt is not a partial delete.
    const getResponse = await request(
      await apiRequest("victim1@example.com", `/api/diagrams/${diagram.id}`),
    );
    expect(getResponse.status).toBe(200);
  });

  it("lists every identity's diagram count for the configured administrator", async () => {
    const owner = "directory-owner@example.com";
    await request(await apiRequest(owner, "/api/me"));
    await request(
      await apiWrite(owner, "/api/diagrams", "POST", { title: "First" }),
    );
    await request(
      await apiWrite(owner, "/api/diagrams", "POST", { title: "Second" }),
    );

    const response = await request(
      await apiRequest(ADMIN_EMAIL, "/api/admin/users"),
    );
    expect(response.status).toBe(200);

    const { users, total } = (await response.json()) as AdminUsersPayload;
    expect(total).toBeGreaterThanOrEqual(1);
    const entry = users.find((user) => user.email === owner);
    expect(entry).toMatchObject({ diagramCount: 2, displayName: null });
  });

  it("paginates the user directory with limit and offset", async () => {
    for (let index = 0; index < 3; index += 1) {
      await request(
        await apiRequest(`page-user-${index}@example.com`, "/api/me"),
      );
    }

    const response = await request(
      await apiRequest(ADMIN_EMAIL, "/api/admin/users?limit=1&offset=0"),
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as AdminUsersPayload;
    expect(page.users).toHaveLength(1);
    expect(page.limit).toBe(1);
    expect(page.offset).toBe(0);
    expect(page.total).toBeGreaterThan(1);
  });

  it("rejects an invalid limit query parameter", async () => {
    const response = await request(
      await apiRequest(ADMIN_EMAIL, "/api/admin/users?limit=0"),
    );
    expect(response.status).toBe(422);
  });

  it("rejects a non-administrator identity previewing any diagram with 403", async () => {
    const create = await request(
      await apiWrite("victim5@example.com", "/api/diagrams", "POST", {
        title: "Not yours to preview",
      }),
    );
    const { diagram } = (await create.json()) as { diagram: DiagramPayload };

    const response = await request(
      await apiRequest(
        "mallory@example.com",
        `/api/admin/diagrams/${diagram.id}`,
      ),
    );
    expect(response.status).toBe(403);
  });

  it("previews any user's diagram for the configured administrator, without exposing ownerEmail", async () => {
    const create = await request(
      await apiWrite("victim6@example.com", "/api/diagrams", "POST", {
        title: "Reviewed diagram",
      }),
    );
    const { diagram } = (await create.json()) as { diagram: DiagramPayload };

    const response = await request(
      await apiRequest(ADMIN_EMAIL, `/api/admin/diagrams/${diagram.id}`),
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      diagram: { id: string; title: string; graphData: string };
    };
    expect(body.diagram).toMatchObject({
      id: diagram.id,
      title: "Reviewed diagram",
    });
    expect(body.diagram).not.toHaveProperty("ownerEmail");
  });

  it("returns not found previewing a diagram id that does not exist", async () => {
    const response = await request(
      await apiRequest(
        ADMIN_EMAIL,
        "/api/admin/diagrams/00000000-0000-0000-0000-000000000000",
      ),
    );
    expect(response.status).toBe(404);
  });

  it("deletes any user's diagram as the configured administrator", async () => {
    const create = await request(
      await apiWrite("victim2@example.com", "/api/diagrams", "POST", {
        title: "To be moderated",
      }),
    );
    const { diagram } = (await create.json()) as { diagram: DiagramPayload };

    const deleteResponse = await request(
      await apiRequest(ADMIN_EMAIL, `/api/admin/diagrams/${diagram.id}`, {
        method: "DELETE",
      }),
    );
    expect(deleteResponse.status).toBe(204);

    const getResponse = await request(
      await apiRequest("victim2@example.com", `/api/diagrams/${diagram.id}`),
    );
    expect(getResponse.status).toBe(404);
  });

  it("returns not found deleting a diagram id that does not exist", async () => {
    const response = await request(
      await apiRequest(
        ADMIN_EMAIL,
        "/api/admin/diagrams/00000000-0000-0000-0000-000000000000",
        { method: "DELETE" },
      ),
    );
    expect(response.status).toBe(404);
  });

  it("cascades to revoke every share link when an admin deletes a diagram", async () => {
    const create = await request(
      await apiWrite("victim3@example.com", "/api/diagrams", "POST", {
        title: "Shared, then moderated",
      }),
    );
    const { diagram } = (await create.json()) as { diagram: DiagramPayload };

    const shareResponse = await request(
      await apiWrite(
        "victim3@example.com",
        `/api/diagrams/${diagram.id}/share`,
        "POST",
        {},
      ),
    );
    const { token } = (await shareResponse.json()) as { token: string };

    const deleteResponse = await request(
      await apiRequest(ADMIN_EMAIL, `/api/admin/diagrams/${diagram.id}`, {
        method: "DELETE",
      }),
    );
    expect(deleteResponse.status).toBe(204);

    const shareViewResponse = await request(
      new Request(`${ORIGIN}/api/share/${token}`, {
        headers: { origin: ORIGIN },
      }),
    );
    expect(shareViewResponse.status).toBe(404);
  });

  it("rejects a cross-origin moderation delete", async () => {
    const create = await request(
      await apiWrite("victim4@example.com", "/api/diagrams", "POST", {
        title: "Cross-origin target",
      }),
    );
    const { diagram } = (await create.json()) as { diagram: DiagramPayload };

    const token = await signDevJwt(ADMIN_EMAIL);
    const response = await request(
      new Request(`${ORIGIN}/api/admin/diagrams/${diagram.id}`, {
        headers: { [JWT_HEADER]: token, origin: "https://evil.example" },
        method: "DELETE",
      }),
    );
    expect(response.status).toBe(403);
  });
});
