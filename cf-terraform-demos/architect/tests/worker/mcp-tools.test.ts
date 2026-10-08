import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { DiagramService } from '../../src/worker/application/diagram-service.ts';
import { ShareService } from '../../src/worker/application/share-service.ts';
import type { Diagram } from '../../src/worker/domain/diagram.ts';
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
 * Origin the share tools resolve their returned link against.
 *
 * Fictional on purpose: it is never a live deployment, so no assertion here can be satisfied by —
 * or reach — a real host. The real value comes from the request being served.
 */
const ORIGIN = 'https://diagrams.test/mcp';

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
 * @returns The context, backing repositories, recording session port, and captured log events.
 */
function createContext(actorEmail: string = ALICE): {
  context: McpToolContext;
  diagrams: FakeDiagramRepository;
  entries: LogEntry[];
  sessions: FakeDiagramSessions;
  shares: FakeShareRepository;
} {
  const diagrams = new FakeDiagramRepository();
  const shares = new FakeShareRepository();
  const sessions = new FakeDiagramSessions();
  const entries: LogEntry[] = [];
  const diagramService = new DiagramService(diagrams, shares, sessions);

  const context: McpToolContext = {
    actorEmail,
    diagrams: diagramService,
    logger: {
      info(event: string, logContext?: Record<string, unknown>): void {
        entries.push({ context: logContext ?? {}, event });
      }
    },
    requestUrl: ORIGIN,
    shares: new ShareService(shares, diagramService)
  };

  return { context, diagrams, entries, sessions, shares };
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

describe('MCP share tools', () => {
  it('mints a link, resolves it against the request origin and logs only the diagram id', async () => {
    const { context, entries } = createContext();
    const diagram = await createFixture(context, 'Shared');
    entries.length = 0;

    const share = await createShareLinkTool(context, diagram.id);

    expect(share.url).toBe(`https://diagrams.test/s/${share.token}`);
    expect(share.createdAt).toEqual(expect.any(String));
    expect(entries).toEqual([
      { context: { diagramId: diagram.id, via: 'mcp' }, event: 'diagram_shared' }
    ]);
    expect(JSON.stringify(entries)).not.toContain(share.token);
  });

  // The rule the whole sharing design rests on: a token is disclosed by the call that mints it
  // and by nothing else, ever. Only its digest is stored, so there is no second response, no
  // second tool and no retry that could produce it again — which is also why a lost link can only
  // be replaced, never recovered.
  it('discloses the raw token exactly once and never again', async () => {
    const { context, shares } = createContext();
    const diagram = await createFixture(context, 'Shared');

    const share = await createShareLinkTool(context, diagram.id);

    const status = await getShareStatusTool(context, diagram.id);
    expect(status).toEqual({ active: true, createdAt: share.createdAt });
    expect(JSON.stringify(status)).not.toContain(share.token);

    // Nothing the repository holds carries the plaintext either, so no later read of any kind
    // could reconstruct it — the digest really is all that was kept.
    expect(JSON.stringify([...shares.rows, ...shares.lookup])).not.toContain(share.token);

    // Every other tool that returns the diagram is checked too, because a token leaking through
    // an unrelated payload would defeat the rule just as completely.
    const read = await getDiagramTool(context, diagram.id);
    const listed = await listDiagramsTool(context);
    const exported = await exportDiagramTool(context, diagram.id, 'json');
    expect(JSON.stringify([read, listed, exported])).not.toContain(share.token);
  });

  it('rotates, so a second link revokes the first', async () => {
    const { context } = createContext();
    const diagram = await createFixture(context, 'Shared');

    const first = await createShareLinkTool(context, diagram.id);
    const second = await createShareLinkTool(context, diagram.id);

    expect(second.token).not.toBe(first.token);
    await expect(context.shares.resolve(second.token)).resolves.toMatchObject({ id: diagram.id });
    await expectRejectedProblemStatus(context.shares.resolve(first.token), 404);
  });

  it('reports no active link before one is minted', async () => {
    const { context } = createContext();
    const diagram = await createFixture(context, 'Unshared');

    await expect(getShareStatusTool(context, diagram.id)).resolves.toEqual({
      active: false,
      createdAt: null
    });
  });

  it('revokes an active link, logs it without the token, and refuses a second revocation', async () => {
    const { context, entries } = createContext();
    const diagram = await createFixture(context, 'Shared');
    const share = await createShareLinkTool(context, diagram.id);
    entries.length = 0;

    await revokeShareLinkTool(context, diagram.id);

    expect(entries).toEqual([
      { context: { diagramId: diagram.id, via: 'mcp' }, event: 'diagram_share_revoked' }
    ]);
    expect(JSON.stringify(entries)).not.toContain(share.token);
    await expect(getShareStatusTool(context, diagram.id)).resolves.toEqual({
      active: false,
      createdAt: null
    });
    // Revoking nothing is refused rather than succeeding quietly, exactly as the REST route
    // refuses it: the caller asked about a link that is not there.
    await expectRejectedProblemStatus(revokeShareLinkTool(context, diagram.id), 404);
  });

  // The whole catalogue is held to one non-enumerating rule, and sharing is where getting it
  // wrong would be worst: a `403` here would confirm that a guessed id is somebody's real
  // diagram, and the tool that follows mints a live link to it.
  it.each([
    ['create_share_link', createShareLinkTool],
    ['get_share_status', getShareStatusTool],
    ['revoke_share_link', revokeShareLinkTool]
  ])('refuses %s against a diagram owned by somebody else', async (_name, run) => {
    const alice = createContext(ALICE);
    const mallory = createContext(MALLORY);
    const diagram = await createFixture(alice.context, 'Alice only');
    await createShareLinkTool(alice.context, diagram.id);

    await expectRejectedProblemStatus(run(mallory.context, diagram.id), 404);

    // Still active: a refused revocation must not have reached the store on its way to the
    // refusal.
    await expect(getShareStatusTool(alice.context, diagram.id)).resolves.toMatchObject({
      active: true
    });
  });

  it('reports a foreign and an absent diagram identically', async () => {
    const alice = createContext(ALICE);
    const mallory = createContext(MALLORY);
    const diagram = await createFixture(alice.context, 'Alice only');

    const messages = await Promise.all(
      [diagram.id, '11111111-1111-4111-8111-111111111111'].map(async (id) => {
        try {
          await createShareLinkTool(mallory.context, id);
          return 'unexpected success';
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      })
    );

    expect(messages).toEqual(['Diagram not found.', 'Diagram not found.']);
  });

  // Belt and braces against the structured logger being bypassed entirely. A token written
  // straight to the console would never appear in `entries`, and the console is shipped to the
  // same observability backend the logger is.
  it('writes no token to the console', async () => {
    const spies = (['debug', 'error', 'info', 'log', 'warn'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {})
    );

    try {
      const { context } = createContext();
      const diagram = await createFixture(context, 'Shared');
      const share = await createShareLinkTool(context, diagram.id);

      await getShareStatusTool(context, diagram.id);
      await revokeShareLinkTool(context, diagram.id);

      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(share.token);
        }
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});

describe('MCP export tool', () => {
  /**
   * A graph with one Worker and one D1 database, so the generated project has both an entry point
   * and a binding to assert.
   */
  const EXPORTABLE_GRAPH = JSON.stringify({
    edges: [{ data: { edgeType: 'service-binding' }, id: 'link', source: 'api', target: 'store' }],
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

  /**
   * Creates a diagram carrying {@link EXPORTABLE_GRAPH}.
   *
   * @param context Tool context whose identity will own it.
   * @param title Title to give it, which becomes the generated project's name.
   * @returns The seeded diagram.
   */
  async function exportable(context: McpToolContext, title = 'Billing Service'): Promise<Diagram> {
    const diagram = await createDiagramTool(context, { title });
    await context.diagrams.saveGraph(context.actorEmail, diagram.id, {
      graphData: EXPORTABLE_GRAPH
    });
    return diagram;
  }

  /**
   * Decodes a base64 scaffold export back into its files.
   *
   * @param data Base64 ZIP bytes as the tool returned them.
   * @returns File path to file contents.
   */
  function unpack(data: string): Map<string, string> {
    const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));

    return new Map(
      Object.entries(unzipSync(bytes)).map(([path, contents]) => [path, strFromU8(contents)])
    );
  }

  // Asserted against the stored row rather than against the fixture text: the application
  // canonicalises on every write, so "verbatim" means byte-identical to what is in storage, not
  // to whatever key order the caller happened to send.
  it('returns the stored graph verbatim as JSON', async () => {
    const { context, diagrams } = createContext();
    const diagram = await exportable(context);
    const stored = await diagrams.find(diagram.id);

    const exported = await exportDiagramTool(context, diagram.id, 'json');

    expect(exported).toEqual({
      data: stored?.graphData,
      format: 'json',
      mimeType: 'application/json'
    });
    expect(JSON.parse(exported.data)).toEqual(JSON.parse(EXPORTABLE_GRAPH));
  });

  it('returns SVG as XML text named after the diagram', async () => {
    const { context } = createContext();
    const diagram = await exportable(context, 'Billing & <Storage>');

    const exported = await exportDiagramTool(context, diagram.id, 'svg');

    expect(exported.format).toBe('svg');
    expect(exported.mimeType).toBe('image/svg+xml');
    expect(exported.data).toContain('<title>Billing &amp; &lt;Storage&gt;</title>');
    expect(exported.data).toContain('Edge API');
    expect(exported.data).toContain('User Data');
    expect(exported.data).toContain('stroke-dasharray="8 4"');
  });

  it('zips the same project the editor’s own export button generates', async () => {
    const { context } = createContext();
    const diagram = await exportable(context);

    const exported = await exportDiagramTool(context, diagram.id, 'scaffold');
    const files = unpack(exported.data);

    expect(exported.format).toBe('scaffold');
    expect(exported.mimeType).toBe('application/zip');
    expect([...files.keys()].sort()).toEqual([
      'README.md',
      'cloudflare.config.ts',
      'drizzle.config.ts',
      'migrations/0001_initial.sql',
      'package.json',
      'src/db/client.ts',
      'src/db/schema.ts',
      'src/index.ts',
      'tsconfig.json'
    ]);
    // The diagram's own vocabulary reaches the generated project: the title becomes the Worker
    // name and the node's label becomes its binding.
    expect(files.get('cloudflare.config.ts')).toContain("'billing-service'");
    expect(files.get('cloudflare.config.ts')).toContain('USER_DATA: bindings.d1(');
    // `cf`-native, not Wrangler — the same deliberate departure the browser export makes.
    expect(files.get('cloudflare.config.ts')).toContain("from 'cf/config'");
  });

  // The server cannot know a node's shape — `../domain/graph.ts` validates only that each element
  // has a non-empty string id — so a graph the editor has not written must not crash an export.
  it('skips graph elements that carry no catalogue type or label', async () => {
    const { context } = createContext();
    const diagram = await createDiagramTool(context, { title: 'Sparse' });
    await context.diagrams.saveGraph(context.actorEmail, diagram.id, {
      graphData: JSON.stringify({
        edges: [{ id: 'dangling' }],
        nodes: [
          { id: 'bare' },
          { data: { label: 'Mystery', typeId: 'not-a-product' }, id: 'unknown' },
          { data: { label: 'API', typeId: 'worker' }, id: 'api' }
        ]
      })
    });

    const files = unpack((await exportDiagramTool(context, diagram.id, 'scaffold')).data);

    expect(files.has('cloudflare.config.ts')).toBe(true);
    expect(files.get('cloudflare.config.ts')).not.toContain('Mystery');
  });

  // An empty archive rather than an error: a diagram of nothing but external actors has no
  // Cloudflare service to configure, which is a fact about the diagram and not a failure.
  it('produces an empty archive for a diagram with nothing to provision', async () => {
    const { context } = createContext();
    const diagram = await createFixture(context, 'Empty');

    const exported = await exportDiagramTool(context, diagram.id, 'scaffold');

    expect(unpack(exported.data).size).toBe(0);
  });

  it.each(['json', 'scaffold', 'svg'] as const)(
    'refuses a %s export of a diagram owned by somebody else',
    async (format) => {
      const alice = createContext(ALICE);
      const mallory = createContext(MALLORY);
      const diagram = await exportable(alice.context);

      await expectRejectedProblemStatus(
        exportDiagramTool(mallory.context, diagram.id, format),
        404
      );
      await expectRejectedProblemStatus(
        exportDiagramTool(mallory.context, '11111111-1111-4111-8111-111111111111', format),
        404
      );
    }
  );

  // Reading is not an event: there is no state change to correlate, and the only distinguishing
  // value would be the exported content itself.
  it('logs nothing at all', async () => {
    const { context, entries } = createContext();
    const diagram = await exportable(context);
    entries.length = 0;

    await exportDiagramTool(context, diagram.id, 'json');
    await exportDiagramTool(context, diagram.id, 'svg');
    await exportDiagramTool(context, diagram.id, 'scaffold');

    expect(entries).toEqual([]);
  });
});
