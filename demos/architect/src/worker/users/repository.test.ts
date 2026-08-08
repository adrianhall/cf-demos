import { describe, expect, it } from "vitest";
import { UserRepository } from "./repository";

/** A recorded D1 statement used to verify the repository's upsert predicate. */
interface RecordedStatement {
  parameters: unknown[];
  sql: string;
}

/** Build the minimal D1 double needed to exercise the repository. */
function databaseFor(): {
  database: Pick<D1Database, "prepare">;
  statements: RecordedStatement[];
} {
  const statements: RecordedStatement[] = [];
  let latestStatement: RecordedStatement | undefined;
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
      if (latestStatement !== undefined) {
        latestStatement.parameters = parameters;
      }
      return statement;
    },
    first: async <T>() => null as T | null,
    raw: async <T>(): Promise<[string[], ...T[]]> => [[], [] as T],
    run: async () => ({
      meta: {
        changed_db: false,
        changes: 0,
        duration: 0,
        last_row_id: 0,
        rows_read: 0,
        rows_written: 0,
        size_after: 0,
      },
      results: [],
      success: true as const,
    }),
  };
  const database = {
    prepare(sql: string) {
      latestStatement = { parameters: [], sql };
      statements.push(latestStatement);
      return statement;
    },
  } satisfies Pick<D1Database, "prepare">;

  return { database, statements };
}

describe("UserRepository", () => {
  it("inserts a new directory row keyed on email with a null display name", async () => {
    const { database, statements } = databaseFor();

    await new UserRepository(database).upsert("alice@example.com");

    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({
      parameters: ["alice@example.com", expect.any(String), expect.any(String)],
      sql: expect.stringContaining(
        "INSERT INTO users (email, display_name, first_seen_at, last_seen_at)",
      ),
    });
  });

  it("refreshes only last_seen_at on conflict, leaving display_name untouched", async () => {
    const { database, statements } = databaseFor();

    await new UserRepository(database).upsert("bob@example.com");

    expect(statements[0]?.sql).toContain(
      "ON CONFLICT(email) DO UPDATE SET last_seen_at = excluded.last_seen_at",
    );
    expect(statements[0]?.sql).not.toContain("display_name = excluded");
  });
});
