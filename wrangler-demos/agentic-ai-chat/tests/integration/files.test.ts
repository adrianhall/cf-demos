import { applyD1Migrations, evictAllDurableObjects } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  ALICE,
  authenticatedRequest,
  BOB,
  createChat,
  createSequencedFakeAi,
  openChatSocket,
  readChatFileRows,
  readChatUsageRows,
  sendTurn,
  withFakeAi,
  writeMarkdownToolCallPayloads,
} from "./fixtures";

/** Test-only Worker bindings injected by the integration Vitest project. */
interface TestEnv extends Env {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/**
 * Exercises the `writeMarkdown` tool end to end (docs/06-AGENTIC-CHAT.md Phase 9, US-8): a fake
 * model scripted to call the tool, the resulting R2 object and `chat_files` row, and the
 * ownership-checked download route -- following the `testing-durable-objects` skill's lifecycle
 * rules for a WebSocket/Durable-Object suite, exactly like `chat.test.ts`.
 */
describe("writeMarkdown tool and file download (US-8)", () => {
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

  it("saves a file to R2, persists its metadata, and lets only the chat's owner download it", async () => {
    const chatId = await createChat(ALICE);
    const fakeAi = createSequencedFakeAi([
      writeMarkdownToolCallPayloads(
        "trip itinerary",
        "# Trip\n\nPack sunscreen.",
      ),
      ['{"response":"Saved your trip itinerary."}', "[DONE]"],
    ]);

    const rawBody = await withFakeAi(fakeAi, async () => {
      const socket = await openChatSocket(chatId, openSockets, ALICE);
      return sendTurn(socket, "Please save my trip itinerary as a file.");
    });

    // The tool call and its successful result both arrive over the wire, followed by the
    // model's own follow-up text (US-8's "corresponding attachment renders inline" via the
    // client's own tool-output-available handling, `useChatAgent.ts`).
    expect(rawBody).toContain('"type":"tool-input-available"');
    expect(rawBody).toContain('"toolName":"writeMarkdown"');
    expect(rawBody).toContain('"type":"tool-output-available"');
    expect(rawBody).toContain('"success":true');
    expect(rawBody).toContain('"filename":"trip-itinerary.md"');
    expect(rawBody).toContain("Saved your trip itinerary.");

    const rows = await readChatFileRows(chatId);
    expect(rows).toHaveLength(1);
    const file = rows[0];
    expect(file?.filename).toBe("trip-itinerary.md");
    expect(file?.size_bytes).toBeGreaterThan(0);
    expect(file?.r2_key).toContain(`chats/${chatId}/files/`);

    // The file's own `correlation_id` is the exact join key back to the `chat_usage` row this
    // same turn produced (docs/06-AGENTIC-CHAT.md Section 6.6/15) -- not an approximation
    // inferred from timestamps, resolving the doc's own open question for Phase 12's future
    // per-file cost export.
    const [usageRow] = await readChatUsageRows(chatId);
    expect(file?.correlation_id).toBe(usageRow?.correlation_id);

    const ownerDownload = await authenticatedRequest(
      `/api/chats/${chatId}/files/${file?.id}`,
      {},
      ALICE,
    );
    expect(ownerDownload.status).toBe(200);
    expect(await ownerDownload.text()).toBe("# Trip\n\nPack sunscreen.");
    expect(ownerDownload.headers.get("Content-Disposition")).toContain(
      "trip-itinerary.md",
    );

    const foreignDownload = await authenticatedRequest(
      `/api/chats/${chatId}/files/${file?.id}`,
      {},
      BOB,
    );
    expect(foreignDownload.status).toBe(404);
  }, 15_000);

  it("returns 404 for a file id that was never created, indistinguishable from a foreign one", async () => {
    const chatId = await createChat(ALICE);

    const response = await authenticatedRequest(
      `/api/chats/${chatId}/files/${crypto.randomUUID()}`,
      {},
      ALICE,
    );

    expect(response.status).toBe(404);
  });

  it("returns 404 for the owner's own file id requested under someone else's chat id", async () => {
    const ownedChatId = await createChat(ALICE);
    const foreignChatId = await createChat(BOB);
    const fakeAi = createSequencedFakeAi([
      writeMarkdownToolCallPayloads("notes", "hello"),
      ['{"response":"Done."}', "[DONE]"],
    ]);

    await withFakeAi(fakeAi, async () => {
      const socket = await openChatSocket(ownedChatId, openSockets, ALICE);
      await sendTurn(socket, "save this");
    });
    const [file] = await readChatFileRows(ownedChatId);

    const response = await authenticatedRequest(
      `/api/chats/${foreignChatId}/files/${file?.id}`,
      {},
      BOB,
    );

    expect(response.status).toBe(404);
  }, 15_000);

  it("returns 404 when the chat_files row survives but its R2 object no longer does (Section 11)", async () => {
    const chatId = await createChat(ALICE);
    const fakeAi = createSequencedFakeAi([
      writeMarkdownToolCallPayloads("notes", "hello"),
      ['{"response":"Done."}', "[DONE]"],
    ]);

    await withFakeAi(fakeAi, async () => {
      const socket = await openChatSocket(chatId, openSockets, ALICE);
      await sendTurn(socket, "save this");
    });
    const [file] = await readChatFileRows(chatId);
    await env.FILES.delete(file?.r2_key ?? "");

    const response = await authenticatedRequest(
      `/api/chats/${chatId}/files/${file?.id}`,
      {},
      ALICE,
    );

    expect(response.status).toBe(404);
  }, 15_000);

  it("rejects content that fails validation without writing to R2 or D1, and completes the turn normally", async () => {
    const chatId = await createChat(ALICE);
    const fakeAi = createSequencedFakeAi([
      writeMarkdownToolCallPayloads("notes", "   "),
      ['{"response":"I could not save an empty document."}', "[DONE]"],
    ]);

    const rawBody = await withFakeAi(fakeAi, async () => {
      const socket = await openChatSocket(chatId, openSockets, ALICE);
      return sendTurn(socket, "Save an empty note.");
    });

    expect(rawBody).toContain('"success":false');
    expect(rawBody).toContain("content must not be empty");
    expect(rawBody).toContain("I could not save an empty document.");

    const rows = await readChatFileRows(chatId);
    expect(rows).toHaveLength(0);
  }, 15_000);
});
