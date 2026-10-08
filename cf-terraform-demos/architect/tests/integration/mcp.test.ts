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

describe('the MCP endpoint', () => {
  beforeAll(async () => {
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  it('rejects an unauthenticated MCP request before it reaches the handler', async () => {
    const response = await send(mcpRequest('tools/list', {}));

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });

  it('advertises only Phase 12 read and metadata tools with described schemas', async () => {
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
      'delete_diagram'
    ]);
    for (const tool of body.result.tools) {
      expect(tool.description).toContain('authenticated caller');
      for (const property of Object.values(tool.inputSchema.properties ?? {})) {
        expect(property).toMatchObject({ description: expect.any(String) as string });
      }
    }
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
});
