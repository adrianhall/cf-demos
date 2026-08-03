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
async function apiRequest(email: string, path: string): Promise<Request> {
  const token = await signDevJwt(email);
  const headers = new Headers({ [JWT_HEADER]: token });
  return new Request(`https://agentic-chat.example${path}`, { headers });
}

/** Integration tests run against the generated configuration and real Miniflare D1 binding. */
describe("Agentic Chat Worker", () => {
  beforeAll(async () => {
    const testEnv = env as TestEnv;
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  it("rejects an unauthenticated GET /api/me request", async () => {
    const response = await exports.default.fetch(
      new Request("https://agentic-chat.example/api/me"),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("binds CLOUDFLARE_TEAM_DOMAIN so cloudflareAccess can verify real Access tokens in production", () => {
    // Regression test: mirrors demos/todo-app's own test for the same failure mode. Locally and
    // in this test suite, `enableDevTokens` masks a missing team domain entirely, since
    // signDevJwt()-signed tokens never reach the JWKS verification path that reads this binding.
    // In a deployed Worker (where dev tokens are disabled), a missing team domain makes
    // cloudflareAccess() reject every request with 401, since it has nothing to verify against.
    expect((env as TestEnv).CLOUDFLARE_TEAM_DOMAIN).toBeTruthy();
  });

  it("upserts a D1 row and returns isAdmin: false for an ordinary identity", async () => {
    const response = await exports.default.fetch(
      await apiRequest("alice@example.com", "/api/me"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      email: "alice@example.com",
      isAdmin: false,
    });
  });

  it("idempotently promotes the configured ADMIN_EMAIL identity to isAdmin: true", async () => {
    const adminEmail = (env as TestEnv).ADMIN_EMAIL;

    const first = await exports.default.fetch(
      await apiRequest(adminEmail, "/api/me"),
    );
    expect(await first.json()).toEqual({ email: adminEmail, isAdmin: true });

    // A second sign-in must converge to the same result, not create a duplicate row or fail on
    // the users table's email primary key.
    const second = await exports.default.fetch(
      await apiRequest(adminEmail, "/api/me"),
    );
    expect(await second.json()).toEqual({ email: adminEmail, isAdmin: true });
  });

  it("never promotes an identity that does not match ADMIN_EMAIL", async () => {
    const response = await exports.default.fetch(
      await apiRequest("not-the-admin@example.com", "/api/me"),
    );

    expect(await response.json()).toEqual({
      email: "not-the-admin@example.com",
      isAdmin: false,
    });
  });
});
