import { describe, expect, it } from "vitest";
import { DiagramRepository } from "./repository";

/** A recorded D1 statement used to verify the repository's SQL and bound parameters. */
interface RecordedStatement {
  parameters: unknown[];
  sql: string;
}

/** Extra, per-test-case configuration for {@link databaseFor}'s fake `run()`/`all()` results. */
interface DatabaseForOptions {
  /** Rows `all()` resolves with -- `listOwned()`. Defaults to no rows. */
  selectRows?: Record<string, unknown>[];
  /** `meta.changes` `run()` resolves with -- `saveGraphData()`/`remove()`. Defaults to `1`. */
  changes?: number;
}

/**
 * Build a minimal D1 double whose `first()` returns `selectRow` for the repository's `SELECT`
 * (mirrors `demos/agentic-ai-chat`'s `chats/repository.test.ts` fake D1 shape).
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

/** A stored row shape matching one diagram, for stubbing `first()`/`all()`. */
function rowFor(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    created_at: "2026-01-01T00:00:00.000Z",
    description: null,
    graph_data: '{"edges":[],"nodes":[],"viewport":{"x":0,"y":0,"zoom":1}}',
    id: "11111111-1111-1111-1111-111111111111",
    owner_email: "alice@example.com",
    title: "Untitled Diagram",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("DiagramRepository", () => {
  it("creates a diagram with default title, description, and an empty graph", async () => {
    const { database, statements } = databaseFor(null);

    const diagram = await new DiagramRepository(database).create(
      "alice@example.com",
      {},
    );

    expect(diagram).toMatchObject({
      description: null,
      ownerEmail: "alice@example.com",
      title: "Untitled Diagram",
    });
    expect(JSON.parse(diagram.graphData)).toEqual({
      edges: [],
      nodes: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    expect(statements[0]?.sql).toContain("INSERT INTO diagrams");
    expect(statements[0]?.parameters).toEqual([
      diagram.id,
      "alice@example.com",
      "Untitled Diagram",
      null,
      diagram.graphData,
      diagram.createdAt,
      diagram.updatedAt,
    ]);
  });

  it("creates a diagram with a caller-supplied title, description, and blueprint graph", async () => {
    const { database } = databaseFor(null);
    const blueprintGraph =
      '{"edges":[],"nodes":[{"id":"a"}],"viewport":{"x":0,"y":0,"zoom":1}}';

    const diagram = await new DiagramRepository(database).create(
      "alice@example.com",
      {
        description: "A test diagram",
        graphData: blueprintGraph,
        title: "My Diagram",
      },
    );

    expect(diagram).toMatchObject({
      description: "A test diagram",
      graphData: blueprintGraph,
      title: "My Diagram",
    });
  });

  it("finds a diagram scoped to its owner", async () => {
    const { database, statements } = databaseFor(rowFor());

    const diagram = await new DiagramRepository(database).findOwned(
      "11111111-1111-1111-1111-111111111111",
      "alice@example.com",
    );

    expect(diagram).toMatchObject({ ownerEmail: "alice@example.com" });
    expect(statements[0]?.parameters).toEqual([
      "11111111-1111-1111-1111-111111111111",
      "alice@example.com",
    ]);
  });

  it("returns null when a diagram does not exist or is owned by someone else", async () => {
    const { database } = databaseFor(null);

    const diagram = await new DiagramRepository(database).findOwned(
      "11111111-1111-1111-1111-111111111111",
      "eve@example.com",
    );

    expect(diagram).toBeNull();
  });

  it("lists every diagram owned by an identity, newest updated first per the query order", async () => {
    const { database, statements } = databaseFor(null, {
      selectRows: [
        rowFor(),
        rowFor({ id: "22222222-2222-2222-2222-222222222222" }),
      ],
    });

    const diagrams = await new DiagramRepository(database).listOwned(
      "alice@example.com",
    );

    expect(diagrams).toHaveLength(2);
    expect(statements[0]?.sql).toContain("ORDER BY updated_at DESC");
    expect(statements[0]?.parameters).toEqual(["alice@example.com"]);
  });

  it("updates title and description while leaving omitted fields unchanged", async () => {
    const { database } = databaseFor(rowFor({ description: "old" }));

    const updated = await new DiagramRepository(database).updateMetadata(
      "11111111-1111-1111-1111-111111111111",
      "alice@example.com",
      { title: "New Title" },
    );

    expect(updated).toMatchObject({ description: "old", title: "New Title" });
  });

  it("clears the description when explicitly set to null", async () => {
    const { database } = databaseFor(rowFor({ description: "old" }));

    const updated = await new DiagramRepository(database).updateMetadata(
      "11111111-1111-1111-1111-111111111111",
      "alice@example.com",
      { description: null },
    );

    expect(updated?.description).toBeNull();
  });

  it("returns null from updateMetadata for a diagram not owned by the caller", async () => {
    const { database } = databaseFor(null);

    const updated = await new DiagramRepository(database).updateMetadata(
      "11111111-1111-1111-1111-111111111111",
      "eve@example.com",
      { title: "New Title" },
    );

    expect(updated).toBeNull();
  });

  it("saves graph data and returns the new updatedAt when the diagram is owned by the caller", async () => {
    const { database, statements } = databaseFor(null, { changes: 1 });
    const graphData =
      '{"edges":[],"nodes":[],"viewport":{"x":0,"y":0,"zoom":1}}';

    const updatedAt = await new DiagramRepository(database).saveGraphData(
      "11111111-1111-1111-1111-111111111111",
      "alice@example.com",
      graphData,
    );

    expect(updatedAt).not.toBeNull();
    expect(statements[0]?.parameters).toEqual([
      graphData,
      updatedAt,
      "11111111-1111-1111-1111-111111111111",
      "alice@example.com",
    ]);
  });

  it("returns null from saveGraphData when no row matches the id and owner", async () => {
    const { database } = databaseFor(null, { changes: 0 });

    const updatedAt = await new DiagramRepository(database).saveGraphData(
      "11111111-1111-1111-1111-111111111111",
      "eve@example.com",
      "{}",
    );

    expect(updatedAt).toBeNull();
  });

  it("removes a diagram owned by the caller and reports success", async () => {
    const { database } = databaseFor(null, { changes: 1 });

    const removed = await new DiagramRepository(database).remove(
      "11111111-1111-1111-1111-111111111111",
      "alice@example.com",
    );

    expect(removed).toBe(true);
  });

  it("reports failure removing a diagram not owned by the caller", async () => {
    const { database } = databaseFor(null, { changes: 0 });

    const removed = await new DiagramRepository(database).remove(
      "11111111-1111-1111-1111-111111111111",
      "eve@example.com",
    );

    expect(removed).toBe(false);
  });

  it("removes a diagram by id alone, with no owner scoping", async () => {
    const { database, statements } = databaseFor(null, { changes: 1 });

    const removed = await new DiagramRepository(database).removeAny(
      "11111111-1111-1111-1111-111111111111",
    );

    expect(removed).toBe(true);
    expect(statements[0]?.sql).toContain("DELETE FROM diagrams WHERE id = ?");
    expect(statements[0]?.parameters).toEqual([
      "11111111-1111-1111-1111-111111111111",
    ]);
  });

  it("reports failure removing a diagram id that does not exist", async () => {
    const { database } = databaseFor(null, { changes: 0 });

    const removed = await new DiagramRepository(database).removeAny(
      "11111111-1111-1111-1111-111111111111",
    );

    expect(removed).toBe(false);
  });

  it("loads a diagram by id alone, with no owner scoping (findAny)", async () => {
    const { database, statements } = databaseFor(
      rowFor({ owner_email: "someone-else@example.com" }),
    );

    const diagram = await new DiagramRepository(database).findAny(
      "11111111-1111-1111-1111-111111111111",
    );

    expect(diagram).toMatchObject({
      id: "11111111-1111-1111-1111-111111111111",
      ownerEmail: "someone-else@example.com",
    });
    expect(statements[0]?.sql).not.toContain("owner_email = ?");
    expect(statements[0]?.parameters).toEqual([
      "11111111-1111-1111-1111-111111111111",
    ]);
  });

  it("returns null from findAny when the diagram no longer exists", async () => {
    const { database } = databaseFor(null);

    const diagram = await new DiagramRepository(database).findAny(
      "11111111-1111-1111-1111-111111111111",
    );

    expect(diagram).toBeNull();
  });

  it("loads only public fields for a share viewer, never ownerEmail", async () => {
    const { database } = databaseFor(rowFor({ title: "Shared Diagram" }));

    const shared = await new DiagramRepository(database).findPublicFields(
      "11111111-1111-1111-1111-111111111111",
    );

    expect(shared).toEqual({
      description: null,
      graphData: '{"edges":[],"nodes":[],"viewport":{"x":0,"y":0,"zoom":1}}',
      id: "11111111-1111-1111-1111-111111111111",
      title: "Shared Diagram",
    });
    expect(shared).not.toHaveProperty("ownerEmail");
  });

  it("returns null from findPublicFields when the diagram no longer exists", async () => {
    const { database } = databaseFor(null);

    const shared = await new DiagramRepository(database).findPublicFields(
      "11111111-1111-1111-1111-111111111111",
    );

    expect(shared).toBeNull();
  });

  describe("findAccessible", () => {
    it('reports role "owner" when the caller owns the diagram', async () => {
      const { database, statements } = databaseFor(rowFor({ role: "owner" }));

      const result = await new DiagramRepository(database).findAccessible(
        "11111111-1111-1111-1111-111111111111",
        "alice@example.com",
      );

      expect(result).toMatchObject({
        diagram: { ownerEmail: "alice@example.com" },
        role: "owner",
      });
      expect(statements[0]?.parameters).toEqual([
        "11111111-1111-1111-1111-111111111111",
        "alice@example.com",
      ]);
    });

    it('reports role "editor" when the caller is a collaborator, not the owner', async () => {
      const { database } = databaseFor(
        rowFor({ owner_email: "alice@example.com", role: "editor" }),
      );

      const result = await new DiagramRepository(database).findAccessible(
        "11111111-1111-1111-1111-111111111111",
        "colleague@example.com",
      );

      expect(result).toMatchObject({
        diagram: { ownerEmail: "alice@example.com" },
        role: "editor",
      });
    });

    it("returns null when the caller is neither the owner nor a collaborator", async () => {
      const { database } = databaseFor(null);

      const result = await new DiagramRepository(database).findAccessible(
        "11111111-1111-1111-1111-111111111111",
        "mallory@example.com",
      );

      expect(result).toBeNull();
    });

    it("returns null for a collaborator-in-name-only row pointing at a diagram that no longer exists", async () => {
      // The query starts from `diagrams`, so a stale `diagram_collaborators` row for a deleted
      // diagram id can never itself produce a row -- simulated here the same way as "diagram
      // does not exist at all": `first()` resolves to `null`.
      const { database } = databaseFor(null);

      const result = await new DiagramRepository(database).findAccessible(
        "11111111-1111-1111-1111-111111111111",
        "stale-collaborator@example.com",
      );

      expect(result).toBeNull();
    });
  });

  describe("listSharedWith", () => {
    it("lists diagrams the identity collaborates on, newest updated first per the query order", async () => {
      const { database, statements } = databaseFor(null, {
        selectRows: [
          rowFor({ owner_email: "alice@example.com" }),
          rowFor({
            id: "22222222-2222-2222-2222-222222222222",
            owner_email: "bob@example.com",
          }),
        ],
      });

      const diagrams = await new DiagramRepository(database).listSharedWith(
        "colleague@example.com",
      );

      expect(diagrams).toHaveLength(2);
      expect(diagrams.map((d) => d.ownerEmail)).toEqual([
        "alice@example.com",
        "bob@example.com",
      ]);
      expect(statements[0]?.sql).toContain("ORDER BY d.updated_at DESC");
      expect(statements[0]?.parameters).toEqual(["colleague@example.com"]);
    });

    it("returns an empty array when the identity collaborates on nothing", async () => {
      const { database } = databaseFor(null, { selectRows: [] });

      const diagrams = await new DiagramRepository(database).listSharedWith(
        "nobody@example.com",
      );

      expect(diagrams).toEqual([]);
    });
  });
});
