import { applyD1Migrations } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { JWT_HEADER, signDevJwt } from "@adrianhall/cloudflare-toolkit/testing";
import { beforeAll, describe, expect, it } from "vitest";

/** Test-only Worker bindings injected by the integration Vitest project. */
interface TestEnv extends Env {
  /** Parsed D1 migrations that initialize Miniflare's otherwise empty D1 database. */
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/** Create an authenticated API request for one development Access identity. */
async function apiRequest(
  email: string,
  path: string,
  init: RequestInit = {},
): Promise<Request> {
  const token = await signDevJwt(email);
  const headers = new Headers(init.headers);
  headers.set(JWT_HEADER, token);
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new Request(`https://tasks.example${path}`, { ...init, headers });
}

/** Read the TODO field from a successful create or update response. */
async function todoFrom(
  response: Response,
): Promise<{ id: string; completed: boolean; title: string }> {
  return (
    (await response.json()) as {
      todo: { id: string; completed: boolean; title: string };
    }
  ).todo;
}

/** Integration tests run against the generated configuration and real Miniflare D1 binding. */
describe("Tasks Worker", () => {
  beforeAll(async () => {
    const testEnv = env as TestEnv;
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  it.each([
    ["GET", "/api/me"],
    ["GET", "/api/todos"],
    ["POST", "/api/todos"],
    ["PATCH", "/api/todos/5d837139-c37f-4fe3-b95c-69757a3a823d"],
    ["DELETE", "/api/todos/completed"],
    ["DELETE", "/api/todos/5d837139-c37f-4fe3-b95c-69757a3a823d"],
  ])("rejects an unauthenticated %s request to %s", async (method, path) => {
    const response = await exports.default.fetch(
      new Request(`https://tasks.example${path}`, { method }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("binds CLOUDFLARE_TEAM_DOMAIN so cloudflareAccess can verify real Access tokens in production", () => {
    // Regression test: this Worker previously omitted CLOUDFLARE_TEAM_DOMAIN from
    // wrangler.jsonc.tpl entirely. Locally and in this test suite, `enableDevTokens` masked the
    // gap because signDevJwt()-signed tokens never reach the JWKS verification path that reads
    // this binding — every request here still returned 200/401 as expected either way. In a
    // deployed Worker (where dev tokens are disabled), a missing team domain makes
    // cloudflareAccess() reject every request with 401, since it has nothing to verify against.
    expect((env as TestEnv).CLOUDFLARE_TEAM_DOMAIN).toBeTruthy();
  });

  it("returns the identity from a verified Access token", async () => {
    const response = await exports.default.fetch(
      await apiRequest("identity@example.com", "/api/me"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: "identity@example.com" });
  });

  it.each([
    ["POST", "/api/todos"],
    ["PATCH", "/api/todos/5d837139-c37f-4fe3-b95c-69757a3a823d"],
  ])(
    "returns problem details for malformed JSON on %s %s",
    async (method, path) => {
      const response = await exports.default.fetch(
        await apiRequest("invalid-json@example.com", path, {
          body: "{",
          method,
        }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        detail: "Request body must contain valid JSON.",
      });
    },
  );

  it("creates, completes, lists, and deletes a TODO", async () => {
    const createResponse = await exports.default.fetch(
      await apiRequest("alice@example.com", "/api/todos", {
        body: JSON.stringify({ title: "Create the demo" }),
        method: "POST",
      }),
    );
    expect(createResponse.status).toBe(201);
    const created = await todoFrom(createResponse);
    expect(created).toMatchObject({
      completed: false,
      title: "Create the demo",
    });

    const completeResponse = await exports.default.fetch(
      await apiRequest("alice@example.com", `/api/todos/${created.id}`, {
        body: JSON.stringify({ completed: true }),
        method: "PATCH",
      }),
    );
    expect(await todoFrom(completeResponse)).toMatchObject({
      completed: true,
      id: created.id,
    });

    const listResponse = await exports.default.fetch(
      await apiRequest("alice@example.com", "/api/todos"),
    );
    expect(await listResponse.json()).toMatchObject({
      todos: [expect.objectContaining({ completed: true, id: created.id })],
    });

    const deleteResponse = await exports.default.fetch(
      await apiRequest("alice@example.com", `/api/todos/${created.id}`, {
        method: "DELETE",
      }),
    );
    expect(deleteResponse.status).toBe(204);
  });

  it("updates only the provided TODO field", async () => {
    const createResponse = await exports.default.fetch(
      await apiRequest("partial-update@example.com", "/api/todos", {
        body: JSON.stringify({ title: "Original" }),
        method: "POST",
      }),
    );
    const created = await todoFrom(createResponse);

    const renamed = await exports.default.fetch(
      await apiRequest(
        "partial-update@example.com",
        `/api/todos/${created.id}`,
        {
          body: JSON.stringify({ title: "Renamed" }),
          method: "PATCH",
        },
      ),
    );
    expect(await todoFrom(renamed)).toMatchObject({
      completed: false,
      title: "Renamed",
    });

    const completed = await exports.default.fetch(
      await apiRequest(
        "partial-update@example.com",
        `/api/todos/${created.id}`,
        {
          body: JSON.stringify({ completed: true }),
          method: "PATCH",
        },
      ),
    );
    expect(await todoFrom(completed)).toMatchObject({
      completed: true,
      title: "Renamed",
    });
  });

  it("does not expose or mutate a different user's TODO", async () => {
    const createResponse = await exports.default.fetch(
      await apiRequest("bob@example.com", "/api/todos", {
        body: JSON.stringify({ title: "Bob private task" }),
        method: "POST",
      }),
    );
    const bobTodo = await todoFrom(createResponse);

    const aliceList = await exports.default.fetch(
      await apiRequest("alice-isolation@example.com", "/api/todos"),
    );
    expect(await aliceList.json()).toEqual({ todos: [] });

    for (const method of ["PATCH", "DELETE"] as const) {
      const response = await exports.default.fetch(
        await apiRequest(
          "alice-isolation@example.com",
          `/api/todos/${bobTodo.id}`,
          {
            ...(method === "PATCH"
              ? { body: JSON.stringify({ completed: true }) }
              : {}),
            method,
          },
        ),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain(
        "application/problem+json",
      );
    }
  });

  it("clears only the current user's completed TODOs", async () => {
    const create = async (email: string, title: string): Promise<string> => {
      const response = await exports.default.fetch(
        await apiRequest(email, "/api/todos", {
          body: JSON.stringify({ title }),
          method: "POST",
        }),
      );
      return (await todoFrom(response)).id;
    };
    const userId = "clear@example.com";
    const completedId = await create(userId, "Completed task");
    await create(userId, "Active task");
    await create("other-clear@example.com", "Other user's task");

    await exports.default.fetch(
      await apiRequest(userId, `/api/todos/${completedId}`, {
        body: JSON.stringify({ completed: true }),
        method: "PATCH",
      }),
    );
    const clearResponse = await exports.default.fetch(
      await apiRequest(userId, "/api/todos/completed", { method: "DELETE" }),
    );
    expect(clearResponse.status).toBe(204);

    const userTodos = await exports.default.fetch(
      await apiRequest(userId, "/api/todos"),
    );
    expect(await userTodos.json()).toMatchObject({
      todos: [expect.objectContaining({ title: "Active task" })],
    });

    const otherTodos = await exports.default.fetch(
      await apiRequest("other-clear@example.com", "/api/todos"),
    );
    expect(await otherTodos.json()).toMatchObject({
      todos: [expect.objectContaining({ title: "Other user's task" })],
    });
  });
});
