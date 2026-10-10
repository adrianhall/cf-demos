import { applyD1Migrations } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { JWT_HEADER, signDevJwt } from "@adrianhall/cloudflare-toolkit/testing";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";

/** Test-only Worker bindings injected by the integration Vitest project. */
interface TestEnv extends Env {
  /** Parsed D1 migrations that initialize Miniflare's otherwise empty D1 database. */
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

const ORIGIN = "https://architect.example";

/** One JSON-RPC 2.0 result payload, loosely typed for these assertions. */
interface JsonRpcEnvelope {
  jsonrpc: "2.0";
  id: number;
  result?: {
    content?: { type: "text"; text: string }[];
    isError?: boolean;
    tools?: { name: string }[];
  };
  error?: { code: number; message: string };
}

/**
 * Build an authenticated `POST /mcp` request carrying one JSON-RPC 2.0 call. An MCP client is
 * never a browser navigation (docs/09B-ARCHITECT-MCP.md's Access Model), so -- unlike
 * `diagrams.test.ts`'s `apiWrite()` -- this deliberately omits an `Origin` header: a real,
 * non-browser MCP harness (OpenCode) never sends one either, and `createMcpHandler`'s own Origin
 * validation already treats an absent Origin as valid for exactly this reason.
 */
async function mcpRequest(
  email: string | undefined,
  method: string,
  params: unknown,
): Promise<Request> {
  // The Streamable HTTP transport requires a client to accept both media types even when the
  // server ends up answering with plain JSON (`../../src/worker/routes/mcp.ts`'s
  // `responseMode: "json"`) -- omitting either one is answered with a `406`, not a JSON-RPC
  // error, before any tool logic runs.
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (email !== undefined) {
    headers[JWT_HEADER] = await signDevJwt(email);
  }
  return new Request(`${ORIGIN}/mcp`, {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
    headers,
    method: "POST",
  });
}

/** Dispatch a request through the configured Worker. */
async function request(requestValue: Request): Promise<Response> {
  return exports.default.fetch(requestValue);
}

/**
 * Parse a `createMcpHandler` response body into a typed JSON-RPC envelope.
 *
 * A hand-built request like this test file's carries no per-request `_meta` protocol envelope
 * (the modern 2026-07-28 wire format's own claim mechanism -- see
 * `spikes/07-architect-mcp-spike/REPORT.md`'s protocol-version note), so `createMcpHandler`
 * classifies it as a legacy (2025-era) request and always answers over the legacy compatibility
 * lane's `text/event-stream` transport, regardless of `../../src/worker/routes/mcp.ts`'s own
 * `responseMode: "json"` option -- that option only ever applies to the modern lane. A real MCP
 * client SDK (OpenCode's included) sends the modern envelope automatically and gets a plain JSON
 * response back instead; this helper parses whichever shape this test's own bare-JSON-RPC
 * request actually receives.
 */
async function jsonRpcBody(response: Response): Promise<JsonRpcEnvelope> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (contentType.includes("application/json")) {
    return JSON.parse(text);
  }
  expect(contentType).toContain("text/event-stream");
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (dataLine === undefined) {
    throw new Error(`No SSE "data:" line found in response body:\n${text}`);
  }
  return JSON.parse(dataLine.slice("data: ".length));
}

describe("POST /mcp", () => {
  beforeAll(async () => {
    const testEnv = env as TestEnv;
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  it("rejects an unauthenticated request with a Problem Details 401", async () => {
    const response = await request(
      await mcpRequest(undefined, "tools/list", {}),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("lists every tool from the Remote MCP Tool Catalog", async () => {
    const response = await request(
      await mcpRequest("alice@example.com", "tools/list", {}),
    );

    const body = await jsonRpcBody(response);
    expect(body.result?.tools?.map((tool) => tool.name).sort()).toEqual([
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

  it("creates a diagram scoped to the caller and lists only that caller's own diagrams", async () => {
    const createResponse = await request(
      await mcpRequest("bob@example.com", "tools/call", {
        arguments: { title: "Bob's Diagram" },
        name: "create_diagram",
      }),
    );
    const created = await jsonRpcBody(createResponse);
    expect(created.result?.isError).not.toBe(true);
    const diagram = JSON.parse(created.result?.content?.[0]?.text ?? "{}");
    expect(diagram).toMatchObject({
      ownerEmail: "bob@example.com",
      title: "Bob's Diagram",
    });

    const listResponse = await request(
      await mcpRequest("bob@example.com", "tools/call", {
        arguments: {},
        name: "list_diagrams",
      }),
    );
    const listed = await jsonRpcBody(listResponse);
    const diagrams = JSON.parse(listed.result?.content?.[0]?.text ?? "[]");
    expect(diagrams.every((entry: { id: string }) => entry.id)).toBe(true);
    expect(
      diagrams.some(
        (entry: { title: string }) => entry.title === "Bob's Diagram",
      ),
    ).toBe(true);

    // A different identity's own list must never include it.
    const eveListResponse = await request(
      await mcpRequest("eve@example.com", "tools/call", {
        arguments: {},
        name: "list_diagrams",
      }),
    );
    const eveListed = await jsonRpcBody(eveListResponse);
    const eveDiagrams = JSON.parse(
      eveListed.result?.content?.[0]?.text ?? "[]",
    );
    expect(
      eveDiagrams.some((entry: { id: string }) => entry.id === diagram.id),
    ).toBe(false);
  });

  it("reports a different identity's diagram as a tool-level not-found, never forbidden", async () => {
    const createResponse = await request(
      await mcpRequest("carol@example.com", "tools/call", {
        arguments: { title: "Carol's Diagram" },
        name: "create_diagram",
      }),
    );
    const created = await jsonRpcBody(createResponse);
    const diagram = JSON.parse(created.result?.content?.[0]?.text ?? "{}");

    const response = await request(
      await mcpRequest("mallory@example.com", "tools/call", {
        arguments: { diagramId: diagram.id },
        name: "get_diagram",
      }),
    );

    const body = await jsonRpcBody(response);
    expect(response.status).toBe(200);
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toBe("Diagram not found.");
  });

  /** Call one MCP tool and return its parsed JSON-RPC result -- a thin convenience wrapper
   * shared by every sharing/export test below. */
  async function callTool(
    email: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<JsonRpcEnvelope> {
    return jsonRpcBody(
      await request(
        await mcpRequest(email, "tools/call", { arguments: args, name }),
      ),
    );
  }

  /** Create a diagram owned by `email` via the `create_diagram` tool and return its id. */
  async function createDiagram(email: string, title: string): Promise<string> {
    const created = await callTool(email, "create_diagram", { title });
    const diagram = JSON.parse(created.result?.content?.[0]?.text ?? "{}");
    return diagram.id as string;
  }

  describe("sharing tools (Phase 14)", () => {
    it("mints a share link, reports it active, then revokes it -- matching the REST routes' shape", async () => {
      const owner = "share-mcp-owner-1@example.com";
      const diagramId = await createDiagram(owner, "MCP Shared Diagram");

      const noShareStatus = await callTool(owner, "get_share_status", {
        diagramId,
      });
      expect(
        JSON.parse(noShareStatus.result?.content?.[0]?.text ?? "{}"),
      ).toEqual({ active: false, createdAt: null });

      const createShare = await callTool(owner, "create_share_link", {
        diagramId,
      });
      expect(createShare.result?.isError).not.toBe(true);
      const share = JSON.parse(createShare.result?.content?.[0]?.text ?? "{}");
      expect(share.token).toMatch(/^[\w-]{43}$/u);
      expect(share.url).toBe(`${ORIGIN}/s/${share.token}`);

      // The token this MCP tool minted resolves through the exact same public REST resolver a
      // browser share link uses -- both write through the same `ShareRepository`.
      const publicResponse = await request(
        new Request(`${ORIGIN}/api/share/${share.token}`),
      );
      expect(publicResponse.status).toBe(200);
      const { diagram: publicDiagram } = (await publicResponse.json()) as {
        diagram: Record<string, unknown>;
      };
      expect(publicDiagram).toMatchObject({
        id: diagramId,
        title: "MCP Shared Diagram",
      });
      expect(publicDiagram).not.toHaveProperty("ownerEmail");

      const activeStatus = await callTool(owner, "get_share_status", {
        diagramId,
      });
      expect(
        JSON.parse(activeStatus.result?.content?.[0]?.text ?? "{}"),
      ).toMatchObject({ active: true });

      const revoke = await callTool(owner, "revoke_share_link", {
        diagramId,
      });
      expect(revoke.result?.isError).not.toBe(true);

      const afterRevokeStatus = await callTool(owner, "get_share_status", {
        diagramId,
      });
      expect(
        JSON.parse(afterRevokeStatus.result?.content?.[0]?.text ?? "{}"),
      ).toEqual({ active: false, createdAt: null });

      // A revoked token stops resolving through the public REST resolver too.
      const revokedResponse = await request(
        new Request(`${ORIGIN}/api/share/${share.token}`),
      );
      expect(revokedResponse.status).toBe(404);
    });

    it("reports not-found revoking a diagram with no active share, matching the REST route's 404 posture", async () => {
      const owner = "share-mcp-owner-2@example.com";
      const diagramId = await createDiagram(owner, "No Share Yet");

      const revoke = await callTool(owner, "revoke_share_link", {
        diagramId,
      });

      expect(revoke.result?.isError).toBe(true);
      expect(revoke.result?.content?.[0]?.text).toBe(
        "No active share link for this diagram.",
      );
    });

    it("reports every sharing tool as a not-found, never forbidden, for a diagram the caller does not own", async () => {
      const owner = "share-mcp-owner-3@example.com";
      const diagramId = await createDiagram(owner, "Someone Else's Diagram");
      const intruder = "mallory@example.com";

      const status = await callTool(intruder, "get_share_status", {
        diagramId,
      });
      expect(status.result?.isError).toBe(true);
      expect(status.result?.content?.[0]?.text).toBe("Diagram not found.");

      const create = await callTool(intruder, "create_share_link", {
        diagramId,
      });
      expect(create.result?.isError).toBe(true);
      expect(create.result?.content?.[0]?.text).toBe("Diagram not found.");

      const revoke = await callTool(intruder, "revoke_share_link", {
        diagramId,
      });
      expect(revoke.result?.isError).toBe(true);
      expect(revoke.result?.content?.[0]?.text).toBe("Diagram not found.");
    });

    it("reports every sharing tool as a not-found for a nonexistent diagram id", async () => {
      const nonexistentId = "00000000-0000-0000-0000-000000000000";

      const status = await callTool(
        "share-mcp-owner-4@example.com",
        "get_share_status",
        { diagramId: nonexistentId },
      );
      expect(status.result?.isError).toBe(true);
      expect(status.result?.content?.[0]?.text).toBe("Diagram not found.");
    });
  });

  describe("export_diagram tool (Phase 14)", () => {
    it('exports the canonical graph JSON verbatim for format "json"', async () => {
      const owner = "export-mcp-owner-1@example.com";
      const diagramId = await createDiagram(owner, "Export JSON Diagram");

      const result = await callTool(owner, "export_diagram", {
        diagramId,
        format: "json",
      });

      expect(result.result?.isError).not.toBe(true);
      const graph = JSON.parse(result.result?.content?.[0]?.text ?? "{}");
      expect(graph).toEqual({
        edges: [],
        nodes: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      });
    });

    it('exports a downloadable project scaffold ZIP for format "scaffold", reflecting the diagram\'s own nodes', async () => {
      const owner = "export-mcp-owner-2@example.com";
      const diagramId = await createDiagram(owner, "Export Scaffold Diagram");

      const addNode = await callTool(owner, "add_node", {
        diagramId,
        label: "Database",
        position: { x: 0, y: 0 },
        typeId: "d1",
      });
      expect(addNode.result?.isError).not.toBe(true);

      const result = await callTool(owner, "export_diagram", {
        diagramId,
        format: "scaffold",
      });

      expect(result.result?.isError).not.toBe(true);
      const [entry] = (result.result?.content ?? []) as unknown as {
        type: "resource";
        resource: { uri: string; mimeType: string; blob: string };
      }[];
      expect(entry.resource.mimeType).toBe("application/zip");
      expect(entry.resource.uri).toBe(
        `architect://diagrams/${diagramId}/scaffold.zip`,
      );

      const zipBytes = Uint8Array.from(atob(entry.resource.blob), (char) =>
        char.charCodeAt(0),
      );
      const files = unzipSync(zipBytes);
      expect(Object.keys(files)).toContain("wrangler.toml");
      const wranglerToml = strFromU8(files["wrangler.toml"] as Uint8Array);
      expect(wranglerToml).toContain("[[d1_databases]]");
      expect(wranglerToml).toContain('binding = "DATABASE"');
    });

    it("reports not-found exporting a diagram the caller does not own, never forbidden", async () => {
      const owner = "export-mcp-owner-3@example.com";
      const diagramId = await createDiagram(owner, "Private Diagram");

      const result = await callTool("mallory@example.com", "export_diagram", {
        diagramId,
        format: "json",
      });

      expect(result.result?.isError).toBe(true);
      expect(result.result?.content?.[0]?.text).toBe("Diagram not found.");
    });

    it("reports not-found exporting a nonexistent diagram id", async () => {
      const result = await callTool(
        "export-mcp-owner-4@example.com",
        "export_diagram",
        { diagramId: "00000000-0000-0000-0000-000000000000", format: "json" },
      );

      expect(result.result?.isError).toBe(true);
      expect(result.result?.content?.[0]?.text).toBe("Diagram not found.");
    });
  });
});
