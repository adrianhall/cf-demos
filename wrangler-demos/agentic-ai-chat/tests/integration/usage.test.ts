import {
  applyD1Migrations,
  evictAllDurableObjects,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ReconcileUsagePayload } from "../../src/worker/agent/chat-agent";
import {
  ALICE,
  authenticatedRequest,
  createChat,
  createFakeAi,
  nextMessageOfType,
  openChatSocket,
  readChatUsageRows,
  sendTurn,
  withFakeAi,
  withFakeFetch,
  withThrowingChatUsageDb,
} from "./fixtures";

/** Test-only Worker bindings injected by the integration Vitest project. */
interface TestEnv extends Env {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/** Build a fake `fetch` resolving to the AI Gateway logs-list endpoint's own response shape
 * (docs/06-AGENTIC-CHAT.md Section 6.6). */
function fakeLogsListFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    Response.json(body, { status })) as unknown as typeof fetch;
}

/** A single matching log row's REST shape, for a successful reconciliation. */
function matchingLogRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    success: true,
    result: [
      {
        id: "gateway-log-1",
        model: "@cf/google/gemma-4-26b-a4b-it",
        tokens_in: 11,
        tokens_out: 22,
        cost: 0.000_099,
        ...overrides,
      },
    ],
  };
}

/** The "not yet available" logs-list response: zero matching rows, still a successful call. */
const NO_MATCH_RESPONSE = { success: true, result: [] };

/**
 * Exercises Phase 6's cost ledger (US-5, docs/06-AGENTIC-CHAT.md) end to end: the immediate
 * local estimate written from a real turn, its live push to a connected client via `setState()`,
 * and every branch of `ChatAgent.reconcileUsage()` (success, not-yet-available, exhausted
 * retries, and the row-disappeared tolerance) -- exercised by calling the real method directly
 * via `runInDurableObject()` against the same instance a real turn already woke, rather than
 * waiting on its own real 10s/+15s schedule delays. `../../src/worker/ai-gateway/logs.ts`'s one
 * REST call is the only thing faked (`withFakeFetch`, mirroring `withFakeAi`/`withThrowingDb`'s
 * own `env`-substitution pattern) -- everything else runs for real against this pool's own
 * `workerd`/D1/Durable Object, following the `testing-durable-objects` skill's lifecycle rules.
 */
describe("Cost ledger (US-5)", () => {
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

  /** Create a chat, send one real turn against a fake model with known usage numbers, and
   * return the chat id and its resulting sole `chat_usage` row. */
  async function chatWithOneEstimatedTurn(): Promise<{
    chatId: string;
    socket: WebSocket;
    row: NonNullable<Awaited<ReturnType<typeof readChatUsageRows>>[number]>;
  }> {
    const chatId = await createChat(ALICE);
    const socket = await openChatSocket(chatId, openSockets, ALICE);
    // `partyserver`'s own connect handler pushes one `cf_agent_state` frame immediately on
    // connect, hydrating the client with the *current* (still-zeroed, pre-first-turn) state --
    // consume it before registering the listener for the frame this turn itself produces, or
    // this promise resolves with the wrong frame.
    await nextMessageOfType(socket, "cf_agent_state");
    const statePushed = nextMessageOfType(socket, "cf_agent_state");

    await withFakeAi(
      createFakeAi([
        '{"response":"Hello"}',
        '{"response":"","usage":{"prompt_tokens":11,"completion_tokens":22,"total_tokens":33}}',
        "[DONE]",
      ]),
      () => sendTurn(socket, "hi"),
    );
    await statePushed;

    const rows = await readChatUsageRows(chatId);
    const [row] = rows;
    if (!row) {
      throw new Error("Fixture failed to produce a chat_usage row.");
    }
    return { chatId, socket, row };
  }

  it("writes exactly one estimated chat_usage row and pushes the fresh total to a connected client", async () => {
    const { row } = await chatWithOneEstimatedTurn();

    expect(row.cost_source).toBe("estimated");
    expect(row.prompt_tokens).toBe(11);
    expect(row.completion_tokens).toBe(22);
    expect(row.cost_usd).toBeGreaterThan(0);
    expect(row.gateway_log_id).toBeNull();
    expect(row.reconcile_attempts).toBe(0);
    expect(row.correlation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
  }, 15_000);

  it("delivers the estimate via a cf_agent_state frame the connected client actually observes", async () => {
    const chatId = await createChat(ALICE);
    const socket = await openChatSocket(chatId, openSockets, ALICE);
    // Consume the connect-time hydration frame (see `chatWithOneEstimatedTurn()`'s own comment)
    // before registering the listener for the turn's own push (testing-durable-objects skill,
    // rule 5 -- registered before the action that triggers it).
    await nextMessageOfType(socket, "cf_agent_state");
    const statePushed = nextMessageOfType<{
      state: { usage: Record<string, unknown> };
    }>(socket, "cf_agent_state");

    await withFakeAi(
      createFakeAi([
        '{"response":"Hello"}',
        '{"response":"","usage":{"prompt_tokens":5,"completion_tokens":9,"total_tokens":14}}',
        "[DONE]",
      ]),
      () => sendTurn(socket, "hi"),
    );

    const frame = await statePushed;
    expect(frame.state.usage).toMatchObject({
      totalPromptTokens: 5,
      totalCompletionTokens: 9,
      turnCount: 1,
      confirmedTurnCount: 0,
    });
    expect(
      (frame.state.usage as { totalCostUsd: number }).totalCostUsd,
    ).toBeGreaterThan(0);
  }, 15_000);

  it("upgrades a turn to AI Gateway's own figures and broadcasts usage_reconciled", async () => {
    const { chatId, socket, row } = await chatWithOneEstimatedTurn();
    const payload: ReconcileUsagePayload = {
      chatUsageId: row.id,
      correlationId: row.correlation_id,
    };
    const reconciled = nextMessageOfType<{
      type: string;
      chatUsageId: string;
      costSource: string;
    }>(socket, "usage_reconciled");

    await withFakeFetch(fakeLogsListFetch(200, matchingLogRow()), () =>
      runInDurableObject(env.CHAT_AGENT.getByName(chatId), (instance) =>
        instance.reconcileUsage(payload),
      ),
    );

    await expect(reconciled).resolves.toEqual({
      type: "usage_reconciled",
      chatUsageId: row.id,
      costSource: "gateway",
    });
    const [updated] = await readChatUsageRows(chatId);
    expect(updated).toMatchObject({
      cost_source: "gateway",
      gateway_log_id: "gateway-log-1",
      prompt_tokens: 11,
      completion_tokens: 22,
      cost_usd: 0.000_099,
    });
  }, 15_000);

  it("increments reconcile_attempts and leaves the row estimated when no log has landed yet", async () => {
    const { chatId, row } = await chatWithOneEstimatedTurn();
    const payload: ReconcileUsagePayload = {
      chatUsageId: row.id,
      correlationId: row.correlation_id,
    };

    await withFakeFetch(fakeLogsListFetch(200, NO_MATCH_RESPONSE), () =>
      runInDurableObject(env.CHAT_AGENT.getByName(chatId), (instance) =>
        instance.reconcileUsage(payload),
      ),
    );

    const [updated] = await readChatUsageRows(chatId);
    expect(updated).toMatchObject({
      cost_source: "estimated",
      reconcile_attempts: 1,
    });
  }, 15_000);

  it("broadcasts usage_reconcile_exhausted and leaves the row estimated permanently once the bounded retry budget is spent", async () => {
    const { chatId, socket, row } = await chatWithOneEstimatedTurn();
    const payload: ReconcileUsagePayload = {
      chatUsageId: row.id,
      correlationId: row.correlation_id,
    };
    const exhausted = nextMessageOfType<{
      type: string;
      chatUsageId: string;
    }>(socket, "usage_reconcile_exhausted");

    // Three attempts total (the bounded budget, docs/06-AGENTIC-CHAT.md Section 6.6) -- called
    // directly and sequentially here rather than waiting on the real 10s/+15s/+15s schedule.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await withFakeFetch(fakeLogsListFetch(200, NO_MATCH_RESPONSE), () =>
        runInDurableObject(env.CHAT_AGENT.getByName(chatId), (instance) =>
          instance.reconcileUsage(payload),
        ),
      );
    }

    await expect(exhausted).resolves.toEqual({
      type: "usage_reconcile_exhausted",
      chatUsageId: row.id,
    });
    const [updated] = await readChatUsageRows(chatId);
    expect(updated).toMatchObject({
      cost_source: "estimated",
      reconcile_attempts: 3,
    });
  }, 20_000);

  it("treats a logs-list REST failure the same as not-yet-available, without throwing", async () => {
    const { chatId, row } = await chatWithOneEstimatedTurn();
    const payload: ReconcileUsagePayload = {
      chatUsageId: row.id,
      correlationId: row.correlation_id,
    };

    await expect(
      withFakeFetch(
        fakeLogsListFetch(401, { success: false, errors: [] }),
        () =>
          runInDurableObject(env.CHAT_AGENT.getByName(chatId), (instance) =>
            instance.reconcileUsage(payload),
          ),
      ),
    ).resolves.toBeUndefined();

    const [updated] = await readChatUsageRows(chatId);
    expect(updated).toMatchObject({
      cost_source: "estimated",
      reconcile_attempts: 1,
    });
  }, 15_000);

  it("tolerates a chat_usage row that no longer exists by the time reconciliation runs, without throwing (a matching log arrives)", async () => {
    const { chatId, row } = await chatWithOneEstimatedTurn();
    const payload: ReconcileUsagePayload = {
      chatUsageId: row.id,
      correlationId: row.correlation_id,
    };
    await env.DB.prepare("DELETE FROM chat_usage WHERE id = ?")
      .bind(row.id)
      .run();

    await expect(
      withFakeFetch(fakeLogsListFetch(200, matchingLogRow()), () =>
        runInDurableObject(env.CHAT_AGENT.getByName(chatId), (instance) =>
          instance.reconcileUsage(payload),
        ),
      ),
    ).resolves.toBeUndefined();

    // The row was never recreated -- reconciliation genuinely has nothing left to update.
    expect(await readChatUsageRows(chatId)).toEqual([]);
  }, 15_000);

  it("tolerates a chat_usage row that no longer exists by the time reconciliation runs, without throwing (no log found yet)", async () => {
    const { chatId, row } = await chatWithOneEstimatedTurn();
    const payload: ReconcileUsagePayload = {
      chatUsageId: row.id,
      correlationId: row.correlation_id,
    };
    await env.DB.prepare("DELETE FROM chat_usage WHERE id = ?")
      .bind(row.id)
      .run();

    // Exercises `incrementReconcileAttempts()` returning `null` (Section 11) -- distinct from
    // the sibling test above, which exercises `reconcileWithGatewayLog()` returning `false` for
    // the same underlying reason.
    await expect(
      withFakeFetch(fakeLogsListFetch(200, NO_MATCH_RESPONSE), () =>
        runInDurableObject(env.CHAT_AGENT.getByName(chatId), (instance) =>
          instance.reconcileUsage(payload),
        ),
      ),
    ).resolves.toBeUndefined();

    expect(await readChatUsageRows(chatId)).toEqual([]);
  }, 15_000);

  it("still completes the turn for the client, and never writes a usage row, when D1 is unavailable for the estimate write", async () => {
    const chatId = await createChat(ALICE);
    const socket = await openChatSocket(chatId, openSockets, ALICE);

    const rawBody = await withThrowingChatUsageDb(() =>
      withFakeAi(
        createFakeAi([
          '{"response":"Hello despite the outage"}',
          '{"response":"","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
          "[DONE]",
        ]),
        () => sendTurn(socket, "hi"),
      ),
    );

    expect(rawBody).toContain('"delta":"Hello despite the outage"');
    expect(await readChatUsageRows(chatId)).toEqual([]);
  }, 15_000);

  it("defaults prompt/completion tokens to 0 when the model reports no usage information at all", async () => {
    const chatId = await createChat(ALICE);
    const socket = await openChatSocket(chatId, openSockets, ALICE);

    // No `usage` chunk at all -- `workers-ai-provider` then reports `inputTokens`/`outputTokens`
    // as `undefined`, exercising `recordTurnUsage()`'s own `?? 0` fallback.
    await withFakeAi(createFakeAi(['{"response":"Hello"}', "[DONE]"]), () =>
      sendTurn(socket, "hi"),
    );

    const [row] = await readChatUsageRows(chatId);
    expect(row).toMatchObject({
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_source: "estimated",
    });
  }, 15_000);

  it("reflects every completed turn's usage in GET /api/chats, with the estimated/gateway mix", async () => {
    const { chatId } = await chatWithOneEstimatedTurn();

    const response = await authenticatedRequest("/api/chats", {}, ALICE);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      chats: {
        id: string;
        usage: {
          totalCostUsd: number;
          turnCount: number;
          confirmedTurnCount: number;
        };
      }[];
    };
    const chat = body.chats.find((entry) => entry.id === chatId);
    expect(chat?.usage).toMatchObject({ turnCount: 1, confirmedTurnCount: 0 });
    expect(chat?.usage.totalCostUsd).toBeGreaterThan(0);
  }, 15_000);

  it("reports a zeroed usage summary for a brand-new chat with no turns yet", async () => {
    // A fresh identity, per this file's own `chatWithOneEstimatedTurn()`/ALICE-sharing
    // convention (mirrors `chat-management.test.ts`'s `uniqueEmail()` rationale) -- storage
    // isolation in this pool is per test file, not per test, so a chat-less identity avoids any
    // ambiguity with another test's own chats in the same `GET /api/chats` response.
    const owner = `usage-zeroed-${crypto.randomUUID()}@example.com`;
    const chatId = await createChat(owner);

    const response = await authenticatedRequest("/api/chats", {}, owner);
    const body = (await response.json()) as {
      chats: {
        id: string;
        usage: { totalCostUsd: number; turnCount: number };
      }[];
    };
    const chat = body.chats.find((entry) => entry.id === chatId);
    expect(chat?.usage).toEqual({
      totalCostUsd: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      turnCount: 0,
      confirmedTurnCount: 0,
      lastUpdatedAt: null,
    });
  });
});
