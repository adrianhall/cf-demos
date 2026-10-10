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

/** A stored directory row shape, for stubbing `listWithDiagramCounts()`'s `all()`. */
function rowFor(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    diagram_count: 0,
    display_name: null,
    email: "alice@example.com",
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Build a D1 double whose `all()` resolves with `rows` and whose `first()` resolves with
 * `{ count: total }` -- exercises `listWithDiagramCounts()`'s two separate queries (the page
 * itself, and the unpaginated total row count) without needing to distinguish which SQL string
 * a given `prepare()` call carries.
 */
function listDatabaseFor(
  rows: Record<string, unknown>[],
  total: number,
): {
  database: Pick<D1Database, "prepare">;
  statements: RecordedStatement[];
} {
  const statements: RecordedStatement[] = [];
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
      results: rows as T[],
      success: true as const,
    }),
    bind(...parameters: unknown[]) {
      const record = statements.at(-1);
      if (record !== undefined) {
        record.parameters = parameters;
      }
      return statement;
    },
    first: async <T>() => ({ count: total }) as T,
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
      statements.push({ parameters: [], sql });
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

  it("lists a page of the directory annotated with each identity's diagram count", async () => {
    const { database, statements } = listDatabaseFor(
      [
        rowFor({ diagram_count: 3, email: "alice@example.com" }),
        rowFor({ diagram_count: 0, email: "bob@example.com" }),
      ],
      2,
    );

    const page = await new UserRepository(database).listWithDiagramCounts({
      limit: 20,
      offset: 0,
    });

    expect(page).toEqual({
      total: 2,
      users: [
        {
          diagramCount: 3,
          displayName: null,
          email: "alice@example.com",
          firstSeenAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-02T00:00:00.000Z",
        },
        {
          diagramCount: 0,
          displayName: null,
          email: "bob@example.com",
          firstSeenAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    });
    expect(statements[0]?.sql).toContain("ORDER BY u.last_seen_at DESC");
    expect(statements[0]?.parameters).toEqual([20, 0]);
  });

  it("reports the total row count independent of the page's own limit/offset", async () => {
    const { database, statements } = listDatabaseFor([rowFor()], 42);

    const page = await new UserRepository(database).listWithDiagramCounts({
      limit: 1,
      offset: 5,
    });

    expect(page.total).toBe(42);
    expect(statements[1]?.sql).toContain("SELECT COUNT(*) AS count FROM users");
  });

  it("returns an empty page with a zero total when the directory is empty", async () => {
    const { database } = listDatabaseFor([], 0);

    const page = await new UserRepository(database).listWithDiagramCounts({
      limit: 20,
      offset: 0,
    });

    expect(page).toEqual({ total: 0, users: [] });
  });

  it("reports an email exists when a matching directory row is found", async () => {
    const statements: RecordedStatement[] = [];
    const database = {
      prepare(sql: string) {
        const record: RecordedStatement = { parameters: [], sql };
        statements.push(record);
        return {
          bind: (...parameters: unknown[]) => {
            record.parameters = parameters;
            return { first: async () => ({ 1: 1 }) };
          },
        };
      },
    };

    const exists = await new UserRepository(
      database as unknown as Pick<D1Database, "prepare">,
    ).exists("alice@example.com");

    expect(exists).toBe(true);
    expect(statements[0]?.sql).toContain("SELECT 1 FROM users WHERE email = ?");
    expect(statements[0]?.parameters).toEqual(["alice@example.com"]);
  });

  it("reports an email does not exist when no directory row matches", async () => {
    const database = {
      prepare(_sql: string) {
        return { bind: () => ({ first: async () => null }) };
      },
    };

    const exists = await new UserRepository(
      database as unknown as Pick<D1Database, "prepare">,
    ).exists("stranger@example.com");

    expect(exists).toBe(false);
  });
});
