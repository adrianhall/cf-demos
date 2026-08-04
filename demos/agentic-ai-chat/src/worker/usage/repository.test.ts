import { describe, expect, it } from "vitest";
import { UsageRepository } from "./repository";

/** A recorded D1 statement used to verify the repository's SQL and bound parameters. */
interface RecordedStatement {
  parameters: unknown[];
  sql: string;
}

/** Extra, per-test-case configuration for {@link databaseFor}'s fake `run()`/`all()`/`first()`
 * results (mirrors `../chats/repository.test.ts`'s fake D1 shape). */
interface DatabaseForOptions {
  /** Row `first()` resolves with -- `aggregateForChat()`. Defaults to `null`. */
  firstRow?: Record<string, unknown> | null;
  /** Rows `all()` resolves with -- `aggregateForOwner()`. Defaults to no rows. */
  selectRows?: Record<string, unknown>[];
  /** `meta.changes` `run()` resolves with. Defaults to `1`. */
  changes?: number;
  /** Rows a `run()` with a `RETURNING` clause resolves with -- `incrementReconcileAttempts()`.
   * Defaults to no rows. */
  returningRows?: Record<string, unknown>[];
}

function databaseFor(options: DatabaseForOptions = {}): {
  database: Pick<D1Database, "prepare">;
  statements: RecordedStatement[];
} {
  const statements: RecordedStatement[] = [];

  const database = {
    prepare(sql: string) {
      const record: RecordedStatement = { parameters: [], sql };
      statements.push(record);
      const statement = {
        all: async <T>() => ({
          meta: {
            changed_db: false,
            changes: 0,
            duration: 0,
            last_row_id: 0,
            rows_read: 0,
            rows_written: 0,
            size_after: 0,
          },
          results: (options.selectRows ?? []) as T[],
          success: true as const,
        }),
        bind(...parameters: unknown[]) {
          record.parameters = parameters;
          return statement;
        },
        first: async <T>() => (options.firstRow ?? null) as T | null,
        raw: async <T>(): Promise<[string[], ...T[]]> => [[], [] as T],
        run: async <T>() => ({
          meta: {
            changed_db: false,
            changes: options.changes ?? 1,
            duration: 0,
            last_row_id: 0,
            rows_read: 0,
            rows_written: 1,
            size_after: 0,
          },
          results: (options.returningRows ?? []) as T[],
          success: true as const,
        }),
      };
      return statement;
    },
  } satisfies Pick<D1Database, "prepare">;

  return { database, statements };
}

describe("UsageRepository", () => {
  describe("insertEstimated", () => {
    it("writes a new row with cost_source estimated, no gateway_log_id, and zero reconcile attempts", async () => {
      const { database, statements } = databaseFor();

      const row = await new UsageRepository(database).insertEstimated({
        chatId: "chat-1",
        model: "@cf/google/gemma-4-26b-a4b-it",
        promptTokens: 10,
        completionTokens: 20,
        costUsd: 0.000_006,
        correlationId: "corr-1",
      });

      expect(row).toMatchObject({
        chatId: "chat-1",
        model: "@cf/google/gemma-4-26b-a4b-it",
        promptTokens: 10,
        completionTokens: 20,
        costUsd: 0.000_006,
        costSource: "estimated",
        correlationId: "corr-1",
        gatewayLogId: null,
        reconcileAttempts: 0,
      });
      expect(row.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
      );
      expect(statements[0]).toMatchObject({
        parameters: [
          row.id,
          "chat-1",
          "@cf/google/gemma-4-26b-a4b-it",
          10,
          20,
          0.000_006,
          "corr-1",
          row.createdAt,
          row.updatedAt,
        ],
        sql: expect.stringContaining("INSERT INTO chat_usage"),
      });
    });
  });

  describe("reconcileWithGatewayLog", () => {
    it("upgrades the row to cost_source gateway with AI Gateway's own figures", async () => {
      const { database, statements } = databaseFor({ changes: 1 });

      const updated = await new UsageRepository(
        database,
      ).reconcileWithGatewayLog("corr-1", {
        gatewayLogId: "log-1",
        model: "@cf/google/gemma-4-26b-a4b-it",
        tokensIn: 12,
        tokensOut: 24,
        costUsd: 0.000_008,
      });

      expect(updated).toBe(true);
      expect(statements[0]).toMatchObject({
        parameters: [
          "@cf/google/gemma-4-26b-a4b-it",
          12,
          24,
          0.000_008,
          "log-1",
          expect.any(String),
          "corr-1",
        ],
        sql: expect.stringContaining("cost_source = 'gateway'"),
      });
    });

    it("returns false when the row no longer exists (Section 11's target-disappeared tolerance)", async () => {
      const { database } = databaseFor({ changes: 0 });

      const updated = await new UsageRepository(
        database,
      ).reconcileWithGatewayLog("corr-missing", {
        gatewayLogId: "log-1",
        model: "@cf/google/gemma-4-26b-a4b-it",
        tokensIn: 1,
        tokensOut: 1,
        costUsd: 0,
      });

      expect(updated).toBe(false);
    });

    it("reconciles a failed-but-logged turn the same way, with cost 0", async () => {
      const { database, statements } = databaseFor({ changes: 1 });

      const updated = await new UsageRepository(
        database,
      ).reconcileWithGatewayLog("corr-failed", {
        gatewayLogId: "log-failed",
        model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      });

      expect(updated).toBe(true);
      expect(statements[0]?.parameters).toContain(0);
    });
  });

  describe("incrementReconcileAttempts", () => {
    it("increments and returns the row's new attempt count via RETURNING", async () => {
      const { database, statements } = databaseFor({
        returningRows: [{ reconcile_attempts: 1 }],
      });

      const attempts = await new UsageRepository(
        database,
      ).incrementReconcileAttempts("corr-1");

      expect(attempts).toBe(1);
      expect(statements[0]).toMatchObject({
        parameters: [expect.any(String), "corr-1"],
        sql: expect.stringContaining("RETURNING reconcile_attempts"),
      });
    });

    it("returns null when the row no longer exists (Section 11's target-disappeared tolerance)", async () => {
      const { database } = databaseFor({ returningRows: [] });

      const attempts = await new UsageRepository(
        database,
      ).incrementReconcileAttempts("corr-missing");

      expect(attempts).toBeNull();
    });
  });

  describe("aggregateForChat", () => {
    it("maps a populated aggregate row into a ChatUsageSummary", async () => {
      const { database, statements } = databaseFor({
        firstRow: {
          total_cost_usd: 0.5,
          total_prompt_tokens: 100,
          total_completion_tokens: 200,
          turn_count: 3,
          confirmed_turn_count: 2,
          last_updated_at: "2026-08-03T00:00:00.000Z",
        },
      });

      const summary = await new UsageRepository(database).aggregateForChat(
        "chat-1",
      );

      expect(summary).toEqual({
        totalCostUsd: 0.5,
        totalPromptTokens: 100,
        totalCompletionTokens: 200,
        turnCount: 3,
        confirmedTurnCount: 2,
        lastUpdatedAt: "2026-08-03T00:00:00.000Z",
      });
      expect(statements[0]).toMatchObject({
        parameters: ["chat-1"],
        sql: expect.stringContaining("WHERE chat_id = ?"),
      });
    });

    it("returns a zeroed summary for a chat with no chat_usage rows yet", async () => {
      const { database } = databaseFor({
        firstRow: {
          total_cost_usd: 0,
          total_prompt_tokens: 0,
          total_completion_tokens: 0,
          turn_count: 0,
          confirmed_turn_count: 0,
          last_updated_at: null,
        },
      });

      const summary = await new UsageRepository(database).aggregateForChat(
        "chat-1",
      );

      expect(summary).toEqual({
        totalCostUsd: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        turnCount: 0,
        confirmedTurnCount: 0,
        lastUpdatedAt: null,
      });
    });

    it("returns a zeroed summary defensively if first() itself ever returns null (not expected from a real aggregate query)", async () => {
      const { database } = databaseFor({ firstRow: null });

      const summary = await new UsageRepository(database).aggregateForChat(
        "chat-1",
      );

      expect(summary).toEqual({
        totalCostUsd: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        turnCount: 0,
        confirmedTurnCount: 0,
        lastUpdatedAt: null,
      });
    });
  });

  describe("aggregateForOwner", () => {
    it("returns a map keyed by chat id, scoped to the owner in a single query", async () => {
      const { database, statements } = databaseFor({
        selectRows: [
          {
            chat_id: "chat-1",
            total_cost_usd: 0.1,
            total_prompt_tokens: 10,
            total_completion_tokens: 20,
            turn_count: 1,
            confirmed_turn_count: 0,
            last_updated_at: "2026-08-03T00:00:00.000Z",
          },
          {
            chat_id: "chat-2",
            total_cost_usd: 0.2,
            total_prompt_tokens: 30,
            total_completion_tokens: 40,
            turn_count: 2,
            confirmed_turn_count: 1,
            last_updated_at: "2026-08-03T01:00:00.000Z",
          },
        ],
      });

      const summaries = await new UsageRepository(database).aggregateForOwner(
        "alice@example.com",
      );

      expect(summaries.get("chat-1")).toEqual({
        totalCostUsd: 0.1,
        totalPromptTokens: 10,
        totalCompletionTokens: 20,
        turnCount: 1,
        confirmedTurnCount: 0,
        lastUpdatedAt: "2026-08-03T00:00:00.000Z",
      });
      expect(summaries.get("chat-2")).toMatchObject({ totalCostUsd: 0.2 });
      expect(summaries.has("chat-3")).toBe(false);
      expect(statements[0]).toMatchObject({
        parameters: ["alice@example.com"],
        sql: expect.stringContaining("WHERE chats.owner_email = ?"),
      });
    });

    it("returns an empty map for an owner with no chat_usage rows", async () => {
      const { database } = databaseFor({ selectRows: [] });

      const summaries = await new UsageRepository(database).aggregateForOwner(
        "alice@example.com",
      );

      expect(summaries.size).toBe(0);
    });
  });
});
