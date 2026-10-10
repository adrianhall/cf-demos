import {
  applyD1Migrations,
  evictAllDurableObjects,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ALICE,
  authenticatedRequest,
  BOB,
  type CapturedAiCall,
  createCapturingFakeAi,
  createChat,
  createFakeAi,
  openChatSocket,
  sendTurn,
  unauthenticatedRequest,
  withFakeAi,
} from "./fixtures";

/** Test-only Worker bindings injected by the integration Vitest project. */
interface TestEnv extends Env {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/**
 * Exercises `ChatAgent` (US-1, docs/06-AGENTIC-CHAT.md Phase 2) through the real, fully
 * authenticated `/api/chats` routes rather than calling the Durable Object stub directly, so the
 * Worker's ownership enforcement is actually under test, not merely assumed. Follows the
 * `testing-durable-objects` skill's lifecycle rules for a WebSocket/Durable-Object suite: every
 * socket a test opens is tracked and force-closed in `afterEach` via
 * `evictAllDurableObjects({ webSockets: "close" })`, and this project sets
 * `fileParallelism: false` (see `vitest.config.ts`).
 */
describe("Chat agent (US-1)", () => {
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

  it("creates a chat owned by the signed-in identity", async () => {
    const response = await authenticatedRequest(
      "/api/chats",
      { method: "POST" },
      ALICE,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      chat: { id: string; ownerEmail: string; title: null; route: string };
    };
    expect(body.chat.ownerEmail).toBe(ALICE);
    expect(body.chat.title).toBeNull();
    // Defaults to the "basic" governed route (docs/06-AGENTIC-CHAT.md Phase 4, US-3).
    expect(body.chat.route).toBe("basic");
    expect(body.chat.id).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("rejects unauthenticated chat creation", async () => {
    const response = await unauthenticatedRequest("/api/chats", {
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("rejects an unauthenticated WebSocket upgrade", async () => {
    const chatId = await createChat(ALICE);

    const response = await unauthenticatedRequest(`/api/chats/${chatId}/ws`, {
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(401);
  });

  it("rejects a WebSocket upgrade request missing the Upgrade header", async () => {
    const chatId = await createChat(ALICE);

    const response = await authenticatedRequest(
      `/api/chats/${chatId}/ws`,
      {},
      ALICE,
    );

    expect(response.status).toBe(400);
  });

  it("rejects a different user's request for someone else's chat with 404, not 403", async () => {
    const chatId = await createChat(ALICE);

    const wsResponse = await authenticatedRequest(
      `/api/chats/${chatId}/ws`,
      { headers: { Upgrade: "websocket" } },
      BOB,
    );
    expect(wsResponse.status).toBe(404);

    const messagesResponse = await authenticatedRequest(
      `/api/chats/${chatId}/get-messages`,
      {},
      BOB,
    );
    expect(messagesResponse.status).toBe(404);
  });

  it("returns 404 for a chat id that was never created, indistinguishable from a foreign one", async () => {
    const response = await authenticatedRequest(
      `/api/chats/${crypto.randomUUID()}/get-messages`,
      {},
      ALICE,
    );

    expect(response.status).toBe(404);
  });

  it("streams a real turn end to end against a fake model and persists it for later reload", async () => {
    const chatId = await createChat(ALICE);
    const fakeAi = createFakeAi([
      '{"response":"Hello"}',
      '{"response":" from the fake model"}',
      '{"response":"","usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}',
      "[DONE]",
    ]);

    const rawBody = await withFakeAi(fakeAi, async () => {
      const socket = await openChatSocket(chatId, openSockets, ALICE);
      return sendTurn(socket, "Say hello");
    });

    expect(rawBody).toContain('"type":"start"');
    expect(rawBody).toContain('"delta":"Hello"');
    expect(rawBody).toContain('"delta":" from the fake model"');
    expect(rawBody).toContain('"type":"finish"');

    // A reload -- a brand-new request with no in-memory state -- must repopulate the same
    // transcript from durable storage (US-1's acceptance criterion), not from browser memory.
    const historyResponse = await authenticatedRequest(
      `/api/chats/${chatId}/get-messages`,
      {},
      ALICE,
    );
    expect(historyResponse.status).toBe(200);
    const messages = (await historyResponse.json()) as {
      id: string;
      role: string;
      parts: { type: string; text?: string }[];
    }[];
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.parts.some((part) => part.text === "Say hello")).toBe(
      true,
    );
    expect(messages[1]?.role).toBe("assistant");
    const assistantText = messages[1]?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(assistantText).toBe("Hello from the fake model");
  }, 15_000);

  it("persists multi-turn conversation history across two separate connections to the same chat", async () => {
    const chatId = await createChat(ALICE);

    await withFakeAi(
      createFakeAi(['{"response":"pineapple"}', "[DONE]"]),
      async () => {
        const firstSocket = await openChatSocket(chatId, openSockets, ALICE);
        await sendTurn(firstSocket, "Remember the secret word: pineapple");
      },
    );

    const secondTurnBody = await withFakeAi(
      createFakeAi(['{"response":"The word was pineapple."}', "[DONE]"]),
      async () => {
        const secondSocket = await openChatSocket(chatId, openSockets, ALICE);
        return sendTurn(secondSocket, "What was the secret word?");
      },
    );

    expect(secondTurnBody).toContain('"delta":"The word was pineapple."');

    const historyResponse = await authenticatedRequest(
      `/api/chats/${chatId}/get-messages`,
      {},
      ALICE,
    );
    const messages = (await historyResponse.json()) as { role: string }[];
    // Two user turns and two assistant turns, all persisted under the same chat id.
    expect(messages).toHaveLength(4);
  }, 15_000);

  it("carries the routed owner's identity into the model's system prompt", async () => {
    const chatId = await createChat(ALICE);
    const capture: { call?: CapturedAiCall } = {};

    await withFakeAi(
      createCapturingFakeAi(['{"response":"hi"}', "[DONE]"], capture),
      async () => {
        const socket = await openChatSocket(chatId, openSockets, ALICE);
        await sendTurn(socket, "hi");
      },
    );

    expect(JSON.stringify(capture.call?.input)).toContain(ALICE);
  }, 15_000);

  it("falls back to a generic label in the system prompt when onStart never receives an owner identity", async () => {
    // Bypasses the Worker's own `getAgentByName(..., { props })` routing (`routes/chats.ts`) to
    // reach `ChatAgent`'s `onStart()` lifecycle hook directly with no props at all -- the one
    // path (per `AIChatAgent`'s own `onStart(props?: ChatAgentProps)` typing) that
    // `chat-agent.ts`'s `this.ownerEmail ?? "the signed-in user"` fallback defends against, and
    // one no ordinary route through this Worker can ever exercise.
    const stub = env.CHAT_AGENT.getByName(`no-props-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance) => {
      await instance.onStart(undefined);
    });
    const capture: { call?: CapturedAiCall } = {};

    const rawResponseBody = await withFakeAi(
      createCapturingFakeAi(['{"response":"hi"}', "[DONE]"], capture),
      async () => {
        const upgradeResponse = await stub.fetch(
          new Request("https://chat.internal/ws", {
            headers: { Upgrade: "websocket" },
          }),
        );
        const socket = upgradeResponse.webSocket;
        if (socket === null) {
          throw new Error("Expected a WebSocket upgrade from the raw stub.");
        }
        openSockets.add(socket);
        socket.accept();
        return sendTurn(socket, "hi");
      },
    );

    expect(rawResponseBody).toContain('"delta":"hi"');
    expect(JSON.stringify(capture.call?.input)).toContain("the signed-in user");
  }, 15_000);
});
