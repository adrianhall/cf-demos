import { applyD1Migrations, evictAllDurableObjects } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authenticatedRequest,
  type CapturedAiCall,
  createCapturingFakeAi,
  createChat,
  createFakeAiWithTitle,
  openChatSocket,
  sendTurn,
  unauthenticatedRequest,
  withFakeAi,
} from "./fixtures";

/** Test-only Worker bindings injected by the integration Vitest project. */
interface TestEnv extends Env {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/** A verified-identity email unique to one test, so per-owner assertions in this file never
 * collide with another test's chats (mirrors `chat-management.test.ts`'s own helper -- this
 * pool's storage isolation is per test file, not per test). */
function uniqueEmail(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}@example.com`;
}

/**
 * Exercises Phase 4's governed model selection (US-3, docs/06-AGENTIC-CHAT.md): a chat defaults
 * to the "basic" route, its route can be changed via `PATCH /api/chats/:id` only before its
 * first turn completes, an invalid route is rejected before any model call, and each of the two
 * routes resolves to the correct AI Gateway dynamic route name.
 *
 * Per this phase's own decision (recorded in `EXPLAIN-DEMO.md`): every test here substitutes a
 * fake `env.AI` binding and asserts on the exact `dynamic/<route-name>` model id string
 * `ChatAgent` calls it with, rather than making a real network call against a live AI Gateway --
 * consistent with every earlier phase's own "inject a fake `Ai`" testing convention (Phase 2),
 * and avoiding a test that could only pass against a real, already-deployed account. The two
 * real route names this asserts against (`env.AI_GATEWAY_ROUTE_BASIC`/
 * `env.AI_GATEWAY_ROUTE_REASONING`) are Worker vars, not hard-coded literals, so this test stays
 * correct whether it runs against the local placeholder values (`infra/local-outputs.json`) or a
 * real Terraform-generated `wrangler.jsonc`.
 */
describe("Governed model selection via dynamic routes (US-3)", () => {
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
    await evictAllDurableObjects({ webSockets: "close" });
  });

  it("defaults a newly created chat to the basic route", async () => {
    const response = await authenticatedRequest(
      "/api/chats",
      { method: "POST" },
      uniqueEmail("default-route"),
    );

    const body = (await response.json()) as { chat: { route: string } };
    expect(body.chat.route).toBe("basic");
  });

  it("calls the basic route's real dynamic route name, never a raw model id", async () => {
    const owner = uniqueEmail("basic-route");
    const chatId = await createChat(owner);
    const capture: { call?: CapturedAiCall } = {};

    await withFakeAi(
      createCapturingFakeAi(['{"response":"hi"}', "[DONE]"], capture),
      async () => {
        const socket = await openChatSocket(chatId, openSockets, owner);
        await sendTurn(socket, "hi");
      },
    );

    expect(capture.call?.modelId).toBe(`dynamic/${env.AI_GATEWAY_ROUTE_BASIC}`);
  }, 15_000);

  it("calls the reasoning route's real dynamic route name once the chat's route is changed", async () => {
    const owner = uniqueEmail("reasoning-route");
    const chatId = await createChat(owner);

    const patchResponse = await authenticatedRequest(
      `/api/chats/${chatId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: "reasoning" }),
      },
      owner,
    );
    expect(patchResponse.status).toBe(200);
    const patchedBody = (await patchResponse.json()) as {
      chat: { route: string };
    };
    expect(patchedBody.chat.route).toBe("reasoning");

    const capture: { call?: CapturedAiCall } = {};
    await withFakeAi(
      createCapturingFakeAi(['{"response":"hi"}', "[DONE]"], capture),
      async () => {
        const socket = await openChatSocket(chatId, openSockets, owner);
        await sendTurn(socket, "hi");
      },
    );

    expect(capture.call?.modelId).toBe(
      `dynamic/${env.AI_GATEWAY_ROUTE_REASONING}`,
    );
  }, 15_000);

  it("rejects a request body that is not valid JSON, the same way as any other invalid route value", async () => {
    const owner = uniqueEmail("malformed-body");
    const chatId = await createChat(owner);

    const response = await authenticatedRequest(
      `/api/chats/${chatId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "not json",
      },
      owner,
    );

    expect(response.status).toBe(422);
  });

  it("rejects a route value that is not basic/reasoning before any model call, and leaves the chat's route unchanged", async () => {
    const owner = uniqueEmail("invalid-route");
    const chatId = await createChat(owner);

    const response = await authenticatedRequest(
      `/api/chats/${chatId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: "@cf/meta/llama-3.1-8b-instruct" }),
      },
      owner,
    );

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );

    const listResponse = await authenticatedRequest("/api/chats", {}, owner);
    const body = (await listResponse.json()) as {
      chats: { id: string; route: string }[];
    };
    expect(body.chats[0]?.route).toBe("basic");
  });

  it("rejects changing the route once the chat's first turn has already completed", async () => {
    const owner = uniqueEmail("locked-route");
    const chatId = await createChat(owner);

    await withFakeAi(
      createFakeAiWithTitle(['{"response":"hi"}', "[DONE]"], "Title"),
      async () => {
        const socket = await openChatSocket(chatId, openSockets, owner);
        await sendTurn(socket, "hi");
      },
    );

    const response = await authenticatedRequest(
      `/api/chats/${chatId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: "reasoning" }),
      },
      owner,
    );

    expect(response.status).toBe(422);
  }, 15_000);

  it("rejects an unauthenticated route-change request", async () => {
    const chatId = await createChat(uniqueEmail("unauth-patch"));

    const response = await unauthenticatedRequest(`/api/chats/${chatId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ route: "reasoning" }),
    });

    expect(response.status).toBe(401);
  });

  it("rejects changing a different identity's chat route with 404, not 403", async () => {
    const owner = uniqueEmail("victim-route");
    const attacker = uniqueEmail("attacker-route");
    const chatId = await createChat(owner);

    const response = await authenticatedRequest(
      `/api/chats/${chatId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: "reasoning" }),
      },
      attacker,
    );

    expect(response.status).toBe(404);
  });
});
