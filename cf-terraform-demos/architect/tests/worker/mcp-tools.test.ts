import { describe, expect, it } from 'vitest';
import { DiagramService } from '../../src/worker/application/diagram-service.ts';
import type { Diagram } from '../../src/worker/domain/diagram.ts';
import {
  addEdgeTool,
  addNodeTool,
  autoLayoutDiagramTool,
  createDiagramTool,
  deleteDiagramTool,
  getDiagramTool,
  listDiagramsTool,
  type McpToolContext,
  removeEdgeTool,
  removeNodeTool,
  renameDiagramTool,
  updateEdgeTool,
  updateNodeTool
} from '../../src/worker/mcp/tools.ts';
import { FakeDiagramRepository } from './fake-diagram-repository.ts';
import { FakeDiagramSessions } from './fake-diagram-sessions.ts';
import { FakeShareRepository } from './fake-share-repository.ts';
import { expectRejectedProblemStatus } from './problem-details.ts';

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
 * @returns The context, backing repository, recording session port, and captured log events.
 */
function createContext(actorEmail: string = ALICE): {
  context: McpToolContext;
  diagrams: FakeDiagramRepository;
  entries: LogEntry[];
  sessions: FakeDiagramSessions;
} {
  const diagrams = new FakeDiagramRepository();
  const shares = new FakeShareRepository();
  const sessions = new FakeDiagramSessions();
  const entries: LogEntry[] = [];

  const context: McpToolContext = {
    actorEmail,
    diagrams: new DiagramService(diagrams, shares, sessions),
    logger: {
      info(event: string, logContext?: Record<string, unknown>): void {
        entries.push({ context: logContext ?? {}, event });
      }
    }
  };

  return { context, diagrams, entries, sessions };
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

describe('MCP graph mutation tools', () => {
  /**
   * The graph fixture every case below starts from: two connected nodes.
   */
  const SEED_GRAPH = JSON.stringify({
    edges: [{ data: { edgeType: 'data-flow' }, id: 'link', source: 'api', target: 'db' }],
    nodes: [
      { data: { label: 'API' }, id: 'api', position: { x: 0, y: 0 }, type: 'cf-node' },
      { data: { label: 'DB' }, id: 'db', position: { x: 0, y: 200 }, type: 'cf-node' }
    ],
    viewport: { x: 0, y: 0, zoom: 1 }
  });

  /**
   * Creates a diagram seeded with {@link SEED_GRAPH} through the real use cases.
   *
   * @param context Tool context whose identity will own it.
   * @returns The seeded diagram.
   */
  async function seeded(context: McpToolContext): Promise<Diagram> {
    const diagram = await createDiagramTool(context, { title: 'Graph' });
    await context.diagrams.saveGraph(context.actorEmail, diagram.id, { graphData: SEED_GRAPH });
    return diagram;
  }

  /**
   * Parses a tool result's graph.
   *
   * @param diagram Diagram a graph tool returned.
   * @returns Its nodes and edges.
   */
  function graphOf(diagram: Diagram): {
    nodes: Record<string, unknown>[];
    edges: Record<string, unknown>[];
  } {
    return JSON.parse(diagram.graphData) as {
      nodes: Record<string, unknown>[];
      edges: Record<string, unknown>[];
    };
  }

  it('adds a node and returns the diagram carrying it', async () => {
    const { context } = createContext();
    const diagram = await seeded(context);

    const result = await addNodeTool(context, diagram.id, {
      id: 'queue',
      label: 'Jobs',
      position: { x: 300, y: 0 },
      typeId: 'queues'
    });

    expect(graphOf(result).nodes.map((node) => node.id)).toEqual(['api', 'db', 'queue']);
  });

  it('updates a node without disturbing anything else', async () => {
    const { context } = createContext();
    const diagram = await seeded(context);

    const result = await updateNodeTool(context, diagram.id, 'api', { label: 'Edge API' });

    expect(graphOf(result).nodes[0]).toMatchObject({ data: { label: 'Edge API' } });
    expect(graphOf(result).edges).toHaveLength(1);
  });

  // The cascade belongs to the domain and is not restated in the tool, so an agent's removal
  // leaves exactly the graph any other caller's removal would.
  it('removes a node and cascades to its edges', async () => {
    const { context } = createContext();
    const diagram = await seeded(context);

    const result = await removeNodeTool(context, diagram.id, 'db');

    expect(graphOf(result).nodes.map((node) => node.id)).toEqual(['api']);
    expect(graphOf(result).edges).toEqual([]);
  });

  it('adds, updates and removes an edge', async () => {
    const { context } = createContext();
    const diagram = await seeded(context);

    const added = await addEdgeTool(context, diagram.id, {
      edgeType: 'trigger',
      id: 'second',
      source: 'db',
      target: 'api'
    });
    expect(graphOf(added).edges.map((edge) => edge.id)).toEqual(['link', 'second']);

    const updated = await updateEdgeTool(context, diagram.id, 'second', { label: 'retry' });
    expect(graphOf(updated).edges[1]).toMatchObject({ data: { label: 'retry' } });

    const removed = await removeEdgeTool(context, diagram.id, 'second');
    expect(graphOf(removed).edges.map((edge) => edge.id)).toEqual(['link']);
  });

  it('lays every node out on the deterministic grid', async () => {
    const { context } = createContext();
    const diagram = await seeded(context);

    const result = await autoLayoutDiagramTool(context, diagram.id);

    expect(graphOf(result).nodes.map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 160 }
    ]);
  });

  // One event name for one thing that happened, distinguished only by `via` and `kind`, so a
  // single Workers Logs query separates an agent's edit from a person's.
  it.each([
    [
      'add_node',
      (context: McpToolContext, id: string) =>
        addNodeTool(context, id, { label: 'N', position: { x: 0, y: 0 }, typeId: 'kv' })
    ],
    [
      'update_node',
      (context: McpToolContext, id: string) => updateNodeTool(context, id, 'api', { label: 'X' })
    ],
    ['remove_node', (context: McpToolContext, id: string) => removeNodeTool(context, id, 'db')],
    [
      'add_edge',
      (context: McpToolContext, id: string) =>
        addEdgeTool(context, id, { edgeType: 'trigger', source: 'db', target: 'api' })
    ],
    [
      'update_edge',
      (context: McpToolContext, id: string) => updateEdgeTool(context, id, 'link', { label: 'x' })
    ],
    ['remove_edge', (context: McpToolContext, id: string) => removeEdgeTool(context, id, 'link')],
    ['auto_layout', (context: McpToolContext, id: string) => autoLayoutDiagramTool(context, id)]
  ])('logs %s as an MCP graph update', async (kind, run) => {
    const { context, entries } = createContext();
    const diagram = await seeded(context);
    entries.length = 0;

    await run(context, diagram.id);

    expect(entries).toEqual([
      { context: { diagramId: diagram.id, kind, via: 'mcp' }, event: 'diagram_updated' }
    ]);
  });

  it('pushes every mutation to the diagram’s live session', async () => {
    const { context, sessions } = createContext();
    const diagram = await seeded(context);
    sessions.notifications.length = 0;

    const result = await addNodeTool(context, diagram.id, {
      label: 'N',
      position: { x: 0, y: 0 },
      typeId: 'kv'
    });

    expect(sessions.notifications).toEqual([
      { diagramId: diagram.id, graphData: result.graphData, updatedAt: result.updatedAt }
    ]);
  });

  it('reports a mutation targeting something that does not exist', async () => {
    const { context } = createContext();
    const diagram = await seeded(context);

    await expectRejectedProblemStatus(removeNodeTool(context, diagram.id, 'ghost'), 404);
    await expectRejectedProblemStatus(removeEdgeTool(context, diagram.id, 'ghost'), 404);
    await expectRejectedProblemStatus(
      addEdgeTool(context, diagram.id, { edgeType: 'data-flow', source: 'api', target: 'ghost' }),
      404
    );
  });

  it('refuses a duplicate element id rather than corrupting the graph', async () => {
    const { context } = createContext();
    const diagram = await seeded(context);

    await expectRejectedProblemStatus(
      addNodeTool(context, diagram.id, {
        id: 'api',
        label: 'Clash',
        position: { x: 0, y: 0 },
        typeId: 'kv'
      }),
      400
    );
  });

  // Every graph tool is held to the same non-enumerating ownership rule the read tools are: a
  // diagram belonging to somebody else is reported exactly like one that does not exist.
  it.each([
    [
      'add_node',
      (context: McpToolContext, id: string) =>
        addNodeTool(context, id, { label: 'N', position: { x: 0, y: 0 }, typeId: 'kv' })
    ],
    [
      'update_node',
      (context: McpToolContext, id: string) => updateNodeTool(context, id, 'api', { label: 'X' })
    ],
    ['remove_node', (context: McpToolContext, id: string) => removeNodeTool(context, id, 'api')],
    [
      'add_edge',
      (context: McpToolContext, id: string) =>
        addEdgeTool(context, id, { edgeType: 'trigger', source: 'db', target: 'api' })
    ],
    [
      'update_edge',
      (context: McpToolContext, id: string) => updateEdgeTool(context, id, 'link', { label: 'x' })
    ],
    ['remove_edge', (context: McpToolContext, id: string) => removeEdgeTool(context, id, 'link')],
    ['auto_layout', (context: McpToolContext, id: string) => autoLayoutDiagramTool(context, id)]
  ])('refuses %s against a diagram owned by somebody else', async (_kind, run) => {
    const alice = createContext(ALICE);
    const mallory = createContext(MALLORY);
    const diagram = await seeded(alice.context);
    const before = await alice.diagrams.find(diagram.id);
    mallory.sessions.notifications.length = 0;

    await expectRejectedProblemStatus(run(mallory.context, diagram.id), 404);

    expect((await alice.diagrams.find(diagram.id))?.graphData).toBe(before?.graphData);
    expect(mallory.sessions.notifications).toEqual([]);
  });
});
