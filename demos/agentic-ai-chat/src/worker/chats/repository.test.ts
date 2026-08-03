import { describe, expect, it } from "vitest";
import { ChatRepository } from "./repository";

/** A recorded D1 statement used to verify the repository's SQL and bound parameters. */
interface RecordedStatement {
  parameters: unknown[];
  sql: string;
}

/**
 * Build a minimal D1 double whose `first()` returns `selectRow` for the repository's `SELECT`
 * (mirrors `../users/repository.test.ts`'s fake D1 shape).
 */
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

describe("ChatRepository", () => {
  it("creates a new chat row for the given owner with no title or route yet", async () => {
    const { database, statements } = databaseFor(null);

    const chat = await new ChatRepository(database).create("alice@example.com");

    expect(chat.ownerEmail).toBe("alice@example.com");
    expect(chat.title).toBeNull();
    expect(chat.route).toBeNull();
    expect(chat.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(statements[0]).toMatchObject({
      parameters: [
        chat.id,
        "alice@example.com",
        chat.createdAt,
        chat.updatedAt,
      ],
      sql: expect.stringContaining("INSERT INTO chats"),
    });
  });

  it("returns the chat when the row's owner_email matches the requester", async () => {
    const { database, statements } = databaseFor({
      id: "chat-1",
      owner_email: "alice@example.com",
      title: null,
      route: null,
      created_at: "2026-08-03T00:00:00.000Z",
      updated_at: "2026-08-03T00:00:00.000Z",
    });

    const chat = await new ChatRepository(database).findOwned(
      "chat-1",
      "alice@example.com",
    );

    expect(chat).toEqual({
      id: "chat-1",
      ownerEmail: "alice@example.com",
      title: null,
      route: null,
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
    });
    expect(statements[0]).toMatchObject({
      parameters: ["chat-1", "alice@example.com"],
      sql: expect.stringContaining("WHERE id = ? AND owner_email = ?"),
    });
  });

  it("returns null for a chat owned by a different identity, indistinguishable from a missing one", async () => {
    // The fake's `first()` returns `null` for both "does not exist" and "exists but the SQL's
    // own owner_email predicate excluded it" -- exactly the point of scoping ownership inside
    // the query rather than checking it afterward (see repository.ts's findOwned() JSDoc).
    const { database } = databaseFor(null);

    const chat = await new ChatRepository(database).findOwned(
      "chat-1",
      "not-the-owner@example.com",
    );

    expect(chat).toBeNull();
  });
});
