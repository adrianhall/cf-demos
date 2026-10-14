/**
 * Direct coverage of every narrow Data Worker delegation in the agent tool registry.
 */
import { describe, expect, it } from 'vitest';
import { createAgentTools } from '../../../src/application-worker/agent/tools.ts';
import type { DataService } from '../../../src/shared/data-service/contract.ts';

/**
 * Build a recording service whose nested methods all resolve with their own dotted path.
 *
 * @param calls Destination for invoked method names.
 * @returns Data-service-shaped test double.
 */
function recordingService(calls: string[]): DataService {
  const method =
    (path: string) =>
    (..._arguments: unknown[]): Promise<string> => {
      calls.push(path);
      return Promise.resolve(path);
    };
  return new Proxy(
    {},
    {
      get: (_target, group: string) =>
        new Proxy({}, { get: (_nested, name: string) => method(`${group}.${name}`) })
    }
  ) as DataService;
}

/**
 * Test input for a catalogue entry.
 */
function inputFor(name: string): Record<string, unknown> {
  if (name === 'search_notes') return { text: 'renewal' };
  if (name === 'quarterly_pipeline') return { quarter: '2026-Q1' };
  if (name.includes('get_')) return { id: '00000000-0000-4000-8000-000000000001' };
  return {};
}

describe('agent tool registry', () => {
  it('delegates each read tool under the verified MCP actor', async () => {
    const calls: string[] = [];
    const tools = createAgentTools();
    const data = recordingService(calls);
    for (const tool of tools) {
      await tool.execute(
        {
          data,
          actor: {
            email: 'reader@example.com',
            userId: 'reader',
            requestId: 'tool-test',
            channel: 'mcp'
          }
        },
        inputFor(tool.name)
      );
    }
    expect(calls).toEqual([
      'permissions.getSession',
      'crm.listContacts',
      'crm.listCompanies',
      'crm.getContact',
      'crm.getCompany',
      'crm.listDeals',
      'crm.getDeal',
      'crm.actionStream',
      'crm.pipelineSummary',
      'crm.quarterlyPipeline',
      'projects.listProjects',
      'projects.getProject',
      'projects.myWork',
      'notes.searchNotes',
      'notes.getNote',
      'projects.deliveryReport',
      'crm.createContact',
      'crm.updateContact',
      'crm.updateCompany',
      'crm.createDeal',
      'crm.updateDeal',
      'crm.updateDeal',
      'crm.createActivity',
      'crm.setContactNextAction',
      'crm.completeContactNextAction',
      'projects.convertDeal',
      'projects.createTask',
      'projects.updateTask',
      'notes.createNote',
      'notes.updateNote'
    ]);
  });
});
