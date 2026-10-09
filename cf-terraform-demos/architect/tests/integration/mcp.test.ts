import { applyD1Migrations } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';
import { advertisedToolNames } from '../../src/client/views/mcp-tool-catalogue.ts';

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
 * Every tool this server advertises, with the arguments that exercise it against a fixture diagram.
 *
 * Written out rather than derived from `tools/list`, deliberately. Deriving it would make a
 * catalogue assertion compare the server against itself, so deleting a tool would quietly delete
 * its coverage too. This list is the independent statement of what the catalogue must contain,
 * which is what lets `tools/list` be checked against something rather than against its own output.
 */
const TOOL_CATALOGUE: {
  /**
   * How the tool is reached: `mutating` tools change a graph, `reading` ones do not.
   */
  category: 'export' | 'graph' | 'metadata' | 'read' | 'share';
  /**
   * Registered tool name.
   */
  name: string;
  /**
   * Arguments to call it with, before the fixture diagram id is added.
   */
  args: Record<string, unknown>;
}[] = [
  { args: {}, category: 'read', name: 'list_diagrams' },
  { args: {}, category: 'read', name: 'get_diagram' },
  { args: { title: 'Created in a catalogue sweep' }, category: 'metadata', name: 'create_diagram' },
  { args: { title: 'Renamed in a catalogue sweep' }, category: 'metadata', name: 'rename_diagram' },
  {
    args: { id: 'swept', label: 'Swept', position: { x: 0, y: 0 }, typeId: 'worker' },
    category: 'graph',
    name: 'add_node'
  },
  { args: { label: 'Swept again', nodeId: 'swept' }, category: 'graph', name: 'update_node' },
  {
    args: { edgeType: 'service-binding', id: 'swept-edge', source: 'swept', target: 'swept' },
    category: 'graph',
    name: 'add_edge'
  },
  { args: { edgeId: 'swept-edge', label: 'swept' }, category: 'graph', name: 'update_edge' },
  { args: { edgeId: 'swept-edge' }, category: 'graph', name: 'remove_edge' },
  { args: { nodeId: 'swept' }, category: 'graph', name: 'remove_node' },
  { args: {}, category: 'graph', name: 'auto_layout_diagram' },
  { args: {}, category: 'share', name: 'create_share_link' },
  { args: {}, category: 'share', name: 'get_share_status' },
  { args: {}, category: 'share', name: 'revoke_share_link' },
  { args: { format: 'json' }, category: 'export', name: 'export_diagram' },
  { args: {}, category: 'metadata', name: 'delete_diagram' }
];

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
 * Reads the message from a `tools/call` payload that reported a failed tool.
 *
 * Separate from {@link toolText}, which refuses an error result: the ownership comparison needs the
 * _refusal_ text specifically, so that the wording an agent is shown can be compared with the
 * wording the HTTP API returns.
 *
 * @param body Parsed JSON-RPC response payload.
 * @returns The failed tool's message.
 * @throws {Error} When the payload is not a failed tool result, so a passing assertion cannot be
 *   produced by a successful call that happened to contain the expected text.
 */
function toolErrorText(body: Record<string, unknown>): string {
  const result = body.result as { content?: { text?: string }[]; isError?: boolean } | undefined;
  const text = result?.content?.[0]?.text;
  if (result?.isError !== true || typeof text !== 'string') {
    throw new Error(`Expected a failed MCP tool result, received ${JSON.stringify(body)}.`);
  }
  return text;
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

  // The public guide page at `/guides/mcp` tells a reader what this server offers *before* they
  // connect, so its list has to be the list. Nothing else connects the two: a tool added to the
  // server without being added to the page leaves the guide quietly understating the surface,
  // and a tool removed leaves it advertising something that no longer answers. Checked against a
  // real `tools/list` response rather than against the registration source, so it is the served
  // catalogue being compared.
  it('serves exactly the catalogue the public guide page advertises', async () => {
    const response = await send(await mcpRequestAs(ALICE, 'tools/list', {}));
    const body = (await response.json()) as { result: { tools: { name: string }[] } };

    const served = body.result.tools.map((tool) => tool.name).sort();

    expect(served).toEqual([...advertisedToolNames()].sort());
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

  // Avoiding overlap alone does not make an architecture readable: a long edge can pass behind a
  // third node and appear to originate there. Keep that visual rule in the model-visible schema,
  // alongside the concrete remediation after a mutation, rather than relying on a caller to infer
  // it from a node's raw x/y coordinates.
  it('tells a calling model to preserve clear edge routing when placing a node', async () => {
    const response = await send(await mcpRequestAs(ALICE, 'tools/list', {}));
    const body = (await response.json()) as {
      result: {
        tools: {
          inputSchema?: { properties?: Record<string, { description?: string }> };
          name: string;
        }[];
      };
    };

    const addNode = body.result.tools.find((tool) => tool.name === 'add_node');
    const position = addNode?.inputSchema?.properties?.position;

    expect(position?.description).toContain('adjacent to the nodes it will connect to');
    expect(position?.description).toContain('passes behind an unrelated node');
    expect(position?.description).toContain('After adding a node to an existing diagram');
    expect(position?.description).toContain('auto_layout_diagram');
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

    const asSvg = await callTool(ALICE, 'export_diagram', { diagramId, format: 'svg' });
    const svg = toolText(asSvg.body);
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('<title>Billing Service</title>');
    expect(svg).toContain('Edge API');
    expect(svg).toContain('User Data');

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

    for (const format of ['json', 'scaffold', 'svg']) {
      const refused = await callTool(MALLORY, 'export_diagram', { diagramId, format });
      expect(refused.body).toMatchObject({
        result: { content: [{ text: 'Diagram not found.' }], isError: true }
      });
    }
  });

  // A model has to distinguish the vector image the Worker can produce from the raster image it
  // cannot. This pins both halves so a later wording edit cannot hide SVG or promise PNG.
  it('tells a calling model that SVG works and PNG is browser-only', async () => {
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
    expect(exportTool?.description).toContain('browser-only');
    expect(exportTool?.description).toContain('markdown');
    expect(exportTool?.inputSchema.properties?.format?.enum).toEqual(['json', 'scaffold', 'svg']);

    // The same honesty standard applies to the share tools: a model must not offer to look a
    // lost link up, because nothing can.
    const status = body.result.tools.find((tool) => tool.name === 'get_share_status');
    expect(status?.description).toContain('never returns the link');
  });

  // Protocol conformance against the real handler rather than against a client library's idea of
  // it. A model never sees this server's source — it sees `tools/list`, and decides what to call
  // from that alone — so the catalogue and the schemas are the public contract, and a tool that
  // disappears from it has disappeared regardless of whether its function still exists.
  describe('protocol conformance', () => {
    it('advertises exactly the catalogue, with no tool missing and none added', async () => {
      const response = await send(await mcpRequestAs(ALICE, 'tools/list', {}));
      const body = (await response.json()) as { result: { tools: { name: string }[] } };

      expect(new Set(body.result.tools.map((tool) => tool.name))).toEqual(
        new Set(TOOL_CATALOGUE.map((tool) => tool.name))
      );
    });

    // Every advertised tool declares an object schema whose every property is described. A model
    // chooses arguments from these descriptions, so an undescribed field is a field it has to
    // guess at — and a guess at, say, canvas units places a node plausibly rather than visibly
    // wrongly, which is the failure nobody notices.
    it('advertises a described object schema for every tool', async () => {
      const response = await send(await mcpRequestAs(ALICE, 'tools/list', {}));
      const body = (await response.json()) as {
        result: {
          tools: {
            description?: string;
            inputSchema: { properties?: Record<string, unknown>; type?: string };
            name: string;
            title?: string;
          }[];
        };
      };

      for (const tool of body.result.tools) {
        expect(tool.inputSchema.type, `${tool.name} input schema`).toBe('object');
        expect(tool.title, `${tool.name} title`).toEqual(expect.any(String));
        expect(tool.description?.length ?? 0, `${tool.name} description`).toBeGreaterThan(40);
        for (const [field, property] of Object.entries(tool.inputSchema.properties ?? {})) {
          expect(property, `${tool.name}.${field}`).toMatchObject({
            description: expect.any(String) as string
          });
        }
      }
    });

    // An actual round trip of every tool in the catalogue, in an order that leaves the fixture
    // consistent. A tool whose registered schema rejects the arguments its own description
    // promises fails here and nowhere else: a unit test calls the tool function directly and
    // never sees the schema at all.
    it('round-trips every tool in the catalogue over the wire', async () => {
      const diagramId = await seedDiagram(ALICE, 'Catalogue sweep');
      const reached = new Set<string>();

      for (const { args, name } of TOOL_CATALOGUE) {
        const includesDiagram = name !== 'list_diagrams' && name !== 'create_diagram';
        const { body, status } = await callTool(ALICE, name, {
          ...args,
          ...(includesDiagram ? { diagramId } : {})
        });

        expect(status, `${name} transport status`).toBe(200);
        expect(body, `${name} result`).not.toMatchObject({ result: { isError: true } });
        expect(body, `${name} JSON-RPC error`).not.toHaveProperty('error');
        reached.add(name);
      }

      expect(reached.size).toBe(TOOL_CATALOGUE.length);
    });

    // The protocol's own error channel, which is not an HTTP status. A failed tool call is a
    // `200` carrying `isError: true`, because the JSON-RPC call itself succeeded — and a client
    // that treated the status as the result would report every refusal as a success.
    it('reports a refused tool call as a 200 carrying isError', async () => {
      const refused = await callTool(ALICE, 'get_diagram', {
        diagramId: '11111111-1111-4111-8111-111111111111'
      });

      expect(refused.status).toBe(200);
      expect(refused.body).toMatchObject({
        id: 1,
        jsonrpc: '2.0',
        result: { content: [{ text: 'Diagram not found.', type: 'text' }], isError: true }
      });
    });

    it('reports an unknown tool as a JSON-RPC error rather than an empty success', async () => {
      const unknown = await callTool(ALICE, 'drop_database');

      expect(unknown.status).toBe(200);
      expect(unknown.body).toHaveProperty('error');
    });

    // Four declarations have to agree on the literal `/mcp` for a tool call to work at all: the
    // handler's own `route`, the Hono mount, the `runWorkerFirst` entry and the same-origin
    // carve-out. Three of them are exact matches and one is a prefix, so a sibling path is
    // authenticated and reaches the Worker but is served by nothing — which this pins, because a
    // future route accidentally added under the prefix would otherwise inherit the carve-out
    // silently.
    it('serves no path but the configured route, and extends its carve-out to none either', async () => {
      const token = await signDevJwt(ALICE, { audience: AUD });

      /**
       * Posts an MCP-shaped body to one path as a verified caller.
       *
       * @param path Path to post to.
       * @param browserLike Whether to send the `Sec-Fetch-Site` header a browser would, which is
       *   what distinguishes the same-origin refusal from the routing one.
       * @returns The response status.
       */
      async function postTo(path: string, browserLike: boolean): Promise<number> {
        const response = await send(
          new Request(`${ORIGIN}${path}`, {
            body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} }),
            headers: {
              'accept': 'application/json, text/event-stream',
              'content-type': 'application/json',
              'host': HOST,
              ...(browserLike ? { 'sec-fetch-site': 'same-origin' } : {}),
              [JWT_HEADER]: token
            },
            method: 'POST'
          })
        );
        await response.text();
        return response.status;
      }

      // The carve-out is an exact pathname match, so a sibling path is still guarded and a
      // non-browser caller is refused there before routing even looks at it.
      expect(await postTo('/mcp/tools', false)).toBe(403);

      // Past that guard, nothing serves the sibling path: the router mounts only `/mcp`, and the
      // handler would 404 it in turn even if the router did not.
      expect(await postTo('/mcp/tools', true)).toBe(404);

      // And the real route still works, so the two refusals above are about the path rather than
      // about anything this test did to the request.
      expect(await postTo('/mcp', false)).toBe(200);
    });
  });

  // Managed OAuth itself cannot be emulated locally — Access resolves an opaque token at its own
  // edge — but everything it hands this Worker can be. Access forwards a signed
  // `Cf-Access-Jwt-Assertion` header, so from here an OAuth-authenticated MCP client is
  // indistinguishable from a browser, and these are the three ways that header fails.
  describe('authentication failures at the MCP endpoint', () => {
    it('refuses a request with no credential at all', async () => {
      const response = await send(mcpRequest('tools/list', {}));
      await response.text();

      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    });

    // The defence that matters most, and the reason an `aud` check is not optional: every Access
    // application in a team shares one JWKS, so a token minted for an unrelated application —
    // including one an attacker legitimately holds for a different app on the same team — passes
    // signature validation. The audience check is the only thing that refuses it.
    it('refuses a correctly signed token minted for a different Access application', async () => {
      const response = await send(
        mcpRequest('tools/list', {}, await signDevJwt(ALICE, { audience: 'b'.repeat(64) }))
      );
      await response.text();

      expect(response.status).toBe(401);
    });

    it('refuses an expired token', async () => {
      const response = await send(
        mcpRequest('tools/list', {}, await signDevJwt(ALICE, { audience: AUD, lifetime: -60 }))
      );
      await response.text();

      expect(response.status).toBe(401);
    });

    // Refused *before* the handler, not by it. The body is an RFC 9457 problem document rather
    // than a JSON-RPC error, which is the correct layering: the request never became an MCP
    // message, so answering it in MCP's vocabulary would imply the server had read it.
    it('answers with a problem document rather than a JSON-RPC error', async () => {
      const response = await send(
        mcpRequest('tools/call', { arguments: {}, name: 'list_diagrams' })
      );
      const body = (await response.json()) as Record<string, unknown>;

      expect(body).not.toHaveProperty('jsonrpc');
      expect(body).toMatchObject({ status: 401 });
    });

    // A browser's `WebSocket` and a non-browser MCP client are alike in one way that matters: a
    // `302` to a login page is something neither can follow. `redirect: false` on the `/mcp`
    // policy is what makes the refusal legible instead of arriving as HTML.
    it('never redirects an MCP client to a login page', async () => {
      const request = mcpRequest('tools/list', {});
      request.headers.set('Accept', 'text/html');

      const response = await send(request);
      await response.text();

      expect(response.status).toBe(401);
      expect(response.headers.get('location')).toBeNull();
    });
  });

  // The headline security property of the whole design, stated as one test rather than left to be
  // inferred from two suites. MCP is a second transport over the same use cases, so the only way
  // it can hold a *different* ownership rule is if somebody wrote a second one — and this is what
  // would notice.
  describe('diagram ownership holds identically across HTTP and MCP', () => {
    it('answers a non-owner with the same non-enumerating 404 on both transports', async () => {
      const diagramId = await seedDiagram(ALICE, 'Alice’s only copy');
      const absentId = '11111111-1111-4111-8111-111111111111';
      const mallorysToken = await signDevJwt(MALLORY, { audience: AUD });

      /**
       * Reads one diagram over the browser's own HTTP route as Mallory.
       *
       * @param id Diagram id to request.
       * @returns The status and the response body as text.
       */
      async function overHttp(id: string): Promise<{ body: string; status: number }> {
        const response = await send(
          new Request(`${ORIGIN}/api/diagrams/${id}`, {
            headers: { 'sec-fetch-site': 'same-origin', [JWT_HEADER]: mallorysToken }
          })
        );
        return { body: await response.text(), status: response.status };
      }

      const httpForeign = await overHttp(diagramId);
      const httpAbsent = await overHttp(absentId);
      const mcpForeign = await callTool(MALLORY, 'get_diagram', { diagramId });
      const mcpAbsent = await callTool(MALLORY, 'get_diagram', { diagramId: absentId });

      // HTTP: a foreign diagram and an absent one are byte-identical, so a `404` cannot confirm a
      // guessed id is real.
      expect(httpForeign.status).toBe(404);
      expect(httpForeign).toEqual(httpAbsent);

      // MCP: the same, in the protocol's own error vocabulary.
      expect(mcpForeign.body).toMatchObject({
        result: { content: [{ text: 'Diagram not found.' }], isError: true }
      });
      expect(mcpForeign.body).toEqual(mcpAbsent.body);

      // And the two transports agree on the wording, because there is one rule in one private
      // method of `DiagramService` rather than two that happen to match today.
      expect(httpForeign.body).toContain('Diagram not found.');
      expect(toolErrorText(mcpForeign.body)).toBe('Diagram not found.');

      // Alice's diagram is untouched by every one of those attempts.
      const stillHers = await callTool(ALICE, 'get_diagram', { diagramId });
      expect(JSON.parse(toolText(stillHers.body))).toMatchObject({ id: diagramId });
    });

    // Reading is the headline case; writing is the one with consequences. Every mutating tool
    // reaches D1 through the same service the HTTP routes use, so a non-owner is refused before
    // anything is written — asserted by reading the row back rather than by trusting the refusal.
    it('refuses every mutating tool for a non-owner and writes nothing', async () => {
      const diagramId = await seedDiagram(ALICE, 'Not Mallory’s');
      const before = await callTool(ALICE, 'get_diagram', { diagramId });

      for (const { args, category, name } of TOOL_CATALOGUE) {
        if (category !== 'graph') {
          continue;
        }
        const refused = await callTool(MALLORY, name, { ...args, diagramId });
        expect(refused.body, `${name} as a non-owner`).toMatchObject({
          result: { content: [{ text: 'Diagram not found.' }], isError: true }
        });
      }

      const after = await callTool(ALICE, 'get_diagram', { diagramId });
      expect(JSON.parse(toolText(after.body))).toMatchObject({
        graphData: (JSON.parse(toolText(before.body)) as { graphData: string }).graphData
      });
    });

    // The owner derives from the verified Access identity and from nothing else. A tool argument
    // is attacker-controlled input and a model can be talked into supplying one, so the tools
    // accept no owner field — and an unexpected one is ignored rather than honoured.
    it('ignores an owner supplied as a tool argument', async () => {
      const created = await callTool(MALLORY, 'create_diagram', {
        ownerEmail: ALICE,
        title: 'Claimed for Alice'
      });
      const diagram = JSON.parse(toolText(created.body)) as { id: string; ownerEmail: string };

      expect(diagram.ownerEmail).toBe(MALLORY);

      // And Alice genuinely cannot see it, which is the fact the field would have changed.
      const asAlice = await callTool(ALICE, 'get_diagram', { diagramId: diagram.id });
      expect(asAlice.body).toMatchObject({ result: { isError: true } });
    });
  });
});
