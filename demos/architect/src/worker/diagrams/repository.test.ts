import { describe, expect, it } from "vitest";
import { DiagramRepository } from "./repository";

/** A recorded D1 statement used to verify the repository's access-scoped predicates. */
interface RecordedStatement {
  parameters: unknown[];
  sql: string;
}

/** Build the minimal D1 double needed to exercise a repository operation. */
function databaseFor(row: Record<string, unknown> | null): {
  database: Pick<D1Database, "prepare" | "batch">;
  statements: RecordedStatement[];
} {
  const statements: RecordedStatement[] = [];
  let latestStatement: RecordedStatement | undefined;
  function buildStatement() {
    return {
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
        results: (row ? [row] : []) as T[],
        success: true as const,
      }),
      bind(...parameters: unknown[]) {
        if (latestStatement !== undefined) {
          latestStatement.parameters = parameters;
        }
        return this;
      },
      first: async <T>() => row as T | null,
      raw: async <T>(): Promise<[string[], ...T[]]> => [[], [] as T],
      run: async <T>() => ({
        meta: {
          changed_db: false,
          changes: 1,
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
  }
  const database = {
    prepare(sql: string) {
      latestStatement = { parameters: [], sql };
      statements.push(latestStatement);
      return buildStatement();
    },
    async batch<T>(preparedStatements: D1PreparedStatement[]) {
      const results = [];
      for (const statement of preparedStatements) {
        results.push(await statement.run<T>());
      }
      return results;
    },
  } satisfies Pick<D1Database, "prepare" | "batch">;

  return { database, statements };
}

describe("DiagramRepository", () => {
  it("creates the diagram and its owner membership row in one batch", async () => {
    const { database, statements } = databaseFor(null);
    const repository = new DiagramRepository(database);

    const diagram = await repository.create("owner@example.com", "My diagram");

    expect(diagram).toMatchObject({
      ownerEmail: "owner@example.com",
      title: "My diagram",
    });
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toContain("INSERT INTO diagrams");
    expect(statements[1].sql).toContain("INSERT INTO diagram_members");
    expect(statements[1].parameters).toEqual([
      diagram.id,
      "owner@example.com",
      diagram.createdAt,
    ]);
  });

  it("lists only diagrams the identity is a member of", async () => {
    const { database, statements } = databaseFor({
      id: "d-1",
      owner_email: "owner@example.com",
      title: "Existing",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    const diagrams = await new DiagramRepository(database).listAccessibleBy(
      "owner@example.com",
    );

    expect(diagrams).toEqual([
      {
        id: "d-1",
        ownerEmail: "owner@example.com",
        title: "Existing",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(statements[0].parameters).toEqual(["owner@example.com"]);
    expect(statements[0].sql).toContain("JOIN diagram_members m");
    expect(statements[0].sql).toContain("WHERE m.email = ?");
  });

  it("throws notFound() when the caller has no membership row for the diagram", async () => {
    const { database } = databaseFor(null);
    await expect(
      new DiagramRepository(database).getAccessible("owner@example.com", "d-1"),
    ).rejects.toMatchObject({ problemDetails: { status: 404 } });
  });

  it("getAccessible() returns the diagram for a confirmed editor, not only the owner", async () => {
    const { database } = databaseFor({
      id: "d-1",
      owner_email: "owner@example.com",
      title: "Existing",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      role: "editor",
    });

    const diagram = await new DiagramRepository(database).getAccessible(
      "editor@example.com",
      "d-1",
    );

    expect(diagram.id).toBe("d-1");
  });

  it("requireOwner() returns the diagram for a confirmed owner", async () => {
    const { database } = databaseFor({
      id: "d-1",
      owner_email: "owner@example.com",
      title: "Existing",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      role: "owner",
    });

    const diagram = await new DiagramRepository(database).requireOwner(
      "owner@example.com",
      "d-1",
    );

    expect(diagram.id).toBe("d-1");
  });

  it("requireOwner() throws notFound() for a caller with no membership at all", async () => {
    const { database } = databaseFor(null);
    await expect(
      new DiagramRepository(database).requireOwner("nobody@example.com", "d-1"),
    ).rejects.toMatchObject({ problemDetails: { status: 404 } });
  });

  it("requireOwner() throws forbidden() for a confirmed editor, not notFound()", async () => {
    const { database } = databaseFor({
      id: "d-1",
      owner_email: "owner@example.com",
      title: "Existing",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      role: "editor",
    });

    await expect(
      new DiagramRepository(database).requireOwner("editor@example.com", "d-1"),
    ).rejects.toMatchObject({ problemDetails: { status: 403 } });
  });

  it("renames a diagram without repeating the owner-only predicate", async () => {
    const { database, statements } = databaseFor({
      id: "d-1",
      owner_email: "owner@example.com",
      title: "Old title",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      role: "editor",
    });

    const diagram = await new DiagramRepository(database).rename(
      "editor@example.com",
      "d-1",
      "New title",
    );

    expect(diagram.title).toBe("New title");
    expect(statements[1].sql).toBe(
      "UPDATE diagrams SET title = ?, updated_at = ? WHERE id = ?",
    );
    expect(statements[1].parameters).toEqual([
      "New title",
      diagram.updatedAt,
      "d-1",
    ]);
  });

  it("touches updated_at without changing the title", async () => {
    const { database, statements } = databaseFor(null);
    await new DiagramRepository(database).touchUpdatedAt("d-1");
    expect(statements[0].sql).toBe(
      "UPDATE diagrams SET updated_at = ? WHERE id = ?",
    );
    expect(statements[0].parameters[1]).toBe("d-1");
  });

  it("lists members, owner first", async () => {
    const { database, statements } = databaseFor({
      email: "owner@example.com",
      role: "owner",
    });

    const members = await new DiagramRepository(database).listMembers("d-1");

    expect(members).toEqual([{ email: "owner@example.com", role: "owner" }]);
    expect(statements[0].sql).toContain("ORDER BY role DESC");
  });

  it("adds a member idempotently via ON CONFLICT DO NOTHING", async () => {
    const { database, statements } = databaseFor(null);
    await new DiagramRepository(database).addMember(
      "d-1",
      "editor@example.com",
      "editor",
    );
    expect(statements[0].sql).toContain(
      "ON CONFLICT (diagram_id, email) DO NOTHING",
    );
    expect(statements[0].parameters.slice(0, 3)).toEqual([
      "d-1",
      "editor@example.com",
      "editor",
    ]);
  });
});
