import { describe, expect, it } from "vitest";
import { ChatFilesRepository } from "./repository";

/** A recorded D1 statement used to verify the repository's SQL and bound parameters. */
interface RecordedStatement {
  parameters: unknown[];
  sql: string;
}

/** Build a minimal D1 double whose `first()` returns `selectRow` for the repository's
 * `SELECT` -- mirrors `../chats/repository.test.ts`'s own fake D1 shape. */
function databaseFor(selectRow: Record<string, unknown> | null): {
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
          results: [] as T[],
          success: true as const,
        }),
        bind(...parameters: unknown[]) {
          record.parameters = parameters;
          return statement;
        },
        first: async <T>() => selectRow as T | null,
        raw: async <T>(): Promise<[string[], ...T[]]> => [[], [] as T],
        run: async <T>() => ({
          meta: {
            changed_db: false,
            changes: 1,
            duration: 0,
            last_row_id: 0,
            rows_read: 0,
            rows_written: 1,
            size_after: 0,
          },
          results: [] as T[],
          success: true as const,
        }),
      };
      return statement;
    },
  } satisfies Pick<D1Database, "prepare">;

  return { database, statements };
}

describe("ChatFilesRepository", () => {
  it("creates a new row carrying every field the caller supplied plus a fresh created_at", async () => {
    const { database, statements } = databaseFor(null);

    const file = await new ChatFilesRepository(database).create({
      id: "file-1",
      chatId: "chat-1",
      filename: "notes.md",
      r2Key: "chats/chat-1/files/file-1.md",
      sizeBytes: 42,
      correlationId: "correlation-1",
    });

    expect(file).toMatchObject({
      id: "file-1",
      chatId: "chat-1",
      filename: "notes.md",
      r2Key: "chats/chat-1/files/file-1.md",
      sizeBytes: 42,
      correlationId: "correlation-1",
    });
    expect(file.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(statements[0]).toMatchObject({
      parameters: [
        "file-1",
        "chat-1",
        "notes.md",
        "chats/chat-1/files/file-1.md",
        42,
        "correlation-1",
        file.createdAt,
      ],
      sql: expect.stringContaining("INSERT INTO chat_files"),
    });
  });

  it("returns the file when it belongs to the given chat", async () => {
    const { database, statements } = databaseFor({
      id: "file-1",
      chat_id: "chat-1",
      filename: "notes.md",
      r2_key: "chats/chat-1/files/file-1.md",
      size_bytes: 42,
      correlation_id: "correlation-1",
      created_at: "2026-08-03T00:00:00.000Z",
    });

    const file = await new ChatFilesRepository(database).findByChatAndId(
      "chat-1",
      "file-1",
    );

    expect(file).toEqual({
      id: "file-1",
      chatId: "chat-1",
      filename: "notes.md",
      r2Key: "chats/chat-1/files/file-1.md",
      sizeBytes: 42,
      correlationId: "correlation-1",
      createdAt: "2026-08-03T00:00:00.000Z",
    });
    expect(statements[0]).toMatchObject({
      parameters: ["file-1", "chat-1"],
      sql: expect.stringContaining("WHERE id = ? AND chat_id = ?"),
    });
    // Phase 12's per-file export (`../routes/chats.ts`'s `GET /:id/files/:fileId/export`) joins
    // this file back to its originating `chat_usage` row via `correlation_id` -- the SELECT
    // itself must actually project that column, not only `toChatFile()`'s mapping of it, or a
    // real D1 read (which -- unlike this fake -- only returns projected columns) would silently
    // leave `correlationId` `undefined` despite this test's own `selectRow` fixture above
    // carrying a `correlation_id` value.
    expect(statements[0]?.sql).toContain("correlation_id");
  });

  it("returns null for a file that does not exist or belongs to a different chat", async () => {
    const { database } = databaseFor(null);

    const file = await new ChatFilesRepository(database).findByChatAndId(
      "chat-1",
      "someone-elses-file",
    );

    expect(file).toBeNull();
  });
});
