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

  it("rejects an unauthenticated API request", async () => {
    const response = await exports.default.fetch(
      new Request("https://tasks.example/api/todos"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

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
});
