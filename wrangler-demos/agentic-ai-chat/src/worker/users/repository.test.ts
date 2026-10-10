import { describe, expect, it } from "vitest";
import { UserRepository } from "./repository";

/** A recorded D1 statement used to verify the repository's SQL and bound parameters. */
interface RecordedStatement {
  parameters: unknown[];
  sql: string;
}

/** Extra, per-test-case configuration for {@link databaseFor}'s fake `run()`/`all()` results
 * (mirrors `../usage/repository.test.ts`'s fake D1 shape). */
interface DatabaseForOptions {
  /** `meta.changes` `run()` resolves with -- `updateMetadata()`'s own "row existed" signal.
   * Defaults to `0`. */
  changes?: number;
  /** Rows `all()` resolves with -- `list()`. Defaults to no rows. */
  selectRows?: Record<string, unknown>[];
}

/**
 * Build a minimal D1 double whose `first()` returns `selectRow` for the repository's read-back
 * `SELECT`, regardless of which upsert/update branch ran first.
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
            changes: options.changes ?? 0,
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
  describe("ensureUser", () => {
    it("creates a fresh ordinary user without touching an existing is_admin flag", async () => {
      const { database, statements } = databaseFor({
        business: null,
        created_at: "2026-08-03T00:00:00.000Z",
        email: "alice@example.com",
        geo: null,
        is_admin: 0,
      });

      const user = await new UserRepository(database).ensureUser(
        "alice@example.com",
        false,
      );

      expect(user).toEqual({
        business: null,
        createdAt: "2026-08-03T00:00:00.000Z",
        email: "alice@example.com",
        geo: null,
        isAdmin: false,
      });
      expect(statements[0]).toMatchObject({
        parameters: ["alice@example.com", expect.any(String)],
        sql: expect.stringContaining("DO NOTHING"),
      });
    });

    it("idempotently re-forces the configured administrator's is_admin flag to 1", async () => {
      const { database, statements } = databaseFor({
        business: null,
        created_at: "2026-08-03T00:00:00.000Z",
        email: "admin@example.com",
        geo: null,
        is_admin: 1,
      });

      const user = await new UserRepository(database).ensureUser(
        "admin@example.com",
        true,
      );

      expect(user).toEqual({
        business: null,
        createdAt: "2026-08-03T00:00:00.000Z",
        email: "admin@example.com",
        geo: null,
        isAdmin: true,
      });
      expect(statements[0]).toMatchObject({
        parameters: ["admin@example.com", expect.any(String)],
        sql: expect.stringContaining("DO UPDATE SET is_admin = 1"),
      });
    });

    it("never issues the admin-forcing statement for a non-administrator identity", async () => {
      const { statements, database } = databaseFor({
        business: null,
        created_at: "2026-08-03T00:00:00.000Z",
        email: "bob@example.com",
        geo: null,
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

  describe("findByEmail", () => {
    it("maps a populated row, coercing an unrecognized business/geo value back to null", async () => {
      const { database } = databaseFor({
        business: "not-a-real-segment",
        created_at: "2026-08-03T00:00:00.000Z",
        email: "alice@example.com",
        geo: "apac",
        is_admin: 0,
      });

      const user = await new UserRepository(database).findByEmail(
        "alice@example.com",
      );

      expect(user).toEqual({
        business: null,
        createdAt: "2026-08-03T00:00:00.000Z",
        email: "alice@example.com",
        geo: "apac",
        isAdmin: false,
      });
    });

    it("returns null, not a throw, for an identity with no users row", async () => {
      const { database } = databaseFor(null);

      const user = await new UserRepository(database).findByEmail(
        "ghost@example.com",
      );

      expect(user).toBeNull();
    });
  });

  describe("isAdmin", () => {
    it("returns true for an administrator identity", async () => {
      const { database } = databaseFor({
        business: null,
        created_at: "2026-08-03T00:00:00.000Z",
        email: "admin@example.com",
        geo: null,
        is_admin: 1,
      });

      await expect(
        new UserRepository(database).isAdmin("admin@example.com"),
      ).resolves.toBe(true);
    });

    it("returns false for an ordinary identity", async () => {
      const { database } = databaseFor({
        business: null,
        created_at: "2026-08-03T00:00:00.000Z",
        email: "alice@example.com",
        geo: null,
        is_admin: 0,
      });

      await expect(
        new UserRepository(database).isAdmin("alice@example.com"),
      ).resolves.toBe(false);
    });

    it("returns false, not a throw, for an identity that has never signed in", async () => {
      const { database } = databaseFor(null);

      await expect(
        new UserRepository(database).isAdmin("ghost@example.com"),
      ).resolves.toBe(false);
    });
  });

  describe("list", () => {
    it("maps every row, ordered by the query's own ORDER BY email", async () => {
      const { database, statements } = databaseFor(null, {
        selectRows: [
          {
            business: "field",
            created_at: "2026-08-03T00:00:00.000Z",
            email: "alice@example.com",
            geo: null,
            is_admin: 0,
          },
          {
            business: null,
            created_at: "2026-08-03T00:00:00.000Z",
            email: "bob@example.com",
            geo: "emea",
            is_admin: 1,
          },
        ],
      });

      const users = await new UserRepository(database).list();

      expect(users).toEqual([
        {
          business: "field",
          createdAt: "2026-08-03T00:00:00.000Z",
          email: "alice@example.com",
          geo: null,
          isAdmin: false,
        },
        {
          business: null,
          createdAt: "2026-08-03T00:00:00.000Z",
          email: "bob@example.com",
          geo: "emea",
          isAdmin: true,
        },
      ]);
      expect(statements[0]?.sql).toContain("ORDER BY email ASC");
    });
  });

  describe("updateMetadata", () => {
    it("updates both fields together and returns the re-read row", async () => {
      const { database, statements } = databaseFor(
        {
          business: "leadership",
          created_at: "2026-08-03T00:00:00.000Z",
          email: "alice@example.com",
          geo: "apac",
          is_admin: 0,
        },
        { changes: 1 },
      );

      const user = await new UserRepository(database).updateMetadata(
        "alice@example.com",
        "leadership",
        "apac",
      );

      expect(user).toEqual({
        business: "leadership",
        createdAt: "2026-08-03T00:00:00.000Z",
        email: "alice@example.com",
        geo: "apac",
        isAdmin: false,
      });
      expect(statements[0]).toMatchObject({
        parameters: ["leadership", "apac", "alice@example.com"],
        sql: expect.stringContaining("UPDATE users"),
      });
    });

    it("clears both fields back to null", async () => {
      const { database, statements } = databaseFor(
        {
          business: null,
          created_at: "2026-08-03T00:00:00.000Z",
          email: "alice@example.com",
          geo: null,
          is_admin: 0,
        },
        { changes: 1 },
      );

      await new UserRepository(database).updateMetadata(
        "alice@example.com",
        null,
        null,
      );

      expect(statements[0]?.parameters).toEqual([
        null,
        null,
        "alice@example.com",
      ]);
    });

    it("returns null, not a throw, when no users row exists for that email", async () => {
      const { database } = databaseFor(null, { changes: 0 });

      const user = await new UserRepository(database).updateMetadata(
        "ghost@example.com",
        "field",
        "emea",
      );

      expect(user).toBeNull();
    });
  });
});
