import { unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  addEdgeTool,
  addNodeTool,
  autoLayoutDiagramTool,
  createDiagramTool,
  createShareLinkTool,
  deleteDiagramTool,
  exportDiagramTool,
  getDiagramTool,
  getShareStatusTool,
  listDiagramsTool,
  type McpToolContext,
  removeEdgeTool,
  removeNodeTool,
  renameDiagramTool,
  revokeShareLinkTool,
  updateEdgeTool,
  updateNodeTool,
} from "./tools";

/** A recorded D1 statement, mirroring `../diagrams/repository.test.ts`'s own fixture shape. */
interface RecordedStatement {
  parameters: unknown[];
  sql: string;
}

/** Per-scenario configuration for {@link contextFor}'s fake D1/KV/logger doubles. */
interface ContextForOptions {
  /** Row `first()` resolves with for `diagrams` table `SELECT`s -- `findOwned()`. Defaults to no
   * row. */
  selectRow?: Record<string, unknown> | null;
  /**
   * Row `first()` resolves with for `diagram_shares` table `SELECT`s -- `ShareRepository`'s
   * `getStatus()`/`revokeActive()` (via `rotate()`). Routed separately from {@link selectRow} by
   * table name so a share tool test can exercise "diagram owned, no/an active share" without the
   * two unrelated lookups fighting over one fixed response. Defaults to no row (no active
   * share).
   */
  shareSelectRow?: Record<string, unknown> | null;
  /** Rows `all()` resolves with -- `listOwned()`/`revokeAllForDiagram()`. Defaults to none. */
  selectRows?: Record<string, unknown>[];
  /** `meta.changes` every `run()` resolves with -- `remove()`. Defaults to `1`. */
  changes?: number;
  ownerEmail?: string;
  /** The incoming `/mcp` request's own URL -- see `McpToolContext.requestUrl`'s JSDoc. */
  requestUrl?: string;
  /** Fixture result `applyOperation()` resolves with. */
  applyOperationResult?: {
    graphData: string;
    updatedAt: string;
    sequence: number;
  };
  /** Fixture result `applyWholeGraphReplace()` resolves with. */
  applyWholeGraphReplaceResult?: { updatedAt: string; sequence: number };
}

/**
 * Build a `McpToolContext` backed by fixture D1/KV/logger doubles, mirroring
 * `../diagrams/repository.test.ts`'s `databaseFor()` -- every tool function under test here is a
 * thin wrapper over the same, already-independently-tested `DiagramRepository`/`ShareRepository`,
 * so these doubles only need to be as detailed as the SQL those repositories actually issue.
 */
function contextFor(options: ContextForOptions = {}): {
  context: McpToolContext;
  statements: RecordedStatement[];
  logger: { info: ReturnType<typeof vi.fn> };
  applyOperation: ReturnType<typeof vi.fn>;
  applyWholeGraphReplace: ReturnType<typeof vi.fn>;
} {
  const statements: RecordedStatement[] = [];
  const logger = { info: vi.fn() };

  const db: Pick<D1Database, "prepare"> = {
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
        first: async <T>() =>
          (sql.includes("FROM diagram_shares")
            ? (options.shareSelectRow ?? null)
            : (options.selectRow ?? null)) as T | null,
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
  };

  const sharesKv: Pick<KVNamespace, "get" | "put" | "delete"> = {
    delete: vi.fn(async () => {}),
    get: (async () => null) as unknown as Pick<KVNamespace, "get">["get"],
    put: vi.fn(async () => {}),
  };

  const applyOperation = vi.fn(
    async () =>
      options.applyOperationResult ?? {
        graphData:
          '{"edges":[],"nodes":[{"id":"n-fixture"}],"viewport":{"x":0,"y":0,"zoom":1}}',
        sequence: 1,
        updatedAt: "2026-01-05T00:00:00.000Z",
      },
  );
  const applyWholeGraphReplace = vi.fn(
    async () =>
      options.applyWholeGraphReplaceResult ?? {
        sequence: 1,
        updatedAt: "2026-01-05T00:00:00.000Z",
      },
  );

  return {
    context: {
      db,
      // The RPC stub's own return type mixes in `Disposable`/`Provider` machinery
      // (`@cloudflare/workers-types`' `Rpc` namespace) a plain fixture function's `Promise<T>`
      // can never structurally satisfy -- cast through `unknown`.
      getDiagramSession: () =>
        ({ applyOperation, applyWholeGraphReplace }) as unknown as ReturnType<
          McpToolContext["getDiagramSession"]
        >,
      logger,
      ownerEmail: options.ownerEmail ?? "alice@example.com",
      requestUrl: options.requestUrl ?? "https://architect.example/mcp",
      sharesKv,
    },
    statements,
    logger,
    applyOperation,
    applyWholeGraphReplace,
  };
}

/** A stored diagram row, matching `../diagrams/repository.test.ts`'s `rowFor()`. */
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

describe("listDiagramsTool", () => {
  it("returns lightweight summaries, omitting graphData and ownerEmail", async () => {
    const { context } = contextFor({
      selectRows: [
        rowFor(),
        rowFor({ id: "22222222-2222-2222-2222-222222222222" }),
      ],
    });

    const { diagrams } = await listDiagramsTool(context);

    expect(diagrams).toEqual([
      {
        description: null,
        id: "11111111-1111-1111-1111-111111111111",
        title: "Untitled Diagram",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        description: null,
        id: "22222222-2222-2222-2222-222222222222",
        title: "Untitled Diagram",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    for (const diagram of diagrams) {
      expect(diagram).not.toHaveProperty("graphData");
      expect(diagram).not.toHaveProperty("ownerEmail");
    }
  });

  it("scopes the listing to the caller's own owner email", async () => {
    const { context, statements } = contextFor({
      ownerEmail: "bob@example.com",
    });

    await listDiagramsTool(context);

    expect(statements[0]?.parameters).toEqual(["bob@example.com"]);
  });
});

describe("getDiagramTool", () => {
  it("returns the full diagram when owned by the caller", async () => {
    const { context } = contextFor({ selectRow: rowFor() });

    const { diagram } = await getDiagramTool(
      context,
      "11111111-1111-1111-1111-111111111111",
    );

    expect(diagram).toMatchObject({
      id: "11111111-1111-1111-1111-111111111111",
      ownerEmail: "alice@example.com",
    });
  });

  it("throws notFound for a diagram that does not exist or is owned by someone else", async () => {
    const { context } = contextFor({ selectRow: null });

    await expect(
      getDiagramTool(context, "11111111-1111-1111-1111-111111111111"),
    ).rejects.toMatchObject({ problemDetails: { status: 404 } });
  });
});

describe("createDiagramTool", () => {
  it("creates a diagram with caller-supplied fields and logs via mcp", async () => {
    const { context, logger } = contextFor({ selectRow: null });

    const diagram = await createDiagramTool(context, {
      description: "A test diagram",
      title: "My Diagram",
    });

    expect(diagram).toMatchObject({
      description: "A test diagram",
      ownerEmail: "alice@example.com",
      title: "My Diagram",
    });
    expect(logger.info).toHaveBeenCalledWith("diagram_created", {
      diagramId: diagram.id,
      via: "mcp",
    });
  });

  it("seeds the new diagram's graph from a known blueprint", async () => {
    const { context } = contextFor({ selectRow: null });

    const diagram = await createDiagramTool(context, {
      blueprintId: "api-gateway",
    });

    expect(JSON.parse(diagram.graphData).nodes.length).toBeGreaterThan(0);
  });

  it("throws notFound for an unknown blueprintId", async () => {
    const { context } = contextFor({ selectRow: null });

    await expect(
      createDiagramTool(context, { blueprintId: "does-not-exist" }),
    ).rejects.toMatchObject({ problemDetails: { status: 404 } });
  });

  it("rejects an invalid title via the same validation the REST route uses", async () => {
    const { context } = contextFor({ selectRow: null });

    await expect(
      createDiagramTool(context, { title: "x".repeat(256) }),
    ).rejects.toMatchObject({ problemDetails: { status: 422 } });
  });
});

describe("renameDiagramTool", () => {
  it("updates the diagram and logs via mcp", async () => {
    const { context, logger } = contextFor({
      selectRow: rowFor({ description: "old" }),
    });

    const diagram = await renameDiagramTool(
      context,
      "11111111-1111-1111-1111-111111111111",
      { title: "New Title" },
    );

    expect(diagram).toMatchObject({ description: "old", title: "New Title" });
    expect(logger.info).toHaveBeenCalledWith("diagram_updated", {
      diagramId: "11111111-1111-1111-1111-111111111111",
      kind: "metadata",
      via: "mcp",
    });
  });

  it("throws notFound for a diagram not owned by the caller", async () => {
    const { context } = contextFor({ selectRow: null });

    await expect(
      renameDiagramTool(context, "11111111-1111-1111-1111-111111111111", {
        title: "New Title",
      }),
    ).rejects.toMatchObject({ problemDetails: { status: 404 } });
  });

  it("rejects a body carrying neither title nor description", async () => {
    const { context } = contextFor({ selectRow: rowFor() });

    await expect(
      renameDiagramTool(context, "11111111-1111-1111-1111-111111111111", {}),
    ).rejects.toMatchObject({ problemDetails: { status: 422 } });
  });
});

describe("deleteDiagramTool", () => {
  it("deletes the diagram and revokes any active share links", async () => {
    const { context, statements } = contextFor({
      changes: 1,
      selectRows: [{ token_digest: "digest-1" }],
    });

    await deleteDiagramTool(context, "11111111-1111-1111-1111-111111111111");

    expect(
      statements.some((s) => s.sql.startsWith("DELETE FROM diagrams")),
    ).toBe(true);
    expect(
      statements.some((s) =>
        s.sql.includes("SELECT token_digest FROM diagram_shares"),
      ),
    ).toBe(true);
    expect(context.sharesKv.delete).toHaveBeenCalledWith("digest-1");
  });

  it("throws notFound and never touches shares when no row was deleted", async () => {
    const { context } = contextFor({ changes: 0 });

    await expect(
      deleteDiagramTool(context, "11111111-1111-1111-1111-111111111111"),
    ).rejects.toMatchObject({ problemDetails: { status: 404 } });
    expect(context.sharesKv.delete).not.toHaveBeenCalled();
  });
});

describe("graph-mutating tools", () => {
  const diagramId = "11111111-1111-1111-1111-111111111111";

  it("addNodeTool delegates to DiagramSession.applyOperation() with origin agent and returns its result", async () => {
    const { context, applyOperation } = contextFor({ selectRow: rowFor() });

    const diagram = await addNodeTool(context, diagramId, {
      label: "API",
      position: { x: 0, y: 0 },
      typeId: "worker",
    });

    expect(applyOperation).toHaveBeenCalledWith(
      {
        input: { label: "API", position: { x: 0, y: 0 }, typeId: "worker" },
        kind: "add_node",
      },
      "alice@example.com",
      "agent",
    );
    expect(diagram.graphData).toBe(
      '{"edges":[],"nodes":[{"id":"n-fixture"}],"viewport":{"x":0,"y":0,"zoom":1}}',
    );
    expect(diagram.updatedAt).toBe("2026-01-05T00:00:00.000Z");
  });

  it("addNodeTool throws notFound for a diagram not owned by the caller, never calling applyOperation", async () => {
    const { context, applyOperation } = contextFor({ selectRow: null });

    await expect(
      addNodeTool(context, diagramId, {
        label: "API",
        position: { x: 0, y: 0 },
        typeId: "worker",
      }),
    ).rejects.toMatchObject({ problemDetails: { status: 404 } });
    expect(applyOperation).not.toHaveBeenCalled();
  });

  it("addNodeTool propagates an error DiagramSession.applyOperation() itself throws", async () => {
    const { context, applyOperation } = contextFor({ selectRow: rowFor() });
    applyOperation.mockRejectedValueOnce(new Error("stale target"));

    await expect(
      addNodeTool(context, diagramId, {
        label: "API",
        position: { x: 0, y: 0 },
        typeId: "worker",
      }),
    ).rejects.toThrow("stale target");
  });

  it("updateNodeTool delegates the correct update_node operation", async () => {
    const { context, applyOperation } = contextFor({ selectRow: rowFor() });

    await updateNodeTool(context, diagramId, "n1", { label: "New" });

    expect(applyOperation).toHaveBeenCalledWith(
      { kind: "update_node", nodeId: "n1", patch: { label: "New" } },
      "alice@example.com",
      "agent",
    );
  });

  it("updateNodeTool throws notFound for a diagram not owned by the caller", async () => {
    const { context } = contextFor({ selectRow: null });

    await expect(
      updateNodeTool(context, diagramId, "does-not-exist", { label: "New" }),
    ).rejects.toMatchObject({ problemDetails: { status: 404 } });
  });

  it("removeNodeTool delegates the correct remove_node operation", async () => {
    const { context, applyOperation } = contextFor({ selectRow: rowFor() });

    await removeNodeTool(context, diagramId, "n1");

    expect(applyOperation).toHaveBeenCalledWith(
      { kind: "remove_node", nodeId: "n1" },
      "alice@example.com",
      "agent",
    );
  });

  it("addEdgeTool delegates the correct add_edge operation", async () => {
    const { context, applyOperation } = contextFor({ selectRow: rowFor() });

    await addEdgeTool(context, diagramId, {
      edgeType: "data-flow",
      source: "n1",
      target: "n2",
    });

    expect(applyOperation).toHaveBeenCalledWith(
      {
        input: { edgeType: "data-flow", source: "n1", target: "n2" },
        kind: "add_edge",
      },
      "alice@example.com",
      "agent",
    );
  });

  it("addEdgeTool throws notFound for a diagram not owned by the caller", async () => {
    const { context } = contextFor({ selectRow: null });

    await expect(
      addEdgeTool(context, diagramId, {
        edgeType: "data-flow",
        source: "does-not-exist",
        target: "n2",
      }),
    ).rejects.toMatchObject({ problemDetails: { status: 404 } });
  });

  it("updateEdgeTool delegates the correct update_edge operation", async () => {
    const { context, applyOperation } = contextFor({ selectRow: rowFor() });

    await updateEdgeTool(context, diagramId, "e1", { edgeType: "trigger" });

    expect(applyOperation).toHaveBeenCalledWith(
      { edgeId: "e1", kind: "update_edge", patch: { edgeType: "trigger" } },
      "alice@example.com",
      "agent",
    );
  });

  it("removeEdgeTool delegates the correct remove_edge operation", async () => {
    const { context, applyOperation } = contextFor({ selectRow: rowFor() });

    await removeEdgeTool(context, diagramId, "e1");

    expect(applyOperation).toHaveBeenCalledWith(
      { edgeId: "e1", kind: "remove_edge" },
      "alice@example.com",
      "agent",
    );
  });

  it("autoLayoutDiagramTool repositions every node deterministically and delegates to applyWholeGraphReplace with origin agent", async () => {
    const { context, applyWholeGraphReplace } = contextFor({
      selectRow: rowFor({
        graph_data: JSON.stringify({
          edges: [],
          nodes: [{ id: "n1" }, { id: "n2" }],
          viewport: { x: 0, y: 0, zoom: 1 },
        }),
      }),
    });

    const diagram = await autoLayoutDiagramTool(context, diagramId);

    expect(applyWholeGraphReplace).toHaveBeenCalledWith(
      diagram.graphData,
      "alice@example.com",
      "agent",
    );
    const positions = JSON.parse(diagram.graphData).nodes.map(
      (n: { position: { x: number; y: number } }) => n.position,
    );
    expect(positions).toHaveLength(2);
    expect(positions.every((p: { x: number; y: number }) => p.y === 0)).toBe(
      true,
    );
  });

  it("autoLayoutDiagramTool throws notFound for a diagram not owned by the caller", async () => {
    const { context, applyWholeGraphReplace } = contextFor({
      selectRow: null,
    });

    await expect(
      autoLayoutDiagramTool(context, diagramId),
    ).rejects.toMatchObject({ problemDetails: { status: 404 } });
    expect(applyWholeGraphReplace).not.toHaveBeenCalled();
  });
});

describe("createShareLinkTool", () => {
  const diagramId = "11111111-1111-1111-1111-111111111111";

  it("mints a share link and logs via mcp", async () => {
    const { context, logger } = contextFor({
      selectRow: rowFor(),
      shareSelectRow: null,
    });

    const share = await createShareLinkTool(context, diagramId);

    expect(share.token).toMatch(/^[\w-]{43}$/u);
    expect(share.url).toBe(`https://architect.example/s/${share.token}`);
    expect(logger.info).toHaveBeenCalledWith("diagram_shared", {
      diagramId,
      via: "mcp",
    });
  });

  it("throws notFound for a diagram not owned by the caller", async () => {
    const { context } = contextFor({ selectRow: null });

    await expect(createShareLinkTool(context, diagramId)).rejects.toMatchObject(
      { problemDetails: { status: 404 } },
    );
  });
});

describe("getShareStatusTool", () => {
  const diagramId = "11111111-1111-1111-1111-111111111111";

  it("reports no active share for a diagram with none", async () => {
    const { context } = contextFor({
      selectRow: rowFor(),
      shareSelectRow: null,
    });

    await expect(getShareStatusTool(context, diagramId)).resolves.toEqual({
      active: false,
      createdAt: null,
    });
  });

  it("reports an active share's creation timestamp", async () => {
    const { context } = contextFor({
      selectRow: rowFor(),
      shareSelectRow: { created_at: "2026-02-01T00:00:00.000Z" },
    });

    await expect(getShareStatusTool(context, diagramId)).resolves.toEqual({
      active: true,
      createdAt: "2026-02-01T00:00:00.000Z",
    });
  });

  it("throws notFound for a diagram not owned by the caller", async () => {
    const { context } = contextFor({ selectRow: null });

    await expect(getShareStatusTool(context, diagramId)).rejects.toMatchObject({
      problemDetails: { status: 404 },
    });
  });
});

describe("revokeShareLinkTool", () => {
  const diagramId = "11111111-1111-1111-1111-111111111111";

  it("revokes an active share and logs via mcp", async () => {
    const { context, logger } = contextFor({
      selectRow: rowFor(),
      shareSelectRow: { token_digest: "digest-1" },
    });

    await revokeShareLinkTool(context, diagramId);

    expect(context.sharesKv.delete).toHaveBeenCalledWith("digest-1");
    expect(logger.info).toHaveBeenCalledWith("diagram_share_revoked", {
      diagramId,
      via: "mcp",
    });
  });

  it("throws notFound when the diagram has no active share link", async () => {
    const { context } = contextFor({
      selectRow: rowFor(),
      shareSelectRow: null,
    });

    await expect(revokeShareLinkTool(context, diagramId)).rejects.toMatchObject(
      { problemDetails: { status: 404 } },
    );
  });

  it("throws notFound for a diagram not owned by the caller", async () => {
    const { context } = contextFor({ selectRow: null });

    await expect(revokeShareLinkTool(context, diagramId)).rejects.toMatchObject(
      { problemDetails: { status: 404 } },
    );
  });
});

describe("exportDiagramTool", () => {
  const diagramId = "11111111-1111-1111-1111-111111111111";

  it('returns the canonical graph JSON verbatim for format "json"', async () => {
    const row = rowFor();
    const { context } = contextFor({ selectRow: row });

    const exported = await exportDiagramTool(context, diagramId, "json");

    expect(exported).toEqual({
      data: row.graph_data,
      format: "json",
      mimeType: "application/json",
    });
  });

  it('returns a base64-encoded project scaffold ZIP for format "scaffold", reading each node/edge field defensively', async () => {
    const { context } = contextFor({
      selectRow: rowFor({
        graph_data: JSON.stringify({
          edges: [
            {
              data: { edgeType: "service-binding" },
              id: "e1",
              source: "n1",
              target: "n2",
            },
            // An edge missing `source`/`target`/`data.edgeType` altogether -- exercises the
            // `typeof ... === "string" ? ... : ...` fallback branches for a malformed edge a
            // caller could in principle hand this function.
            { id: "e2" },
          ],
          nodes: [
            {
              data: { label: "API", typeId: "worker" },
              id: "n1",
              position: { x: 0, y: 0 },
            },
            { id: "n2" },
          ],
          viewport: { x: 0, y: 0, zoom: 1 },
        }),
      }),
    });

    const exported = await exportDiagramTool(context, diagramId, "scaffold");

    expect(exported.format).toBe("scaffold");
    expect(exported.mimeType).toBe("application/zip");
    const zipBytes = Uint8Array.from(atob(exported.data), (char) =>
      char.charCodeAt(0),
    );
    const unzipped = unzipSync(zipBytes);
    expect(Object.keys(unzipped)).toContain("wrangler.toml");
  });

  it("throws notFound for a diagram not owned by the caller", async () => {
    const { context } = contextFor({ selectRow: null });

    await expect(
      exportDiagramTool(context, diagramId, "json"),
    ).rejects.toMatchObject({ problemDetails: { status: 404 } });
  });
});
