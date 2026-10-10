import { describe, expect, it } from "vitest";
import { TodoRepository } from "./repository";

/** A recorded D1 statement used to verify the repository's user-scoped predicates. */
interface RecordedStatement {
  parameters: unknown[];
  sql: string;
}

/** Build the minimal D1 double needed to exercise a repository operation. */
function databaseFor(row: Record<string, unknown> | null): {
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
    first: async <T>() => row as T | null,
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
  const database = {
    prepare(sql: string) {
      latestStatement = { parameters: [], sql };
      statements.push(latestStatement);
      return statement;
    },
  } satisfies Pick<D1Database, "prepare">;

  return { database, statements };
}

describe("TodoRepository", () => {
  it("reads and updates a TODO only through the verified owner's predicate", async () => {
    const { database, statements } = databaseFor({
      completed: 0,
      created_at: "2026-07-27T10:00:00.000Z",
      id: "5d837139-c37f-4fe3-b95c-69757a3a823d",
      title: "Original title",
      updated_at: "2026-07-27T10:00:00.000Z",
    });
    const repository = new TodoRepository(database);

    const todo = await repository.update(
      "alice@example.com",
      "5d837139-c37f-4fe3-b95c-69757a3a823d",
      { completed: true, title: "Updated title" },
    );

    expect(todo).toMatchObject({ completed: true, title: "Updated title" });
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatchObject({
      parameters: ["5d837139-c37f-4fe3-b95c-69757a3a823d", "alice@example.com"],
      sql: expect.stringContaining("WHERE id = ? AND user_id = ?"),
    });
    expect(statements[1]).toMatchObject({
      parameters: expect.arrayContaining(["alice@example.com"]),
      sql: expect.stringContaining("WHERE id = ? AND user_id = ?"),
    });
  });

  it("scopes completed-task cleanup to the verified owner", async () => {
    const { database, statements } = databaseFor(null);

    await new TodoRepository(database).deleteCompleted("bob@example.com");

    expect(statements[0]).toMatchObject({
      parameters: ["bob@example.com"],
      sql: "DELETE FROM todos WHERE user_id = ? AND completed = 1",
    });
  });
});
