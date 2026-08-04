import { abortAllDurableObjects, applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authenticatedRequest,
  createChat,
  createFakeAi,
  ensureSignedIn,
  openChatSocket,
  sendTurn,
  unauthenticatedRequest,
  withFakeAi,
} from "./fixtures";

/** Test-only Worker bindings injected by the integration Vitest project. */
interface TestEnv extends Env {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/** One row of `GET /api/admin/users`'s response. */
interface AdminUserJson {
  email: string;
  isAdmin: boolean;
  business: string | null;
  geo: string | null;
  usage: {
    totalCostUsd: number;
    turnCount: number;
    confirmedTurnCount: number;
  };
}

/** One row of either segment report's response. */
interface ReportRowJson {
  business?: string | null;
  geo?: string | null;
  usage: { totalCostUsd: number };
}

/**
 * Storage isolation in this pool is per test **file**, not per test (mirrors
 * `tests/integration/chat-management.test.ts`'s own rationale) -- every `it()` below shares one
 * D1 database across the whole file, and `GET /api/admin/users` inherently lists *every* user
 * that has ever signed in during this file's tests. A fresh, per-test identity sidesteps any
 * cross-test interference instead of resetting D1 between tests.
 *
 * @param prefix Short label identifying which test generated this identity.
 * @returns A verified-identity email unique to this call.
 */
function uniqueEmail(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}@example.com`;
}

/**
 * Exercises Phase 7's admin cost/metadata console (US-6, docs/06-AGENTIC-CHAT.md): `requireAdmin`
 * enforcement on every `/api/admin/*` route, the ranked user-cost table, business/geo metadata
 * mutation, and both segment reports.
 */
describe("Admin cost/metadata console (US-6)", () => {
  const openSockets = new Set<WebSocket>();

  beforeAll(async () => {
    const testEnv = env as TestEnv;
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  afterEach(async () => {
    for (const socket of openSockets) {
      if (
        socket.readyState !== WebSocket.CLOSED &&
        socket.readyState !== WebSocket.CLOSING
      ) {
        socket.close();
      }
    }
    openSockets.clear();
    await abortAllDurableObjects();
  });

  /**
   * Sign in, create one chat, and complete one turn against a fake model with known token
   * counts -- the admin console's cost figures are read straight from the same `chat_usage`
   * ledger Phase 6 already writes, so this reuses that same real path end to end rather than
   * inserting a ledger row directly.
   *
   * @param email Identity to sign in and create the chat as.
   * @param promptTokens This turn's fake prompt token count.
   * @param completionTokens This turn's fake completion token count.
   */
  async function userWithCost(
    email: string,
    promptTokens: number,
    completionTokens: number,
  ): Promise<void> {
    await ensureSignedIn(email);
    const chatId = await createChat(email);
    const socket = await openChatSocket(chatId, openSockets, email);
    await withFakeAi(
      createFakeAi([
        '{"response":"Hello"}',
        `{"response":"","usage":{"prompt_tokens":${promptTokens},"completion_tokens":${completionTokens},"total_tokens":${promptTokens + completionTokens}}}`,
        "[DONE]",
      ]),
      () => sendTurn(socket, "hi"),
    );
  }

  it("rejects an unauthenticated request to every admin route", async () => {
    const responses = await Promise.all([
      unauthenticatedRequest("/api/admin/users"),
      unauthenticatedRequest("/api/admin/reports/by-business"),
      unauthenticatedRequest("/api/admin/reports/by-geo"),
      unauthenticatedRequest(
        `/api/admin/users/${encodeURIComponent(uniqueEmail("unauth-patch"))}`,
        { body: "{}", method: "PATCH" },
      ),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
    }
  });

  it("rejects a signed-in, non-administrator identity with 403 from every admin route", async () => {
    const nonAdmin = uniqueEmail("non-admin");
    await ensureSignedIn(nonAdmin);

    const responses = await Promise.all([
      authenticatedRequest("/api/admin/users", {}, nonAdmin),
      authenticatedRequest("/api/admin/reports/by-business", {}, nonAdmin),
      authenticatedRequest("/api/admin/reports/by-geo", {}, nonAdmin),
      authenticatedRequest(
        `/api/admin/users/${encodeURIComponent(nonAdmin)}`,
        {
          body: JSON.stringify({ business: "field", geo: "emea" }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        },
        nonAdmin,
      ),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(403);
    }
  });

  it("lets the administrator identity read every user's cost, ranked by total cost descending", async () => {
    const adminEmail = (env as TestEnv).ADMIN_EMAIL;
    await ensureSignedIn(adminEmail);
    const higher = uniqueEmail("higher-cost");
    const lower = uniqueEmail("lower-cost");
    await userWithCost(higher, 1_000, 1_000);
    await userWithCost(lower, 1, 1);

    const response = await authenticatedRequest(
      "/api/admin/users",
      {},
      adminEmail,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { users: AdminUserJson[] };
    const higherEntry = body.users.find((user) => user.email === higher);
    const lowerEntry = body.users.find((user) => user.email === lower);
    expect(higherEntry?.usage).toMatchObject({
      confirmedTurnCount: 0,
      turnCount: 1,
    });
    expect(lowerEntry?.usage).toMatchObject({
      confirmedTurnCount: 0,
      turnCount: 1,
    });
    expect(higherEntry?.usage.totalCostUsd).toBeGreaterThan(
      lowerEntry?.usage.totalCostUsd ?? 0,
    );
    const higherIndex = body.users.findIndex((user) => user.email === higher);
    const lowerIndex = body.users.findIndex((user) => user.email === lower);
    expect(higherIndex).toBeGreaterThanOrEqual(0);
    expect(higherIndex).toBeLessThan(lowerIndex);
  }, 20_000);

  it("reports a zeroed usage summary for a signed-in user with no chats yet", async () => {
    const adminEmail = (env as TestEnv).ADMIN_EMAIL;
    await ensureSignedIn(adminEmail);
    const chatless = uniqueEmail("chatless");
    await ensureSignedIn(chatless);

    const response = await authenticatedRequest(
      "/api/admin/users",
      {},
      adminEmail,
    );

    const body = (await response.json()) as { users: AdminUserJson[] };
    const entry = body.users.find((user) => user.email === chatless);
    expect(entry?.usage).toMatchObject({ totalCostUsd: 0, turnCount: 0 });
  });

  it("lets the administrator mutate any user's business/geo metadata", async () => {
    const adminEmail = (env as TestEnv).ADMIN_EMAIL;
    await ensureSignedIn(adminEmail);
    const target = uniqueEmail("metadata-target");
    await ensureSignedIn(target);

    const patchResponse = await authenticatedRequest(
      `/api/admin/users/${encodeURIComponent(target)}`,
      {
        body: JSON.stringify({ business: "leadership", geo: "apac" }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
      adminEmail,
    );

    expect(patchResponse.status).toBe(200);
    expect(await patchResponse.json()).toMatchObject({
      user: { business: "leadership", email: target, geo: "apac" },
    });

    const listResponse = await authenticatedRequest(
      "/api/admin/users",
      {},
      adminEmail,
    );
    const body = (await listResponse.json()) as { users: AdminUserJson[] };
    expect(body.users.find((user) => user.email === target)).toMatchObject({
      business: "leadership",
      geo: "apac",
    });
  });

  it("clears both fields back to null when patched with null", async () => {
    const adminEmail = (env as TestEnv).ADMIN_EMAIL;
    await ensureSignedIn(adminEmail);
    const target = uniqueEmail("clear-metadata");
    await ensureSignedIn(target);
    await authenticatedRequest(
      `/api/admin/users/${encodeURIComponent(target)}`,
      {
        body: JSON.stringify({ business: "product", geo: "americas" }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
      adminEmail,
    );

    const clearResponse = await authenticatedRequest(
      `/api/admin/users/${encodeURIComponent(target)}`,
      {
        body: JSON.stringify({ business: null, geo: null }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
      adminEmail,
    );

    expect(clearResponse.status).toBe(200);
    expect(await clearResponse.json()).toMatchObject({
      user: { business: null, geo: null },
    });
  });

  it("rejects a JSON body that parses to a non-object (a bare string) with 400", async () => {
    const adminEmail = (env as TestEnv).ADMIN_EMAIL;
    await ensureSignedIn(adminEmail);
    const target = uniqueEmail("non-object-body");
    await ensureSignedIn(target);

    const response = await authenticatedRequest(
      `/api/admin/users/${encodeURIComponent(target)}`,
      {
        body: JSON.stringify("just a string, not an object"),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
      adminEmail,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      detail: "Request body must be a JSON object with business and geo.",
    });
  });

  it("rejects a JSON body that parses to null with 400", async () => {
    const adminEmail = (env as TestEnv).ADMIN_EMAIL;
    await ensureSignedIn(adminEmail);
    const target = uniqueEmail("null-body");
    await ensureSignedIn(target);

    const response = await authenticatedRequest(
      `/api/admin/users/${encodeURIComponent(target)}`,
      {
        body: JSON.stringify(null),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
      adminEmail,
    );

    expect(response.status).toBe(400);
  });

  it("rejects a malformed (non-JSON) body with 400", async () => {
    const adminEmail = (env as TestEnv).ADMIN_EMAIL;
    await ensureSignedIn(adminEmail);
    const target = uniqueEmail("malformed-body");
    await ensureSignedIn(target);

    const response = await authenticatedRequest(
      `/api/admin/users/${encodeURIComponent(target)}`,
      {
        body: "not json at all",
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
      adminEmail,
    );

    expect(response.status).toBe(400);
  });

  it("rejects an invalid business value with 400 and does not write it", async () => {
    const adminEmail = (env as TestEnv).ADMIN_EMAIL;
    await ensureSignedIn(adminEmail);
    const target = uniqueEmail("invalid-business");
    await ensureSignedIn(target);

    const response = await authenticatedRequest(
      `/api/admin/users/${encodeURIComponent(target)}`,
      {
        body: JSON.stringify({ business: "not-a-real-segment", geo: "emea" }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
      adminEmail,
    );

    expect(response.status).toBe(400);
    const listResponse = await authenticatedRequest(
      "/api/admin/users",
      {},
      adminEmail,
    );
    const body = (await listResponse.json()) as { users: AdminUserJson[] };
    expect(
      body.users.find((user) => user.email === target)?.business,
    ).toBeNull();
  });

  it("rejects an invalid geo value with 400", async () => {
    const adminEmail = (env as TestEnv).ADMIN_EMAIL;
    await ensureSignedIn(adminEmail);
    const target = uniqueEmail("invalid-geo");
    await ensureSignedIn(target);

    const response = await authenticatedRequest(
      `/api/admin/users/${encodeURIComponent(target)}`,
      {
        body: JSON.stringify({ business: "field", geo: "not-a-real-geo" }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
      adminEmail,
    );

    expect(response.status).toBe(400);
  });

  it("returns 404 patching metadata for an email with no users row at all", async () => {
    const adminEmail = (env as TestEnv).ADMIN_EMAIL;
    await ensureSignedIn(adminEmail);

    const response = await authenticatedRequest(
      `/api/admin/users/${encodeURIComponent(uniqueEmail("ghost"))}`,
      {
        body: JSON.stringify({ business: "field", geo: "emea" }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
      adminEmail,
    );

    expect(response.status).toBe(404);
  });

  it("reports cost-by-business totals matching the sum of the constituent users' chat_usage rows", async () => {
    const adminEmail = (env as TestEnv).ADMIN_EMAIL;
    await ensureSignedIn(adminEmail);
    const fieldUser = uniqueEmail("field-user");
    const productUser = uniqueEmail("product-user");
    await userWithCost(fieldUser, 100, 100);
    await userWithCost(productUser, 200, 200);
    await authenticatedRequest(
      `/api/admin/users/${encodeURIComponent(fieldUser)}`,
      {
        body: JSON.stringify({ business: "field", geo: null }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
      adminEmail,
    );
    await authenticatedRequest(
      `/api/admin/users/${encodeURIComponent(productUser)}`,
      {
        body: JSON.stringify({ business: "product", geo: null }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
      adminEmail,
    );

    const usersResponse = await authenticatedRequest(
      "/api/admin/users",
      {},
      adminEmail,
    );
    const usersBody = (await usersResponse.json()) as {
      users: AdminUserJson[];
    };
    const fieldEntry = usersBody.users.find((user) => user.email === fieldUser);
    const productEntry = usersBody.users.find(
      (user) => user.email === productUser,
    );

    const reportResponse = await authenticatedRequest(
      "/api/admin/reports/by-business",
      {},
      adminEmail,
    );
    expect(reportResponse.status).toBe(200);
    const reportBody = (await reportResponse.json()) as {
      report: ReportRowJson[];
    };
    const fieldReport = reportBody.report.find(
      (row) => row.business === "field",
    );
    const productReport = reportBody.report.find(
      (row) => row.business === "product",
    );
    // Each segment in this test has exactly one contributing user, so the report's own total
    // must equal that single user's total exactly, not merely approximately.
    expect(fieldReport?.usage.totalCostUsd).toBe(
      fieldEntry?.usage.totalCostUsd,
    );
    expect(productReport?.usage.totalCostUsd).toBe(
      productEntry?.usage.totalCostUsd,
    );
    expect(fieldReport?.usage.totalCostUsd).toBeGreaterThan(0);
  }, 20_000);

  it("reports cost-by-geo totals the same way", async () => {
    const adminEmail = (env as TestEnv).ADMIN_EMAIL;
    await ensureSignedIn(adminEmail);
    const emeaUser = uniqueEmail("emea-user");
    await userWithCost(emeaUser, 50, 50);
    await authenticatedRequest(
      `/api/admin/users/${encodeURIComponent(emeaUser)}`,
      {
        body: JSON.stringify({ business: null, geo: "emea" }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
      adminEmail,
    );

    const usersResponse = await authenticatedRequest(
      "/api/admin/users",
      {},
      adminEmail,
    );
    const usersBody = (await usersResponse.json()) as {
      users: AdminUserJson[];
    };
    const emeaEntry = usersBody.users.find((user) => user.email === emeaUser);

    const reportResponse = await authenticatedRequest(
      "/api/admin/reports/by-geo",
      {},
      adminEmail,
    );
    const reportBody = (await reportResponse.json()) as {
      report: ReportRowJson[];
    };
    const emeaReport = reportBody.report.find((row) => row.geo === "emea");
    expect(emeaReport?.usage.totalCostUsd).toBe(emeaEntry?.usage.totalCostUsd);
    expect(emeaReport?.usage.totalCostUsd).toBeGreaterThan(0);
  }, 20_000);
});
