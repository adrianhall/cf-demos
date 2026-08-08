import { applyD1Migrations } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { JWT_HEADER, signDevJwt } from "@adrianhall/cloudflare-toolkit/testing";
import { beforeAll, describe, expect, it } from "vitest";

/** Test-only Worker bindings injected by the integration Vitest project. */
interface TestEnv extends Env {
  /** Parsed D1 migrations that initialize Miniflare's otherwise empty D1 database. */
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/** Raw `users` row shape read back directly from D1 for assertions. */
interface UserRow {
  email: string;
  display_name: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

/** Build an authenticated `/api/*` request for one development Access identity. */
async function apiRequest(email: string, path: string): Promise<Request> {
  const token = await signDevJwt(email);
  return new Request(`https://architect.example${path}`, {
    headers: { [JWT_HEADER]: token },
  });
}

/** Dispatch a request through the configured Worker. */
async function request(requestValue: Request): Promise<Response> {
  return exports.default.fetch(requestValue);
}

describe("Architect Worker", () => {
  beforeAll(async () => {
    const testEnv = env as TestEnv;
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  it("rejects an unauthenticated /api/me request", async () => {
    const response = await request(
      new Request("https://architect.example/api/me"),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("binds CLOUDFLARE_TEAM_DOMAIN so cloudflareAccess can verify real Access tokens in production", () => {
    // Regression test: a missing team domain would make cloudflareAccess() reject every
    // request in a deployed Worker (dev tokens masked such a gap here, since signDevJwt()
    // tokens never reach the JWKS verification path that reads this binding).
    expect((env as TestEnv).CLOUDFLARE_TEAM_DOMAIN).toBeTruthy();
  });

  it("reports isAdmin false for a non-administrator identity", async () => {
    const response = await request(
      await apiRequest("alice@example.com", "/api/me"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      email: "alice@example.com",
      isAdmin: false,
    });
  });

  it("reports isAdmin true for the configured ADMIN_EMAIL identity", async () => {
    const response = await request(
      await apiRequest("admin@example.com", "/api/me"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      email: "admin@example.com",
      isAdmin: true,
    });
  });

  it("upserts a users directory row on first authentication and refreshes it on the next", async () => {
    const userEmail = "directory@example.com";

    const first = await request(await apiRequest(userEmail, "/api/me"));
    expect(first.status).toBe(200);

    const afterFirst = await (env as TestEnv).DB.prepare(
      "SELECT email, display_name, first_seen_at, last_seen_at FROM users WHERE email = ?",
    )
      .bind(userEmail)
      .first<UserRow>();
    expect(afterFirst).toMatchObject({
      display_name: null,
      email: userEmail,
    });

    const second = await request(await apiRequest(userEmail, "/api/me"));
    expect(second.status).toBe(200);

    const afterSecond = await (env as TestEnv).DB.prepare(
      "SELECT email, first_seen_at, last_seen_at FROM users WHERE email = ?",
    )
      .bind(userEmail)
      .first<UserRow>();
    expect(afterSecond?.first_seen_at).toBe(afterFirst?.first_seen_at);
    expect(
      (afterSecond?.last_seen_at ?? "") >= (afterFirst?.last_seen_at ?? ""),
    ).toBe(true);
  });

  it("returns a not-found problem for an unmounted API route", async () => {
    const response = await request(
      await apiRequest("alice@example.com", "/api/diagrams"),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });
});
