import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
/**
 * Unit tests for the stateless MCP read surface.
 */
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createCrmMcpServer } from '../../../src/application-worker/mcp/server.ts';
import { createFakeDataService } from '../../fakes/fake-data-service.ts';

/**
 * Connect an in-memory v2 client to a freshly isolated MCP server.
 *
 * @param permissions Capabilities available to the caller.
 * @returns Connected client.
 */
async function connected(permissions: readonly string[]) {
  const { service, store } = createFakeDataService();
  const userId = store.addUser('reader@example.com', 'read-only');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createCrmMcpServer({
    data: service,
    actor: { email: 'reader@example.com', userId, requestId: 'mcp-test', channel: 'mcp' },
    permissions
  });
  await server.connect(serverTransport);
  const client = new Client({ name: 'ignite-crm-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('CRM MCP server', () => {
  it('only advertises tools held by the verified caller', async () => {
    const client = await connected(['crm.read']);
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toContain('get_contact');
    expect(result.tools.map((tool) => tool.name)).not.toContain('pipeline_summary');
    expect(result.tools.map((tool) => tool.name)).toContain('whoami');
  });

  it('rejects malformed tool arguments before calling the service', async () => {
    const client = await connected(['crm.read']);
    const result = await client.callTool({
      name: 'get_contact',
      arguments: { id: 'not-an-id', actor: 'owner' }
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Input validation error')
    });
  });

  it('maps forbidden records to a non-enumerating tool error', async () => {
    const client = await connected(['crm.read']);
    const result = await client.callTool({
      name: 'get_contact',
      arguments: { id: '00000000-0000-4000-8000-000000000001' }
    });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested record is not available.',
        retryable: false,
        requestId: 'mcp-test'
      }
    });
  });
});
