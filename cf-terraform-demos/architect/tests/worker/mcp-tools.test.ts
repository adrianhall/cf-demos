import { describe, expect, it } from 'vitest';
import { DiagramService } from '../../src/worker/application/diagram-service.ts';
import type { Diagram } from '../../src/worker/domain/diagram.ts';
import {
  createDiagramTool,
  deleteDiagramTool,
  getDiagramTool,
  listDiagramsTool,
  renameDiagramTool,
  type McpToolContext
} from '../../src/worker/mcp/tools.ts';
import { FakeDiagramRepository } from './fake-diagram-repository.ts';
import { FakeShareRepository } from './fake-share-repository.ts';

/**
 * @file Unit coverage for the MCP layer's deliberately thin calls into the diagram use cases. These
 *   tests do not mock the service: an in-memory, authorization-neutral repository lets the real
 *   service prove that a tool cannot weaken either validation or its uniform non-enumerating
 *   ownership `404`.
 */

/**
 * Identity that owns the diagrams in the ordinary cases.
 */
const ALICE = 'alice@example.com';

/**
 * A second valid identity, used to prove owner isolation.
 */
const MALLORY = 'mallory@example.com';

/**
 * Records one structured MCP log event.
 */
interface LogEntry {
  /**
   * Event name emitted by the use case.
   */
  event: string;
  /**
   * Structured fields attached to the event.
   */
  context: Record<string, unknown>;
}

/**
 * Builds the real diagram service over in-memory ports and one request-scoped MCP context.
 *
 * @param actorEmail Verified identity the context should represent.
 * @returns The context, backing repository, and captured structured log events.
 */
function createContext(actorEmail: string = ALICE): {
  context: McpToolContext;
  diagrams: FakeDiagramRepository;
  entries: LogEntry[];
} {
  const diagrams = new FakeDiagramRepository();
  const shares = new FakeShareRepository();
  const entries: LogEntry[] = [];

  const context: McpToolContext = {
    actorEmail,
    diagrams: new DiagramService(diagrams, shares),
    logger: {
      info(event: string, logContext?: Record<string, unknown>): void {
        entries.push({ context: logContext ?? {}, event });
      }
    }
  };

  return { context, diagrams, entries };
}

/**
 * Creates a fixture diagram through the real MCP tool rather than seeding a repository row.
 *
 * @param context MCP context whose identity will own the result.
 * @param title Title to give the fixture diagram.
 * @returns The new diagram.
 */
async function createFixture(context: McpToolContext, title: string): Promise<Diagram> {
  return createDiagramTool(context, { title });
}

describe('MCP diagram tools', () => {
  it('lists compact summaries for only the authenticated owner', async () => {
    const alice = createContext(ALICE);
    const mallory = createContext(MALLORY);
    const first = await createFixture(alice.context, 'First');
    await createFixture(mallory.context, 'Private');
    const second = await createFixture(alice.context, 'Second');

    const { diagrams } = await listDiagramsTool(alice.context);

    expect(diagrams).toEqual([
      {
        createdAt: second.createdAt,
        description: null,
        id: second.id,
        title: 'Second',
        updatedAt: second.updatedAt
      },
      {
        createdAt: first.createdAt,
        description: null,
        id: first.id,
        title: 'First',
        updatedAt: first.updatedAt
      }
    ]);
    expect(JSON.stringify(diagrams)).not.toContain('graphData');
    expect(JSON.stringify(diagrams)).not.toContain(MALLORY);
  });

  it('reads a diagram only for its owner and logs the MCP transport', async () => {
    const alice = createContext(ALICE);
    const diagram = await createFixture(alice.context, 'Private');
    alice.entries.length = 0;

    const { diagram: read } = await getDiagramTool(alice.context, diagram.id);

    expect(read).toEqual(diagram);
    expect(alice.entries).toEqual([
      { context: { diagramId: diagram.id, via: 'mcp' }, event: 'diagram_opened' }
    ]);
  });

  it('reports a foreign and an absent diagram identically', async () => {
    const alice = createContext(ALICE);
    const diagram = await createFixture(alice.context, 'Private');
    const mallory = createContext(MALLORY);

    const messages = await Promise.all(
      [diagram.id, '11111111-1111-4111-8111-111111111111'].map(async (id) => {
        try {
          await getDiagramTool(mallory.context, id);
          return 'unexpected success';
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      })
    );

    expect(messages).toEqual(['Diagram not found.', 'Diagram not found.']);
  });

  it('creates the diagram for the verified caller and retains service validation', async () => {
    const { context, entries } = createContext(ALICE);
    entries.length = 0;

    const diagram = await createDiagramTool(context, {
      ownerEmail: MALLORY,
      title: 'Created through MCP'
    });

    expect(diagram).toMatchObject({ ownerEmail: ALICE, title: 'Created through MCP' });
    expect(entries).toEqual([
      { context: { diagramId: diagram.id, via: 'mcp' }, event: 'diagram_created' }
    ]);

    await expect(createDiagramTool(context, { title: '' })).rejects.toThrow(
      'title must be between 1 and 255 characters.'
    );
  });

  it('renames and clears metadata through the shared service', async () => {
    const { context, entries } = createContext(ALICE);
    const diagram = await createDiagramTool(context, { description: 'Before', title: 'Before' });
    entries.length = 0;

    const renamed = await renameDiagramTool(context, diagram.id, {
      description: null,
      title: 'After'
    });

    expect(renamed).toMatchObject({ description: null, title: 'After' });
    expect(entries).toEqual([
      {
        context: { diagramId: diagram.id, kind: 'metadata', via: 'mcp' },
        event: 'diagram_updated'
      }
    ]);
    await expect(renameDiagramTool(context, diagram.id, {})).rejects.toThrow(
      'The request body must include title and/or description.'
    );
  });

  it('deletes the owned diagram through the same share-cascading use case and logs via MCP', async () => {
    const { context, diagrams, entries } = createContext(ALICE);
    const diagram = await createFixture(context, 'Delete me');
    entries.length = 0;

    await deleteDiagramTool(context, diagram.id);

    expect(await diagrams.find(diagram.id)).toBeNull();
    expect(entries).toEqual([
      { context: { diagramId: diagram.id, via: 'mcp' }, event: 'diagram_deleted' }
    ]);
  });
});
