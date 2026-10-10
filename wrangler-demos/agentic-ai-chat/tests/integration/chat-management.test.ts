import { abortAllDurableObjects, applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ChatAgent } from "../../src/worker/agent/chat-agent";
import {
  authenticatedRequest,
  createChat,
  createFakeAiWithTitle,
  openChatSocket,
  sendTurn,
  unauthenticatedRequest,
  withFakeAi,
  withThrowingDb,
} from "./fixtures";

/** Test-only Worker bindings injected by the integration Vitest project. */
interface TestEnv extends Env {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/** The JSON shape `GET /api/chats` and `POST /api/chats` both return a chat as. */
interface ChatJson {
  id: string;
  ownerEmail: string;
  title: string | null;
  route: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Storage isolation in this pool is per test **file**, not per test (Vitest 4's own isolation
 * model, per the Workers Vitest integration's migration guide) -- every `it()` below shares one
 * D1 database across the whole file. `GET /api/chats` is inherently a "list everything this
 * identity owns" endpoint, so a test asserting on that list must use an identity no other test
 * in this file also writes under, or an earlier test's chats would silently leak into a later
 * assertion. A fresh, per-test identity sidesteps that instead of resetting D1 between tests.
 *
 * @param prefix Short label identifying which test generated this identity, for readable
 * failure output.
 * @returns A verified-identity email unique to this call.
 */
function uniqueEmail(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}@example.com`;
}

/**
 * Exercises Phase 3's chat directory and management routes (US-2, docs/06-AGENTIC-CHAT.md) --
 * `GET /api/chats`, `DELETE /api/chats/:id`, auto-titling after a chat's first completed turn,
 * and the removal notification `ChatAgent.destroy()` sends to any client still connected when a
 * chat is deleted.
 *
 * Follows the `testing-durable-objects` skill's lifecycle rules, with one addition specific to
 * this file: `ChatAgent.destroy()` (via the Agents SDK's own base `destroy()`) calls
 * `ctx.abort("destroyed")` on the Durable Object, and afterward
 * `evictAllDurableObjects({ webSockets: "close" })` -- otherwise this repo's standard cleanup --
 * hangs indefinitely trying to gracefully drain an already-aborted actor (observed live:
 * `workerd/api/actor-state.c++:1178: failed: broken.outputGateBroken; jsg.Error: destroyed`,
 * followed by the `afterEach` hook itself timing out). `abortAllDurableObjects()` performs the
 * same "reset every Durable Object instance so no live connection outlives a test" job without
 * attempting that graceful drain, and does not hang on an instance that destroyed itself. This
 * is a new, file-specific gotcha beyond the skill's existing six; see `docs/DECISIONS.md`.
 */
describe("Chat directory and management (US-2)", () => {
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

  /** List the signed-in identity's own chats through the real route. */
  async function listChats(email: string): Promise<ChatJson[]> {
    const response = await authenticatedRequest("/api/chats", {}, email);
    if (response.status !== 200) {
      throw new Error(`Fixture failed to list chats: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { chats: ChatJson[] };
    return body.chats;
  }

  it("lists only the signed-in identity's own chats, most recently updated first", async () => {
    const owner = uniqueEmail("owner");
    const otherOwner = uniqueEmail("other-owner");
    const chatA = await createChat(owner);
    const chatB = await createChat(owner);
    await createChat(otherOwner);

    // Bump A's own updated_at above B's by messaging it after both were created.
    await withFakeAi(
      createFakeAiWithTitle(['{"response":"hi"}', "[DONE]"], "Hi"),
      async () => {
        const socket = await openChatSocket(chatA, openSockets, owner);
        await sendTurn(socket, "hi");
      },
    );

    const chats = await listChats(owner);

    expect(chats.map((chat) => chat.id)).toEqual([chatA, chatB]);
    expect(chats.every((chat) => chat.ownerEmail === owner)).toBe(true);
  });

  it("rejects an unauthenticated chat list request", async () => {
    const response = await unauthenticatedRequest("/api/chats");

    expect(response.status).toBe(401);
  });

  it("generates a title from the first completed turn and never overwrites it on a later turn", async () => {
    const owner = uniqueEmail("titling");
    const chatId = await createChat(owner);

    await withFakeAi(
      createFakeAiWithTitle(
        ['{"response":"Hello"}', "[DONE]"],
        "Trip Planning",
      ),
      async () => {
        const socket = await openChatSocket(chatId, openSockets, owner);
        await sendTurn(socket, "Help me plan a trip to Japan");
      },
    );

    const [afterFirstTurn] = await listChats(owner);
    expect(afterFirstTurn?.title).toBe("Trip Planning");

    await withFakeAi(
      createFakeAiWithTitle(
        ['{"response":"Sure"}', "[DONE]"],
        "A Different Title",
      ),
      async () => {
        const socket = await openChatSocket(chatId, openSockets, owner);
        await sendTurn(socket, "What about a second stop?");
      },
    );

    const [afterSecondTurn] = await listChats(owner);
    expect(afterSecondTurn?.title).toBe("Trip Planning");
  }, 15_000);

  it("broadcasts chat_metadata_updated only once the generated title has actually landed in D1", async () => {
    // Regression test for a real reported bug: the sidebar kept showing "New chat" until an
    // unrelated page reload. Root cause (confirmed live with a diagnostic measuring both
    // events' timestamps): the AI SDK marks a turn "done" client-side as soon as it sees the
    // `{"type":"finish"}` UI part, which arrives well *before* `afterTurnCompleted()`'s own D1
    // writes land -- so a client that reloaded the chat directory on the turn's own streaming
    // status raced this method and reliably lost. `chat_metadata_updated` is the fix: it is
    // broadcast only from inside `afterTurnCompleted()`, after its writes are already done.
    const owner = uniqueEmail("broadcast-timing");
    const chatId = await createChat(owner);
    const socket = await openChatSocket(chatId, openSockets, owner);

    // Register the listener before triggering the turn (testing-durable-objects skill, rule 5).
    const metadataUpdated = new Promise<void>((resolve) => {
      socket.addEventListener("message", function handler(event) {
        const parsed = JSON.parse(String(event.data)) as { type: string };
        if (parsed.type === "chat_metadata_updated") {
          socket.removeEventListener("message", handler);
          resolve();
        }
      });
    });

    await withFakeAi(
      createFakeAiWithTitle(
        ['{"response":"Hello"}', "[DONE]"],
        "Broadcast Title",
      ),
      () => sendTurn(socket, "hi"),
    );
    await metadataUpdated;

    const [afterBroadcast] = await listChats(owner);
    expect(afterBroadcast?.title).toBe("Broadcast Title");
  }, 15_000);

  it("bumps updated_at on every completed turn even once a title already exists", async () => {
    const owner = uniqueEmail("recency");
    const chatId = await createChat(owner);
    const [beforeAnyTurn] = await listChats(owner);

    await withFakeAi(
      createFakeAiWithTitle(['{"response":"hi"}', "[DONE]"], "Greeting"),
      async () => {
        const socket = await openChatSocket(chatId, openSockets, owner);
        await sendTurn(socket, "hi");
      },
    );

    const [afterTurn] = await listChats(owner);
    expect(afterTurn?.updatedAt).not.toBe(beforeAnyTurn?.updatedAt);
    expect(new Date(afterTurn?.updatedAt ?? 0).getTime()).toBeGreaterThan(
      new Date(beforeAnyTurn?.createdAt ?? 0).getTime() - 1,
    );
  }, 15_000);

  it("leaves the title null when the model's title-generation response sanitizes to nothing usable", async () => {
    const owner = uniqueEmail("blank-title");
    const chatId = await createChat(owner);

    await withFakeAi(
      createFakeAiWithTitle(['{"response":"hi"}', "[DONE]"], "   "),
      async () => {
        const socket = await openChatSocket(chatId, openSockets, owner);
        await sendTurn(socket, "hi");
      },
    );

    const [afterTurn] = await listChats(owner);
    expect(afterTurn?.title).toBeNull();
  }, 15_000);

  it("still completes the turn for the client even when D1 is unavailable for the recency-touch and title-generation writes", async () => {
    const owner = uniqueEmail("d1-outage");
    const chatId = await createChat(owner);

    const rawBody = await withThrowingDb(() =>
      withFakeAi(
        createFakeAiWithTitle(
          ['{"response":"Hello despite the outage"}', "[DONE]"],
          "Outage",
        ),
        async () => {
          const socket = await openChatSocket(chatId, openSockets, owner);
          return sendTurn(socket, "hi");
        },
      ),
    );

    expect(rawBody).toContain('"delta":"Hello despite the outage"');
  }, 15_000);

  it("deletes a chat: removes it from the directory and tears down its Durable Object state", async () => {
    const owner = uniqueEmail("delete");
    const chatId = await createChat(owner);

    const deleteResponse = await authenticatedRequest(
      `/api/chats/${chatId}`,
      { method: "DELETE" },
      owner,
    );
    expect(deleteResponse.status).toBe(204);

    expect(await listChats(owner)).toEqual([]);

    const historyResponse = await authenticatedRequest(
      `/api/chats/${chatId}/get-messages`,
      {},
      owner,
    );
    expect(historyResponse.status).toBe(404);
  });

  it("still removes the D1 row and returns 204 when the Durable Object's own destroy() RPC call rejects", async () => {
    // Regression test for a real reported bug: deleting a chat produced "An unexpected error
    // occurred" and the chat was not actually removed -- confirmed live to be caused by
    // `stub.destroy()`'s RPC call itself rejecting (the Agents SDK's base `Agent.destroy()`
    // calls `ctx.abort()` from a deferred `setTimeout`, and that guarantee of a clean RPC
    // response is not airtight). Simulates that exact failure by patching `ChatAgent.prototype
    // .destroy` for the duration of this test, independent of whatever actually triggers it in
    // production.
    const owner = uniqueEmail("destroy-rejects");
    const chatId = await createChat(owner);
    const originalDestroy = ChatAgent.prototype.destroy;
    ChatAgent.prototype.destroy = async function patchedDestroy() {
      throw new Error("simulated destroy() RPC failure");
    };

    try {
      const deleteResponse = await authenticatedRequest(
        `/api/chats/${chatId}`,
        { method: "DELETE" },
        owner,
      );

      expect(deleteResponse.status).toBe(204);
      expect(await listChats(owner)).toEqual([]);
    } finally {
      ChatAgent.prototype.destroy = originalDestroy;
    }
  });

  it("rejects deleting a chat owned by a different identity with 404, not 403", async () => {
    const owner = uniqueEmail("victim");
    const attacker = uniqueEmail("attacker");
    const chatId = await createChat(owner);

    const response = await authenticatedRequest(
      `/api/chats/${chatId}`,
      { method: "DELETE" },
      attacker,
    );

    expect(response.status).toBe(404);
    // The chat must still exist for its real owner.
    expect(await listChats(owner)).toHaveLength(1);
  });

  it("rejects an unauthenticated delete request", async () => {
    const chatId = await createChat(uniqueEmail("unauth-delete"));

    const response = await unauthenticatedRequest(`/api/chats/${chatId}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(401);
  });

  it("returns 404 deleting a chat id that was never created", async () => {
    const response = await authenticatedRequest(
      `/api/chats/${crypto.randomUUID()}`,
      { method: "DELETE" },
      uniqueEmail("nonexistent-delete"),
    );

    expect(response.status).toBe(404);
  });

  it("notifies a still-connected client with a removal frame and closes it with the removal close code when its chat is deleted", async () => {
    const owner = uniqueEmail("removal-notice");
    const chatId = await createChat(owner);
    const socket = await openChatSocket(chatId, openSockets, owner);

    // Register listeners before triggering the deletion (testing-durable-objects skill, rule 5).
    const removalFrame = new Promise<{ type: string }>((resolve) => {
      socket.addEventListener("message", function handler(event) {
        const parsed = JSON.parse(String(event.data)) as { type: string };
        if (parsed.type === "chat_removed") {
          socket.removeEventListener("message", handler);
          resolve(parsed);
        }
      });
    });
    const closeEvent = new Promise<CloseEvent>((resolve) => {
      socket.addEventListener("close", (event) => resolve(event), {
        once: true,
      });
    });

    const deleteResponse = await authenticatedRequest(
      `/api/chats/${chatId}`,
      { method: "DELETE" },
      owner,
    );
    expect(deleteResponse.status).toBe(204);

    await expect(removalFrame).resolves.toEqual({ type: "chat_removed" });
    // Server-initiated close (the Durable Object's own `destroy()`), not a client-initiated
    // round trip -- safe to await per the testing-durable-objects skill's rule 3.
    const observedClose = await closeEvent;
    expect(observedClose.code).toBe(4_001);
  });
});
