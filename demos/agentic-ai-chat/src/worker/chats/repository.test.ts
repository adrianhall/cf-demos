import { describe, expect, it } from "vitest";
import { ChatRepository } from "./repository";

/** A recorded D1 statement used to verify the repository's SQL and bound parameters. */
interface RecordedStatement {
  parameters: unknown[];
  sql: string;
}

/** Extra, per-test-case configuration for {@link databaseFor}'s fake `run()`/`all()` results. */
interface DatabaseForOptions {
  /** Rows `all()` resolves with -- Phase 3's `listOwned()`. Defaults to no rows. */
  selectRows?: Record<string, unknown>[];
  /** `meta.changes` `run()` resolves with -- Phase 3's `remove()`. Defaults to `1`. */
  changes?: number;
}

/**
 * Build a minimal D1 double whose `first()` returns `selectRow` for the repository's `SELECT`
 * (mirrors `../users/repository.test.ts`'s fake D1 shape).
 */
function databaseFor(
  selectRow: Record<string, unknown> | null,
  options: DatabaseForOptions = {},
): {
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
        first: async <T>() => selectRow as T | null,
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
  it("creates a new chat row for the given owner with no title yet, defaulted to the basic route", async () => {
    const { database, statements } = databaseFor(null);

    const chat = await new ChatRepository(database).create("alice@example.com");

    expect(chat.ownerEmail).toBe("alice@example.com");
    expect(chat.title).toBeNull();
    expect(chat.route).toBe("basic");
    expect(chat.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(statements[0]).toMatchObject({
      parameters: [
        chat.id,
        "alice@example.com",
        "basic",
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
      route: "reasoning",
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
      route: "reasoning",
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
    });
    expect(statements[0]).toMatchObject({
      parameters: ["chat-1", "alice@example.com"],
      sql: expect.stringContaining("WHERE id = ? AND owner_email = ?"),
    });
  });

  it("coerces a stored route that is not a valid chat route back to the default (a pre-Phase-4 NULL row, for example)", async () => {
    const { database } = databaseFor({
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

    expect(chat?.route).toBe("basic");
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

  it("findById looks up a chat with no owner scoping", async () => {
    const { database, statements } = databaseFor({
      id: "chat-1",
      owner_email: "alice@example.com",
      title: null,
      route: null,
      created_at: "2026-08-03T00:00:00.000Z",
      updated_at: "2026-08-03T00:00:00.000Z",
    });

    const chat = await new ChatRepository(database).findById("chat-1");

    expect(chat?.ownerEmail).toBe("alice@example.com");
    expect(statements[0]).toMatchObject({
      parameters: ["chat-1"],
      sql: expect.stringContaining("WHERE id = ?"),
    });
    expect(statements[0]?.sql).not.toContain("owner_email = ?");
  });

  it("findById returns null when the chat's directory row no longer exists", async () => {
    const { database } = databaseFor(null);

    const chat = await new ChatRepository(database).findById("gone");

    expect(chat).toBeNull();
  });

  it("listOwned returns the identity's own chats, most recently updated first in SQL", async () => {
    const { database, statements } = databaseFor(null, {
      selectRows: [
        {
          id: "chat-2",
          owner_email: "alice@example.com",
          title: "Second chat",
          route: null,
          created_at: "2026-08-01T00:00:00.000Z",
          updated_at: "2026-08-03T00:00:00.000Z",
        },
        {
          id: "chat-1",
          owner_email: "alice@example.com",
          title: null,
          route: null,
          created_at: "2026-08-01T00:00:00.000Z",
          updated_at: "2026-08-02T00:00:00.000Z",
        },
      ],
    });

    const chats = await new ChatRepository(database).listOwned(
      "alice@example.com",
    );

    expect(chats.map((chat) => chat.id)).toEqual(["chat-2", "chat-1"]);
    expect(statements[0]).toMatchObject({
      parameters: ["alice@example.com"],
      sql: expect.stringContaining("ORDER BY updated_at DESC"),
    });
  });

  it("touch updates a chat's updated_at by id with no owner scoping", async () => {
    const { database, statements } = databaseFor(null);

    await new ChatRepository(database).touch("chat-1");

    expect(statements[0]?.sql).toContain("UPDATE chats SET updated_at = ?");
    expect(statements[0]?.parameters[1]).toBe("chat-1");
  });

  it("setTitleIfUnset only writes when the title column is still NULL", async () => {
    const { database, statements } = databaseFor(null);

    await new ChatRepository(database).setTitleIfUnset(
      "chat-1",
      "Trip Planning",
    );

    expect(statements[0]).toMatchObject({
      parameters: ["Trip Planning", "chat-1"],
      sql: expect.stringContaining("WHERE id = ? AND title IS NULL"),
    });
  });

  it("setRouteIfUnstarted writes the new route and reports true when a row updated (scoped by owner and title IS NULL)", async () => {
    const { database, statements } = databaseFor(null, { changes: 1 });

    const updated = await new ChatRepository(database).setRouteIfUnstarted(
      "chat-1",
      "alice@example.com",
      "reasoning",
    );

    expect(updated).toBe(true);
    expect(statements[0]).toMatchObject({
      parameters: ["reasoning", "chat-1", "alice@example.com"],
      sql: expect.stringContaining(
        "WHERE id = ? AND owner_email = ? AND title IS NULL",
      ),
    });
  });

  it("setRouteIfUnstarted reports false when the chat already has a title (its first turn already completed)", async () => {
    const { database } = databaseFor(null, { changes: 0 });

    const updated = await new ChatRepository(database).setRouteIfUnstarted(
      "chat-1",
      "alice@example.com",
      "reasoning",
    );

    expect(updated).toBe(false);
  });

  it("remove reports true when a row owned by the requester was actually deleted", async () => {
    const { database, statements } = databaseFor(null, { changes: 1 });

    const removed = await new ChatRepository(database).remove(
      "chat-1",
      "alice@example.com",
    );

    expect(removed).toBe(true);
    expect(statements[0]).toMatchObject({
      parameters: ["chat-1", "alice@example.com"],
      sql: expect.stringContaining("DELETE FROM chats"),
    });
  });

  it("remove reports false when no row matched (wrong id or wrong owner)", async () => {
    const { database } = databaseFor(null, { changes: 0 });

    const removed = await new ChatRepository(database).remove(
      "chat-1",
      "not-the-owner@example.com",
    );

    expect(removed).toBe(false);
  });
});
