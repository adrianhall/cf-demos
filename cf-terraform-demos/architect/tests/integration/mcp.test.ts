import { applyD1Migrations } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';

/**
 * @file The remote MCP endpoint through the real Workers runtime. The unit suite covers each tool
 *   over in-memory ports; this file proves the important joins no unit test can see: Access runs
 *   before MCP, the same-origin middleware lets a non-browser caller through, the module-scope
 *   handler scopes a tool closure to the request's verified identity, and D1 receives the same
 *   ownership-enforcing service calls as the browser API.
 */

/**
 * Test-only bindings injected by the integration Vitest project.
 */
interface TestEnv extends Env {
  /**
   * Parsed migrations used to build the otherwise empty Miniflare D1 database.
   */
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/**
 * Audience the Worker accepts, matching the integration project's bindings.
 */
const AUD = 'a'.repeat(64);

/**
 * Fictional origin: never a live deployment, so this suite cannot touch an account resource.
 */
const ORIGIN = 'https://diagrams.test';

/**
 * Host header the MCP handler's DNS-rebinding defence admits in this project.
 */
const HOST = 'diagrams.test';

/**
 * One ordinary owner.
 */
const ALICE = 'alice@example.com';

/**
 * A different ordinary owner, used to prove non-enumerating isolation.
 */
const MALLORY = 'mallory@example.com';

/**
 * Modern MCP's per-request envelope. `agents@0.27.0` wraps the v2 SDK, whose modern path requires
 * both of these fields and also cross-checks the two `Mcp-*` headers below. Keeping the fixture
 * literal here makes the protocol contract visible rather than hiding it behind a client library.
 */
const MCP_ENVELOPE = {
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/protocolVersion': '2026-07-28'
};

/**
 * Parsed D1 binding for the test runtime.
 */
const testEnv = env as TestEnv;

/**
 * Builds one modern JSON-RPC MCP request.
 *
 * It deliberately sets no `Origin` or `Sec-Fetch-Site` header. A real MCP client is not a browser
 * and sends neither; reaching a tool therefore proves `enforceSameOriginJson`'s documented `/mcp`
 * carve-out rather than accidentally exercising the browser path.
 *
 * @param method JSON-RPC method to invoke.
 * @param params Method parameters before the required modern envelope is added.
 * @param token Optional verified development Access JWT. Omit it for Access refusal assertions.
 * @returns A request ready to dispatch through the Worker.
 */
function mcpRequest(method: string, params: Record<string, unknown>, token?: string): Request {
  const name =
    typeof params.name === 'string'
      ? params.name
      : typeof params.uri === 'string'
        ? params.uri
        : undefined;

  return new Request(`${ORIGIN}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method,
      params: { ...params, _meta: MCP_ENVELOPE }
    }),
    headers: {
      'accept': 'application/json, text/event-stream',
      'content-type': 'application/json',
      'host': HOST,
      'mcp-method': method,
      ...(name === undefined ? {} : { 'mcp-name': name }),
      ...(token === undefined ? {} : { [JWT_HEADER]: token })
    },
    method: 'POST'
  });
}

/**
 * Builds an MCP request authenticated as one development identity.
 *
 * @param email Identity to sign the development JWT for.
 * @param method JSON-RPC method to invoke.
 * @param params Method parameters before the required modern envelope is added.
 * @returns An authenticated non-browser MCP request.
 */
async function mcpRequestAs(
  email: string,
  method: string,
  params: Record<string, unknown>
): Promise<Request> {
  return mcpRequest(method, params, await signDevJwt(email, { audience: AUD }));
}

/**
 * Dispatches a request through the Worker under test.
 *
 * @param request Request to dispatch.
 * @returns The Worker's response.
 */
async function send(request: Request): Promise<Response> {
  return exports.default.fetch(request);
}

/**
 * Calls one MCP tool and extracts its JSON-RPC response.
 *
 * @param email Verified identity making the tool call.
 * @param name Registered tool name.
 * @param args Tool arguments.
 * @returns The status and parsed JSON-RPC payload.
 */
async function callTool(
  email: string,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ body: Record<string, unknown>; status: number }> {
  const response = await send(await mcpRequestAs(email, 'tools/call', { arguments: args, name }));

  return { body: (await response.json()) as Record<string, unknown>, status: response.status };
}

/**
 * Reads the first text content block from a successful `tools/call` payload.
 *
 * @param body Parsed JSON-RPC response payload.
 * @returns The text the registered tool returned.
 * @throws {Error} When the response is not a successful text-bearing tool result, so a later test
 *   fails at the call that produced the malformed result rather than at an unrelated parse.
 */
function toolText(body: Record<string, unknown>): string {
  const result = body.result;
  if (typeof result !== 'object' || result === null || !('content' in result)) {
    throw new Error(`Expected an MCP tool result, received ${JSON.stringify(body)}.`);
  }

  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error(`Expected MCP tool content, received ${JSON.stringify(body)}.`);
  }

  const first = content[0];
  if (
    typeof first !== 'object'
    || first === null
    || !('text' in first)
    || typeof first.text !== 'string'
  ) {
    throw new Error(`Expected MCP text content, received ${JSON.stringify(body)}.`);
  }

  return first.text;
}

/**
 * Reads the first resource content block from a successful `tools/call` payload.
 *
 * Separate from {@link toolText} because a binary export is returned as a resource block rather than
 * as text — a client that understands the block can offer to save it as a file instead of printing
 * base64 into a transcript.
 *
 * @param body Parsed JSON-RPC response payload.
 * @returns The block's base64 payload, MIME type and URI.
 * @throws {Error} When the response carries no resource block, so a later assertion fails at the
 *   call that produced the malformed result rather than at an unrelated decode.
 */
function toolResource(body: Record<string, unknown>): {
  blob: string;
  mimeType: string;
  uri: string;
} {
  const result = body.result;
  if (typeof result !== 'object' || result === null || !('content' in result)) {
    throw new Error(`Expected an MCP tool result, received ${JSON.stringify(body)}.`);
  }

  const content = result.content;
  const first = Array.isArray(content) ? content[0] : undefined;
  if (typeof first !== 'object' || first === null || !('resource' in first)) {
    throw new Error(`Expected an MCP resource block, received ${JSON.stringify(body)}.`);
  }

  const resource = first.resource as { blob?: unknown; mimeType?: unknown; uri?: unknown };
  if (
    typeof resource.blob !== 'string'
    || typeof resource.mimeType !== 'string'
    || typeof resource.uri !== 'string'
  ) {
    throw new Error(`Expected a base64 resource block, received ${JSON.stringify(body)}.`);
  }

  return { blob: resource.blob, mimeType: resource.mimeType, uri: resource.uri };
}

/**
 * Creates a diagram owned by one identity and replaces its graph through the REST autosave path.
 *
 * Seeded over HTTP rather than through a graph-mutating tool so an export assertion cannot pass
 * merely because the tool that wrote the graph and the tool that read it share a bug.
 *
 * @param email Identity that will own the diagram.
 * @param title Title to give it.
 * @param graphData Canonical graph JSON to store, or `undefined` to leave the diagram empty.
 * @returns The new diagram's id.
 * @throws {Error} When the Worker refuses the create or the save, which would otherwise surface
 *   later as an unexplained empty export.
 */
async function seedDiagram(email: string, title: string, graphData?: string): Promise<string> {
  const created = await callTool(email, 'create_diagram', { title });
  const { id } = JSON.parse(toolText(created.body)) as { id: string };

  if (graphData !== undefined) {
    const response = await send(
      new Request(`${ORIGIN}/api/diagrams/${id}/graph`, {
        body: JSON.stringify({ graphData }),
        headers: {
          'content-type': 'application/json',
          'origin': ORIGIN,
          [JWT_HEADER]: await signDevJwt(email, { audience: AUD })
        },
        method: 'PUT'
      })
    );
    // Consumed deliberately: an unread body keeps the call in flight, and the runtime's own
    // teardown waits for in-flight requests to drain before evicting anything.
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Seeding the graph failed with ${response.status}: ${text}`);
    }
  }

  return id;
}

describe('the MCP endpoint', () => {
  beforeAll(async () => {
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  it('rejects an unauthenticated MCP request before it reaches the handler', async () => {
    const response = await send(mcpRequest('tools/list', {}));

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });

  it('advertises the read, metadata and graph tools with described schemas', async () => {
    const response = await send(await mcpRequestAs(ALICE, 'tools/list', {}));
    const body = (await response.json()) as {
      result: {
        tools: {
          description?: string;
          inputSchema: { properties?: Record<string, unknown> };
          name: string;
        }[];
      };
    };

    expect(response.status).toBe(200);
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      'list_diagrams',
      'get_diagram',
      'create_diagram',
      'rename_diagram',
      'delete_diagram',
      'add_node',
      'update_node',
      'remove_node',
      'add_edge',
      'update_edge',
      'remove_edge',
      'auto_layout_diagram',
      'create_share_link',
      'get_share_status',
      'revoke_share_link',
      'export_diagram'
    ]);
    for (const tool of body.result.tools) {
      expect(tool.description).toContain('authenticated caller');
      for (const property of Object.values(tool.inputSchema.properties ?? {})) {
        expect(property).toMatchObject({ description: expect.any(String) as string });
      }
    }
  });

  // The grid is visibly simpler than the editor's own ELK-based button, which cannot run on the
  // server. Saying so in the description is what stops a model promising the user a quality of
  // layout this tool will not deliver — the same honesty standard every other description here is
  // held to, and the one most easily lost in a later edit.
  it('tells a calling model the server-side layout is the simpler one', async () => {
    const response = await send(await mcpRequestAs(ALICE, 'tools/list', {}));
    const body = (await response.json()) as {
      result: { tools: { description?: string; name: string }[] };
    };

    const layout = body.result.tools.find((tool) => tool.name === 'auto_layout_diagram');
    expect(layout?.description).toContain('simpler');
    expect(layout?.description).toContain('editor');
  });

  it('lets a non-browser MCP caller create, list, read, rename and delete its own diagram', async () => {
    const created = await callTool(ALICE, 'create_diagram', {
      description: 'Initial description',
      title: 'Created by MCP'
    });
    const diagram = JSON.parse(toolText(created.body)) as {
      id: string;
      ownerEmail: string;
      title: string;
    };

    expect(created.status).toBe(200);
    expect(diagram).toMatchObject({ ownerEmail: ALICE, title: 'Created by MCP' });

    const listed = await callTool(ALICE, 'list_diagrams');
    const summaries = JSON.parse(toolText(listed.body)) as { id: string; title: string }[];
    expect(summaries).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: diagram.id, title: 'Created by MCP' })])
    );

    const read = await callTool(ALICE, 'get_diagram', { diagramId: diagram.id });
    expect(JSON.parse(toolText(read.body))).toMatchObject({
      id: diagram.id,
      title: 'Created by MCP'
    });

    const renamed = await callTool(ALICE, 'rename_diagram', {
      description: null,
      diagramId: diagram.id,
      title: 'Renamed by MCP'
    });
    expect(JSON.parse(toolText(renamed.body))).toMatchObject({
      description: null,
      title: 'Renamed by MCP'
    });

    const deleted = await callTool(ALICE, 'delete_diagram', { diagramId: diagram.id });
    expect(toolText(deleted.body)).toBe(`Diagram ${diagram.id} deleted.`);

    const afterDelete = await callTool(ALICE, 'get_diagram', { diagramId: diagram.id });
    expect(afterDelete.body).toMatchObject({
      result: { content: [{ text: 'Diagram not found.' }], isError: true }
    });
  });

  it('returns the same non-enumerating tool error for a foreign and absent diagram', async () => {
    const created = await callTool(ALICE, 'create_diagram', { title: 'Alice only' });
    const diagram = JSON.parse(toolText(created.body)) as { id: string };

    const foreign = await callTool(MALLORY, 'get_diagram', { diagramId: diagram.id });
    const absent = await callTool(MALLORY, 'get_diagram', {
      diagramId: '11111111-1111-4111-8111-111111111111'
    });

    expect(foreign.status).toBe(200);
    expect(absent.status).toBe(200);
    expect(foreign.body).toMatchObject({
      result: { content: [{ text: 'Diagram not found.' }], isError: true }
    });
    expect(absent.body).toEqual(foreign.body);
  });

  it('exposes an owned diagram through the read-only resource and rejects a foreign resource', async () => {
    const created = await callTool(ALICE, 'create_diagram', { title: 'Resource diagram' });
    const diagram = JSON.parse(toolText(created.body)) as { id: string; title: string };

    const response = await send(
      await mcpRequestAs(ALICE, 'resources/read', { uri: `architect://diagrams/${diagram.id}` })
    );
    const body = (await response.json()) as {
      result: { contents: { mimeType: string; text: string; uri: string }[] };
    };

    expect(response.status).toBe(200);
    expect(body.result.contents[0]).toMatchObject({
      mimeType: 'application/json',
      uri: `architect://diagrams/${diagram.id}`
    });
    expect(JSON.parse(body.result.contents[0]?.text ?? '')).toMatchObject({ title: diagram.title });

    const forbidden = await send(
      await mcpRequestAs(MALLORY, 'resources/read', { uri: `architect://diagrams/${diagram.id}` })
    );
    const foreign = await forbidden.json();
    expect(forbidden.status).toBe(200);
    expect(foreign).toMatchObject({ error: { message: 'Diagram not found.' } });
  });

  // The whole sharing lifecycle through the real runtime, against real D1 and real KV. The unit
  // suite proves the token rule over in-memory ports; this proves the link an agent is handed
  // actually resolves, and that the one it was handed is the only copy in existence.
  it('mints a working share link once, and never discloses it again', async () => {
    const diagramId = await seedDiagram(ALICE, 'Shared by MCP');

    const before = await callTool(ALICE, 'get_share_status', { diagramId });
    expect(JSON.parse(toolText(before.body))).toEqual({ active: false, createdAt: null });

    const created = await callTool(ALICE, 'create_share_link', { diagramId });
    const share = JSON.parse(toolText(created.body)) as {
      createdAt: string;
      token: string;
      url: string;
    };

    // Resolved against the request's own origin rather than a literal, so the link points at
    // whatever hostname this deployment actually serves.
    expect(share.url).toBe(`${ORIGIN}/s/${share.token}`);

    // The link genuinely works for an anonymous caller: no Access token, no identity header.
    const anonymous = await send(new Request(`${ORIGIN}/api/shares/${share.token}`));
    const shared = (await anonymous.json()) as { diagram: { id: string; ownerEmail?: string } };
    expect(anonymous.status).toBe(200);
    expect(shared.diagram.id).toBe(diagramId);
    expect(shared.diagram.ownerEmail).toBeUndefined();

    // The status tool knows a link exists and cannot say what it is — only a digest was kept.
    const status = await callTool(ALICE, 'get_share_status', { diagramId });
    expect(JSON.parse(toolText(status.body))).toEqual({
      active: true,
      createdAt: share.createdAt
    });
    expect(JSON.stringify(status.body)).not.toContain(share.token);

    // Nor does any other response carry it, which is the claim that matters: there is exactly
    // one disclosure, and it has already happened.
    const read = await callTool(ALICE, 'get_diagram', { diagramId });
    const listed = await callTool(ALICE, 'list_diagrams');
    const exported = await callTool(ALICE, 'export_diagram', { diagramId, format: 'json' });
    expect(JSON.stringify([read.body, listed.body, exported.body])).not.toContain(share.token);

    const revoked = await callTool(ALICE, 'revoke_share_link', { diagramId });
    expect(toolText(revoked.body)).toBe(`Share link for diagram ${diagramId} revoked.`);

    // Revoked means revoked, for the anonymous holder of the link as well as in the status.
    const afterRevoke = await send(new Request(`${ORIGIN}/api/shares/${share.token}`));
    const problem = await afterRevoke.text();
    expect(afterRevoke.status).toBe(404);
    expect(problem).toContain('Share link not found or revoked.');

    // And revoking nothing is refused rather than succeeding quietly.
    const again = await callTool(ALICE, 'revoke_share_link', { diagramId });
    expect(again.body).toMatchObject({
      result: { content: [{ text: 'No active share link for this diagram.' }], isError: true }
    });
  });

  it('refuses every share tool against a diagram owned by somebody else', async () => {
    const diagramId = await seedDiagram(ALICE, 'Alice shares');
    await callTool(ALICE, 'create_share_link', { diagramId });

    for (const name of ['create_share_link', 'get_share_status', 'revoke_share_link']) {
      const refused = await callTool(MALLORY, name, { diagramId });
      expect(refused.body).toMatchObject({
        result: { content: [{ text: 'Diagram not found.' }], isError: true }
      });
    }

    // Alice's link survived every one of those attempts.
    const status = await callTool(ALICE, 'get_share_status', { diagramId });
    expect(JSON.parse(toolText(status.body))).toMatchObject({ active: true });
  });

  it('exports the graph as JSON and the project as a base64 archive', async () => {
    const graphData = JSON.stringify({
      edges: [],
      nodes: [
        {
          data: { label: 'Edge API', typeId: 'worker' },
          id: 'api',
          position: { x: 0, y: 0 },
          type: 'cf-node'
        },
        {
          data: { label: 'User Data', typeId: 'd1' },
          id: 'store',
          position: { x: 0, y: 200 },
          type: 'cf-node'
        }
      ],
      viewport: { x: 0, y: 0, zoom: 1 }
    });
    const diagramId = await seedDiagram(ALICE, 'Billing Service', graphData);

    const asJson = await callTool(ALICE, 'export_diagram', { diagramId, format: 'json' });
    expect(JSON.parse(toolText(asJson.body))).toMatchObject({
      nodes: [{ id: 'api' }, { id: 'store' }]
    });

    const asScaffold = await callTool(ALICE, 'export_diagram', { diagramId, format: 'scaffold' });
    const resource = toolResource(asScaffold.body);

    expect(resource.mimeType).toBe('application/zip');
    expect(resource.uri).toBe(`architect://diagrams/${diagramId}/scaffold.zip`);
    // A real ZIP, not a string that happens to decode: the local-file-header signature `PK\x03\x04`
    // is the first four bytes of any archive, so asserting it proves the bytes survived both the
    // server-side zip and the base64 round trip a harness will perform.
    expect(atob(resource.blob).slice(0, 4)).toBe('PK\u0003\u0004');
  });

  it('refuses an export of a diagram owned by somebody else', async () => {
    const diagramId = await seedDiagram(ALICE, 'Alice exports');

    for (const format of ['json', 'scaffold']) {
      const refused = await callTool(MALLORY, 'export_diagram', { diagramId, format });
      expect(refused.body).toMatchObject({
        result: { content: [{ text: 'Diagram not found.' }], isError: true }
      });
    }
  });

  // A model that assumed "export" covered images would promise the user a PNG and then have
  // nothing to hand over. The absence is deliberate — there is no server-side canvas to
  // rasterise — so the description has to say so, and this pins that it keeps saying so.
  it('tells a calling model that image export is browser-only', async () => {
    const response = await send(await mcpRequestAs(ALICE, 'tools/list', {}));
    const body = (await response.json()) as {
      result: {
        tools: {
          description?: string;
          inputSchema: { properties?: { format?: { enum?: string[] } } };
          name: string;
        }[];
      };
    };

    const exportTool = body.result.tools.find((tool) => tool.name === 'export_diagram');
    expect(exportTool?.description).toContain('PNG');
    expect(exportTool?.description).toContain('SVG');
    expect(exportTool?.description).toContain('browser');
    expect(exportTool?.inputSchema.properties?.format?.enum).toEqual(['json', 'scaffold']);

    // The same honesty standard applies to the share tools: a model must not offer to look a
    // lost link up, because nothing can.
    const status = body.result.tools.find((tool) => tool.name === 'get_share_status');
    expect(status?.description).toContain('never returns the link');
  });
});
