import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyGraphOperation,
  type GraphOperation,
} from "../../graph-mutations";
import type { GraphData } from "../diagrams/types";
import { createServer } from "./server";
import type { McpToolContext } from "./tools";

/** A recorded D1 statement, mirroring `./tools.test.ts`'s own fixture shape. */
interface RecordedStatement {
  parameters: unknown[];
  sql: string;
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

/**
 * Build a `McpToolContext` backed by fixture doubles, exactly like `./tools.test.ts`.
 *
 * @param selectRow Row `first()` resolves with for `diagrams` table `SELECT`s -- `findOwned()`.
 * @param selectRows Rows `all()` resolves with -- `listOwned()`/`revokeAllForDiagram()`.
 * @param shareSelectRow Row `first()` resolves with for `diagram_shares` table `SELECT`s --
 * `ShareRepository`'s `getStatus()`/`revokeActive()` (via `rotate()`), routed separately from
 * `selectRow` by table name, exactly like `./tools.test.ts`'s own `contextFor()`.
 */
function contextFor(
  selectRow: Record<string, unknown> | null,
  selectRows: Record<string, unknown>[] = [],
  shareSelectRow: Record<string, unknown> | null = null,
): {
  context: McpToolContext;
  statements: RecordedStatement[];
  applyOperation: ReturnType<typeof vi.fn>;
  applyWholeGraphReplace: ReturnType<typeof vi.fn>;
  sharesKvDelete: ReturnType<typeof vi.fn>;
} {
  const statements: RecordedStatement[] = [];
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
          results: selectRows as T[],
          success: true as const,
        }),
        bind(...parameters: unknown[]) {
          record.parameters = parameters;
          return statement;
        },
        first: async <T>() =>
          (sql.includes("FROM diagram_shares")
            ? shareSelectRow
            : selectRow) as T | null,
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
  };

  // Simulates `DiagramSession.applyOperation()` against this fixture's own `graph_data` --
  // rather than a fixed canned result -- so this file's end-to-end assertions (deep graph
  // inspection through the real MCP SDK layer, including a `notFound()` propagating as a
  // tool-level error) stay meaningful without a real Durable Object. Uses the exact same
  // `applyGraphOperation()` dispatcher the real `DiagramSession` calls, so this is not a second,
  // divergent mutation implementation.
  const applyOperation = vi.fn(async (op: GraphOperation) => {
    const graph = JSON.parse(
      (selectRow?.graph_data as string | undefined) ??
        '{"edges":[],"nodes":[],"viewport":{"x":0,"y":0,"zoom":1}}',
    ) as GraphData;
    const mutated = applyGraphOperation(graph, op);
    return {
      graphData: JSON.stringify(mutated),
      sequence: 1,
      updatedAt: "2026-01-05T00:00:00.000Z",
    };
  });
  const applyWholeGraphReplace = vi.fn(async () => ({
    sequence: 1,
    updatedAt: "2026-01-05T00:00:00.000Z",
  }));
  const sharesKvDelete = vi.fn();

  return {
    context: {
      db,
      // The RPC stub's own return type mixes in `Disposable`/`Provider` machinery
      // (`@cloudflare/workers-types`' `Rpc` namespace) a plain fixture function's `Promise<T>`
      // can never structurally satisfy -- cast through `unknown`, exactly like `./tools.test.ts`'s
      // own `contextFor()`.
      getDiagramSession: () =>
        ({ applyOperation, applyWholeGraphReplace }) as unknown as ReturnType<
          McpToolContext["getDiagramSession"]
        >,
      logger: { info: vi.fn() },
      ownerEmail: "alice@example.com",
      requestUrl: "https://architect.example/mcp",
      sharesKv: { delete: sharesKvDelete, get: vi.fn(), put: vi.fn() },
    },
    statements,
    applyOperation,
    applyWholeGraphReplace,
    sharesKvDelete,
  };
}

/**
 * Connect a real MCP `Client` to `createServer()`'s output over an in-memory transport pair --
 * this exercises the actual tool/resource wiring (names, zod input schemas, response shape)
 * end to end, unlike `./tools.test.ts`'s direct function calls, which never touch the MCP SDK
 * layer at all.
 */
async function connectedClient(
  context: McpToolContext,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createServer(context);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("createServer", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("registers every read/metadata/graph-mutation tool from the Remote MCP Tool Catalog", async () => {
    const { context } = contextFor(null);
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_edge",
      "add_node",
      "auto_layout_diagram",
      "create_diagram",
      "create_share_link",
      "delete_diagram",
      "export_diagram",
      "get_diagram",
      "get_share_status",
      "list_diagrams",
      "remove_edge",
      "remove_node",
      "rename_diagram",
      "revoke_share_link",
      "update_edge",
      "update_node",
    ]);
  });

  it("calls list_diagrams end to end through the MCP protocol", async () => {
    const { context } = contextFor(null, [rowFor()]);
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: {},
      name: "list_diagrams",
    });

    expect(result.isError).not.toBe(true);
    const [content] = result.content as { type: "text"; text: string }[];
    expect(JSON.parse(content?.text ?? "[]")).toHaveLength(1);
  });

  it("calls get_diagram end to end for a diagram owned by the caller", async () => {
    const { context } = contextFor(rowFor());
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: { diagramId: "11111111-1111-1111-1111-111111111111" },
      name: "get_diagram",
    });

    expect(result.isError).not.toBe(true);
    const [content] = result.content as { type: "text"; text: string }[];
    expect(JSON.parse(content?.text ?? "{}")).toMatchObject({
      id: "11111111-1111-1111-1111-111111111111",
    });
  });

  it("reports a not-found tool error, not a protocol error, for a missing diagram", async () => {
    const { context } = contextFor(null);
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: { diagramId: "11111111-1111-1111-1111-111111111111" },
      name: "get_diagram",
    });

    expect(result.isError).toBe(true);
    const [content] = result.content as { type: "text"; text: string }[];
    expect(content?.text).toBe("Diagram not found.");
  });

  it("creates a diagram end to end through the MCP protocol", async () => {
    const { context } = contextFor(null);
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: { title: "My Diagram" },
      name: "create_diagram",
    });

    expect(result.isError).not.toBe(true);
    const [content] = result.content as { type: "text"; text: string }[];
    expect(JSON.parse(content?.text ?? "{}")).toMatchObject({
      title: "My Diagram",
    });
  });

  it("renames a diagram end to end through the MCP protocol", async () => {
    const { context } = contextFor(rowFor());
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: {
        diagramId: "11111111-1111-1111-1111-111111111111",
        title: "Renamed",
      },
      name: "rename_diagram",
    });

    expect(result.isError).not.toBe(true);
    const [content] = result.content as { type: "text"; text: string }[];
    expect(JSON.parse(content?.text ?? "{}")).toMatchObject({
      title: "Renamed",
    });
  });

  it("deletes a diagram end to end through the MCP protocol", async () => {
    const { context } = contextFor(null);
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: { diagramId: "11111111-1111-1111-1111-111111111111" },
      name: "delete_diagram",
    });

    expect(result.isError).not.toBe(true);
    const [content] = result.content as { type: "text"; text: string }[];
    expect(content?.text).toBe(
      "Diagram 11111111-1111-1111-1111-111111111111 deleted.",
    );
  });

  it("reads the architect://diagrams/{id} resource by exact URI", async () => {
    const { context } = contextFor(rowFor());
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.readResource({
      uri: "architect://diagrams/11111111-1111-1111-1111-111111111111",
    });

    const [entry] = result.contents;
    expect(entry?.mimeType).toBe("application/json");
    expect("text" in (entry ?? {})).toBe(true);
    expect(JSON.parse((entry as { text: string }).text)).toMatchObject({
      id: "11111111-1111-1111-1111-111111111111",
    });
  });

  it("adds a node end to end via DiagramSession.applyOperation()", async () => {
    const { context, applyOperation } = contextFor(rowFor());
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: {
        diagramId: "11111111-1111-1111-1111-111111111111",
        label: "API",
        position: { x: 0, y: 0 },
        typeId: "worker",
      },
      name: "add_node",
    });

    expect(result.isError).not.toBe(true);
    const [content] = result.content as { type: "text"; text: string }[];
    const diagram = JSON.parse(content?.text ?? "{}");
    expect(applyOperation).toHaveBeenCalledWith(
      {
        input: {
          label: "API",
          position: { x: 0, y: 0 },
          typeId: "worker",
        },
        kind: "add_node",
      },
      "alice@example.com",
      "agent",
    );
    expect(JSON.parse(diagram.graphData).nodes).toHaveLength(1);
    expect(JSON.parse(diagram.graphData).nodes[0].data.label).toBe("API");
  });

  it("adds an edge between two existing nodes end to end", async () => {
    const { context } = contextFor(
      rowFor({
        graph_data: JSON.stringify({
          edges: [],
          nodes: [{ id: "a" }, { id: "b" }],
          viewport: { x: 0, y: 0, zoom: 1 },
        }),
      }),
    );
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: {
        diagramId: "11111111-1111-1111-1111-111111111111",
        edgeType: "data-flow",
        source: "a",
        target: "b",
      },
      name: "add_edge",
    });

    expect(result.isError).not.toBe(true);
    const [content] = result.content as { type: "text"; text: string }[];
    const diagram = JSON.parse(content?.text ?? "{}");
    expect(JSON.parse(diagram.graphData).edges).toMatchObject([
      { source: "a", target: "b" },
    ]);
  });

  it("updates a node's label end to end", async () => {
    const { context } = contextFor(
      rowFor({
        graph_data: JSON.stringify({
          edges: [],
          nodes: [{ data: { label: "Old" }, id: "n1" }],
          viewport: { x: 0, y: 0, zoom: 1 },
        }),
      }),
    );
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: {
        diagramId: "11111111-1111-1111-1111-111111111111",
        label: "New",
        nodeId: "n1",
      },
      name: "update_node",
    });

    expect(result.isError).not.toBe(true);
    const [content] = result.content as { type: "text"; text: string }[];
    const diagram = JSON.parse(content?.text ?? "{}");
    expect(JSON.parse(diagram.graphData).nodes[0].data.label).toBe("New");
  });

  it("removes a node end to end", async () => {
    const { context } = contextFor(
      rowFor({
        graph_data: JSON.stringify({
          edges: [],
          nodes: [{ id: "n1" }, { id: "n2" }],
          viewport: { x: 0, y: 0, zoom: 1 },
        }),
      }),
    );
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: {
        diagramId: "11111111-1111-1111-1111-111111111111",
        nodeId: "n1",
      },
      name: "remove_node",
    });

    expect(result.isError).not.toBe(true);
    const [content] = result.content as { type: "text"; text: string }[];
    const diagram = JSON.parse(content?.text ?? "{}");
    expect(
      JSON.parse(diagram.graphData).nodes.map((n: { id: string }) => n.id),
    ).toEqual(["n2"]);
  });

  it("updates an edge's type end to end", async () => {
    const { context } = contextFor(
      rowFor({
        graph_data: JSON.stringify({
          edges: [
            {
              data: { edgeType: "data-flow" },
              id: "e1",
              source: "n1",
              target: "n2",
            },
          ],
          nodes: [{ id: "n1" }, { id: "n2" }],
          viewport: { x: 0, y: 0, zoom: 1 },
        }),
      }),
    );
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: {
        diagramId: "11111111-1111-1111-1111-111111111111",
        edgeId: "e1",
        edgeType: "trigger",
      },
      name: "update_edge",
    });

    expect(result.isError).not.toBe(true);
    const [content] = result.content as { type: "text"; text: string }[];
    const diagram = JSON.parse(content?.text ?? "{}");
    expect(JSON.parse(diagram.graphData).edges[0].data.edgeType).toBe(
      "trigger",
    );
  });

  it("removes an edge end to end", async () => {
    const { context } = contextFor(
      rowFor({
        graph_data: JSON.stringify({
          edges: [
            {
              data: { edgeType: "data-flow" },
              id: "e1",
              source: "n1",
              target: "n2",
            },
          ],
          nodes: [{ id: "n1" }, { id: "n2" }],
          viewport: { x: 0, y: 0, zoom: 1 },
        }),
      }),
    );
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: {
        diagramId: "11111111-1111-1111-1111-111111111111",
        edgeId: "e1",
      },
      name: "remove_edge",
    });

    expect(result.isError).not.toBe(true);
    const [content] = result.content as { type: "text"; text: string }[];
    const diagram = JSON.parse(content?.text ?? "{}");
    expect(JSON.parse(diagram.graphData).edges).toHaveLength(0);
  });

  it("reports an unknown node id as a tool-level not-found for remove_node", async () => {
    const { context } = contextFor(rowFor());
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: {
        diagramId: "11111111-1111-1111-1111-111111111111",
        nodeId: "does-not-exist",
      },
      name: "remove_node",
    });

    expect(result.isError).toBe(true);
  });

  it("auto-layouts a diagram's nodes end to end", async () => {
    const { context } = contextFor(
      rowFor({
        graph_data: JSON.stringify({
          edges: [],
          nodes: [{ id: "a" }, { id: "b" }],
          viewport: { x: 0, y: 0, zoom: 1 },
        }),
      }),
    );
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: { diagramId: "11111111-1111-1111-1111-111111111111" },
      name: "auto_layout_diagram",
    });

    expect(result.isError).not.toBe(true);
    const [content] = result.content as { type: "text"; text: string }[];
    const diagram = JSON.parse(content?.text ?? "{}");
    const positions = JSON.parse(diagram.graphData).nodes.map(
      (node: { position: { x: number; y: number } }) => node.position,
    );
    expect(positions).toHaveLength(2);
  });

  it("creates a share link end to end and returns an absolute url", async () => {
    const { context } = contextFor(rowFor(), [], null);
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: { diagramId: "11111111-1111-1111-1111-111111111111" },
      name: "create_share_link",
    });

    expect(result.isError).not.toBe(true);
    const [content] = result.content as { type: "text"; text: string }[];
    const share = JSON.parse(content?.text ?? "{}");
    expect(share.token).toMatch(/^[\w-]{43}$/u);
    expect(share.url).toBe(`https://architect.example/s/${share.token}`);
  });

  it("reports a tool-level not-found creating a share link for someone else's diagram", async () => {
    const { context } = contextFor(null);
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: { diagramId: "11111111-1111-1111-1111-111111111111" },
      name: "create_share_link",
    });

    expect(result.isError).toBe(true);
    const [content] = result.content as { type: "text"; text: string }[];
    expect(content?.text).toBe("Diagram not found.");
  });

  it("reports share status end to end", async () => {
    const { context } = contextFor(rowFor(), [], {
      created_at: "2026-02-01T00:00:00.000Z",
    });
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: { diagramId: "11111111-1111-1111-1111-111111111111" },
      name: "get_share_status",
    });

    expect(result.isError).not.toBe(true);
    const [content] = result.content as { type: "text"; text: string }[];
    expect(JSON.parse(content?.text ?? "{}")).toEqual({
      active: true,
      createdAt: "2026-02-01T00:00:00.000Z",
    });
  });

  it("revokes a share link end to end", async () => {
    const { context, sharesKvDelete } = contextFor(rowFor(), [], {
      token_digest: "digest-1",
    });
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: { diagramId: "11111111-1111-1111-1111-111111111111" },
      name: "revoke_share_link",
    });

    expect(result.isError).not.toBe(true);
    expect(sharesKvDelete).toHaveBeenCalledWith("digest-1");
  });

  it("reports a tool-level not-found revoking a diagram with no active share", async () => {
    const { context } = contextFor(rowFor(), [], null);
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: { diagramId: "11111111-1111-1111-1111-111111111111" },
      name: "revoke_share_link",
    });

    expect(result.isError).toBe(true);
    const [content] = result.content as { type: "text"; text: string }[];
    expect(content?.text).toBe("No active share link for this diagram.");
  });

  it('exports a diagram as "json" as a text content block', async () => {
    const row = rowFor();
    const { context } = contextFor(row);
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: {
        diagramId: "11111111-1111-1111-1111-111111111111",
        format: "json",
      },
      name: "export_diagram",
    });

    expect(result.isError).not.toBe(true);
    const [content] = result.content as { type: "text"; text: string }[];
    expect(content?.text).toBe(row.graph_data);
  });

  it('exports a diagram as "scaffold" as a base64 resource content block', async () => {
    const { context } = contextFor(
      rowFor({
        graph_data: JSON.stringify({
          edges: [],
          nodes: [
            {
              data: { label: "API", typeId: "worker" },
              id: "n1",
              position: { x: 0, y: 0 },
            },
          ],
          viewport: { x: 0, y: 0, zoom: 1 },
        }),
      }),
    );
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: {
        diagramId: "11111111-1111-1111-1111-111111111111",
        format: "scaffold",
      },
      name: "export_diagram",
    });

    expect(result.isError).not.toBe(true);
    const [entry] = result.content as {
      type: "resource";
      resource: { uri: string; mimeType: string; blob: string };
    }[];
    expect(entry?.resource.mimeType).toBe("application/zip");
    expect(entry?.resource.uri).toBe(
      "architect://diagrams/11111111-1111-1111-1111-111111111111/scaffold.zip",
    );
    const zipBytes = Uint8Array.from(atob(entry?.resource.blob ?? ""), (char) =>
      char.charCodeAt(0),
    );
    expect(Object.keys(unzipSync(zipBytes))).toContain("wrangler.toml");
  });

  it("reports a tool-level not-found exporting someone else's diagram", async () => {
    const { context } = contextFor(null);
    const { client, close } = await connectedClient(context);
    cleanup = close;

    const result = await client.callTool({
      arguments: {
        diagramId: "11111111-1111-1111-1111-111111111111",
        format: "json",
      },
      name: "export_diagram",
    });

    expect(result.isError).toBe(true);
    const [content] = result.content as { type: "text"; text: string }[];
    expect(content?.text).toBe("Diagram not found.");
  });
});
