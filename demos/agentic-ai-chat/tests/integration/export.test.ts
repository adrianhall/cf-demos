import { applyD1Migrations, evictAllDurableObjects } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ALICE,
  activateSkillToolCallPayloads,
  authenticatedRequest,
  BOB,
  createChat,
  createFakeAi,
  createFakeAiWithTitle,
  createSequencedFakeAi,
  openChatSocket,
  readChatFileRows,
  readChatUsageRows,
  sendTurn,
  unauthenticatedRequest,
  withFakeAi,
  writeMarkdownToolCallPayloads,
} from "./fixtures";

/** Test-only Worker bindings injected by the integration Vitest project. */
interface TestEnv extends Env {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/** Build a unique, per-test skill name so this file's shared D1/R2 state (this pool evicts
 * storage per test *file*, not per test -- mirrors `skills.test.ts`'s own rationale) can never
 * collide between test cases. */
function unique(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** Create a personal skill through the real `POST /api/skills` route (duplicated from
 * `skills.test.ts`'s own identically-named helper -- this repo's existing convention of
 * duplicating a small fixture helper across integration test files rather than centralizing
 * every one of them in `./fixtures.ts`). */
async function createPersonalSkill(
  email: string,
  name: string,
  content: string,
): Promise<void> {
  const response = await authenticatedRequest(
    "/api/skills",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        description: "A test skill.",
        source: { type: "upload", content },
      }),
    },
    email,
  );
  if (response.status !== 201) {
    throw new Error(
      `Fixture failed to create a personal skill: HTTP ${response.status}`,
    );
  }
}

/** Sum a set of raw `chat_usage` rows' `cost_usd` figures, formatted exactly the way
 * `../../src/worker/export/chat-markdown.ts`'s `formatCostSummary()` renders a chat's total --
 * used to assert the export document's own total against this test's own independently summed
 * figure, rather than hard-coding an expected dollar amount. */
function totalCostUsd(rows: readonly { cost_usd: number }[]): string {
  const total = rows.reduce((sum, row) => sum + row.cost_usd, 0);
  return total.toFixed(6);
}

/**
 * Exercises Phase 12's chat/file export (US-11, docs/06-AGENTIC-CHAT.md): `GET
 * /api/chats/:id/export` builds a Markdown document covering every turn (including tool
 * calls/results and skill activations) plus the chat's own cost/token summary, and `GET
 * /api/chats/:id/files/:fileId/export` wraps one generated file's content with the cost/token
 * context of the turn that produced it -- both server-side, both ownership-checked identically
 * to the routes Phase 2/9 already ship.
 */
describe("Chat and file export (US-11)", () => {
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

  describe("GET /api/chats/:id/export", () => {
    it("rejects an unauthenticated request", async () => {
      const response = await unauthenticatedRequest(
        `/api/chats/${crypto.randomUUID()}/export`,
      );

      expect(response.status).toBe(401);
    });

    it("returns 404 for a chat id that was never created", async () => {
      const response = await authenticatedRequest(
        `/api/chats/${crypto.randomUUID()}/export`,
        {},
        ALICE,
      );

      expect(response.status).toBe(404);
    });

    it("returns 404 when a different identity requests someone else's chat export", async () => {
      const chatId = await createChat(ALICE);

      const response = await authenticatedRequest(
        `/api/chats/${chatId}/export`,
        {},
        BOB,
      );

      expect(response.status).toBe(404);
    });

    it("produces a Markdown document with every turn, a tool call, a skill activation, and the correct cost total", async () => {
      const chatId = await createChat(ALICE);
      const skillName = unique("cloudflare-spike-fact");

      // Turn 1: a plain, tool-free exchange -- also this chat's first completed turn, so it
      // generates the chat's title (`createFakeAi()`'s companion, `afterTurnCompleted()`'s
      // own non-streaming title call, always resolves to a fixed placeholder in every fixture
      // this file uses, per `createFakeAi()`'s own JSDoc -- title text itself is not this
      // test's concern).
      await withFakeAi(
        createFakeAi(['{"response":"Hi there! How can I help?"}', "[DONE]"]),
        async () => {
          const socket = await openChatSocket(chatId, openSockets, ALICE);
          await sendTurn(socket, "Hello agent");
        },
      );

      // Turn 2: a `writeMarkdown` tool call, producing an attached file.
      await withFakeAi(
        createSequencedFakeAi([
          writeMarkdownToolCallPayloads(
            "spike notes",
            "# Notes\n\nRemember sunscreen.",
          ),
          ['{"response":"Saved your notes."}', "[DONE]"],
        ]),
        async () => {
          const socket = await openChatSocket(chatId, openSockets, ALICE);
          await sendTurn(socket, "Save my notes as a file.");
        },
      );

      // Seed a personal skill only after the two turns above, so its own creation cannot
      // accidentally satisfy an unrelated tool-call assertion.
      await createPersonalSkill(
        ALICE,
        skillName,
        "The spike passphrase is TURQUOISE-NARWHAL-77.",
      );

      // Turn 3: an `activate_skill` tool call.
      await withFakeAi(
        createSequencedFakeAi([
          activateSkillToolCallPayloads(skillName),
          ['{"response":"The passphrase is TURQUOISE-NARWHAL-77."}', "[DONE]"],
        ]),
        async () => {
          const socket = await openChatSocket(chatId, openSockets, ALICE);
          await sendTurn(socket, "What is the spike passphrase?");
        },
      );

      const usageRows = await readChatUsageRows(chatId);
      expect(usageRows).toHaveLength(3);

      const response = await authenticatedRequest(
        `/api/chats/${chatId}/export`,
        {},
        ALICE,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/markdown");
      expect(response.headers.get("Content-Disposition")).toContain(
        "attachment",
      );

      const markdown = await response.text();
      expect(markdown).toContain(`Chat ID: \`${chatId}\``);
      // Every completed turn's own text.
      expect(markdown).toContain("Hello agent");
      expect(markdown).toContain("Hi there! How can I help?");
      expect(markdown).toContain("Save my notes as a file.");
      expect(markdown).toContain("Saved your notes.");
      // The `writeMarkdown` tool call and its result.
      expect(markdown).toContain("**Tool call: writeMarkdown**");
      expect(markdown).toContain("spike-notes.md");
      // The skill activation, labeled distinctly from an ordinary tool call.
      expect(markdown).toContain(`**Skill activated:** ${skillName}`);
      expect(markdown).not.toContain("**Tool call: activate_skill**");
      // The chat's own cost/token summary, matching this test's independently summed total.
      expect(markdown).toContain(`Total cost: $${totalCostUsd(usageRows)}`);
      // Every turn's `chat_usage` row is still freshly written by `onFinish` and has not yet
      // been reconciled (that happens on `ChatAgent`'s own scheduled delay, never within this
      // test) -- `cost_source` is `"estimated"` for all three rows.
      expect(markdown).toContain("0 of 3 turns confirmed by AI Gateway");
    }, 20_000);

    it("falls back to a generic filename when the chat's title has no character safe for one", async () => {
      const chatId = await createChat(ALICE);
      await withFakeAi(
        createFakeAiWithTitle(['{"response":"Hi!"}', "[DONE]"], "🎉🎉🎉"),
        async () => {
          const socket = await openChatSocket(chatId, openSockets, ALICE);
          await sendTurn(socket, "Hello");
        },
      );

      const response = await authenticatedRequest(
        `/api/chats/${chatId}/export`,
        {},
        ALICE,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Disposition")).toContain(
        "chat-export.md",
      );
    }, 15_000);

    it("reports 'No turns yet' for a brand-new chat with no messages", async () => {
      const chatId = await createChat(ALICE);

      const response = await authenticatedRequest(
        `/api/chats/${chatId}/export`,
        {},
        ALICE,
      );

      expect(response.status).toBe(200);
      const markdown = await response.text();
      expect(markdown).toContain("_No turns yet._");
      expect(markdown).toContain("_No completed turns yet._");
    });
  });

  describe("GET /api/chats/:id/files/:fileId/export", () => {
    /** Create a chat, ALICE, with one completed `writeMarkdown` turn, and return its chat id and
     * resulting file/usage rows. */
    async function chatWithOneFile(): Promise<{
      chatId: string;
      fileId: string;
    }> {
      const chatId = await createChat(ALICE);
      await withFakeAi(
        createSequencedFakeAi([
          writeMarkdownToolCallPayloads(
            "trip itinerary",
            "# Trip\n\nPack sunscreen.",
          ),
          ['{"response":"Saved your trip itinerary."}', "[DONE]"],
        ]),
        async () => {
          const socket = await openChatSocket(chatId, openSockets, ALICE);
          await sendTurn(socket, "Please save my trip itinerary as a file.");
        },
      );
      const [file] = await readChatFileRows(chatId);
      if (!file) {
        throw new Error("Fixture failed to produce a chat_files row.");
      }
      return { chatId, fileId: file.id };
    }

    it("rejects an unauthenticated request", async () => {
      const response = await unauthenticatedRequest(
        `/api/chats/${crypto.randomUUID()}/files/${crypto.randomUUID()}/export`,
      );

      expect(response.status).toBe(401);
    });

    it("wraps the file's own content with the cost context of the turn that produced it", async () => {
      const { chatId, fileId } = await chatWithOneFile();
      const [usageRow] = await readChatUsageRows(chatId);
      if (!usageRow) {
        throw new Error("Fixture failed to produce a chat_usage row.");
      }

      const response = await authenticatedRequest(
        `/api/chats/${chatId}/files/${fileId}/export`,
        {},
        ALICE,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/markdown");
      expect(response.headers.get("Content-Disposition")).toContain(
        "trip-itinerary-export.md",
      );

      const markdown = await response.text();
      expect(markdown).toContain("# trip-itinerary.md");
      // The producing turn's own cost context, joined via `correlation_id` (Section 6.4/15).
      expect(markdown).toContain(`Model: ${usageRow.model}`);
      expect(markdown).toContain(
        `Cost: $${usageRow.cost_usd.toFixed(6)} (Estimated)`,
      );
      expect(markdown).toContain(`Prompt tokens: ${usageRow.prompt_tokens}`);
      expect(markdown).toContain(
        `Completion tokens: ${usageRow.completion_tokens}`,
      );
      // The file's own content, embedded verbatim.
      expect(markdown).toContain("# Trip\n\nPack sunscreen.");
    }, 15_000);

    it("returns 404 when a different identity requests someone else's file export", async () => {
      const { chatId, fileId } = await chatWithOneFile();

      const response = await authenticatedRequest(
        `/api/chats/${chatId}/files/${fileId}/export`,
        {},
        BOB,
      );

      expect(response.status).toBe(404);
    }, 15_000);

    it("returns 404 for a file id that was never created", async () => {
      const chatId = await createChat(ALICE);

      const response = await authenticatedRequest(
        `/api/chats/${chatId}/files/${crypto.randomUUID()}/export`,
        {},
        ALICE,
      );

      expect(response.status).toBe(404);
    });

    it("returns 404 when the chat_files row survives but its R2 object no longer does (Section 11)", async () => {
      const { chatId, fileId } = await chatWithOneFile();
      const [file] = await readChatFileRows(chatId);
      if (!file) {
        throw new Error("Fixture failed to produce a chat_files row.");
      }
      await env.FILES.delete(file.r2_key);

      const response = await authenticatedRequest(
        `/api/chats/${chatId}/files/${fileId}/export`,
        {},
        ALICE,
      );

      expect(response.status).toBe(404);
    }, 15_000);

    it("returns 404 for a chat id that was never created", async () => {
      const response = await authenticatedRequest(
        `/api/chats/${crypto.randomUUID()}/files/${crypto.randomUUID()}/export`,
        {},
        ALICE,
      );

      expect(response.status).toBe(404);
    });
  });
});
