import { describe, expect, it } from "vitest";
import { UserRepository } from "./repository";

/** A recorded D1 statement used to verify the repository's SQL and bound parameters. */
interface RecordedStatement {
  parameters: unknown[];
  sql: string;
}

/**
 * Build a minimal D1 double whose `first()` returns `selectRow` for the repository's read-back
 * `SELECT`, regardless of which upsert branch ran first.
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
      };
      return statement;
    },
  } satisfies Pick<D1Database, "prepare">;

  return { database, statements };
}

describe("UserRepository", () => {
  it("creates a fresh ordinary user without touching an existing is_admin flag", async () => {
    const { database, statements } = databaseFor({
      created_at: "2026-08-03T00:00:00.000Z",
      email: "alice@example.com",
      is_admin: 0,
    });

    const user = await new UserRepository(database).ensureUser(
      "alice@example.com",
      false,
    );

    expect(user).toEqual({
      createdAt: "2026-08-03T00:00:00.000Z",
      email: "alice@example.com",
      isAdmin: false,
    });
    expect(statements[0]).toMatchObject({
      parameters: ["alice@example.com", expect.any(String)],
      sql: expect.stringContaining("DO NOTHING"),
    });
  });

  it("idempotently re-forces the configured administrator's is_admin flag to 1", async () => {
    const { database, statements } = databaseFor({
      created_at: "2026-08-03T00:00:00.000Z",
      email: "admin@example.com",
      is_admin: 1,
    });

    const user = await new UserRepository(database).ensureUser(
      "admin@example.com",
      true,
    );

    expect(user).toEqual({
      createdAt: "2026-08-03T00:00:00.000Z",
      email: "admin@example.com",
      isAdmin: true,
    });
    expect(statements[0]).toMatchObject({
      parameters: ["admin@example.com", expect.any(String)],
      sql: expect.stringContaining("DO UPDATE SET is_admin = 1"),
    });
  });

  it("never issues the admin-forcing statement for a non-administrator identity", async () => {
    const { statements, database } = databaseFor({
      created_at: "2026-08-03T00:00:00.000Z",
      email: "bob@example.com",
      is_admin: 0,
    });

    await new UserRepository(database).ensureUser("bob@example.com", false);

    expect(statements).toHaveLength(2);
    expect(statements[0]?.sql).not.toContain("is_admin = 1");
  });

  it("throws a defensive guard error if the read-back after an upsert finds no row", async () => {
    const { database } = databaseFor(null);

    await expect(
      new UserRepository(database).ensureUser("ghost@example.com", false),
    ).rejects.toThrow(/not found/);
  });
});
