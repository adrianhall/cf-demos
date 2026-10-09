import { describe, expect, it, vi } from 'vitest';
import { ShareService } from '../../src/worker/application/share-service.ts';
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
import { buildDiagramService } from './build-diagram-service.ts';
import { FakeDiagramRepository } from './fake-diagram-repository.ts';
import { FakeShareRepository } from './fake-share-repository.ts';

/**
 * @file What the MCP surface writes to an operational log, asserted across the **whole** tool
 *   catalogue rather than one tool at a time. `./share-logging.test.ts` makes the same claim for
 *   the HTTP share routes, and the reasoning is identical: a log is not a store, so no amount of
 *   inspecting D1 or KV would catch a `logger.info('diagram_shared', { token })`, and logs are
 *   precisely where a bearer credential does the most damage, because they are shipped to an
 *   observability backend, retained, and read by people who have no business holding a live share
 *   link. What is new here is the breadth. The MCP surface is sixteen tools that between them see a
 *   raw share token, a diagram's whole graph and the caller's email address, and each of them calls
 *   the logger independently. A per-tool assertion would prove sixteen separate facts and miss the
 *   seventeenth tool somebody adds; this file instead drives every tool in the catalogue and makes
 *   one statement about everything they logged. The recording logger is the only level at which
 *   "what was logged" is observable at all — the Workers-runtime suite's logger writes to a capture
 *   transport a test cannot read back.
 */

/**
 * The verified identity every tool call below is made as.
 */
const ALICE = 'alice@example.com';

/**
 * Fictional origin the share tools resolve their link against.
 */
const ORIGIN = 'https://diagrams.test/mcp';

/**
 * A graph with recognisable content, so a leak of graph material into a log is identifiable rather
 * than merely plausible.
 *
 * Every string in it is a nonsense token that could not occur by coincidence, which is what lets
 * the assertions below search for it rather than reason about what "graph content" means.
 */
const SECRET_GRAPH = JSON.stringify({
  edges: [
    {
      data: { edgeType: 'service-binding', label: 'EDGELABELNEVERLOGGED' },
      id: 'link',
      source: 'api',
      target: 'store',
      type: 'cf-edge'
    }
  ],
  nodes: [
    {
      data: {
        description: 'DESCRIPTIONNEVERLOGGED',
        label: 'NODELABELNEVERLOGGED',
        typeId: 'worker'
      },
      id: 'api',
      position: { x: 0, y: 0 },
      type: 'cf-node'
    },
    {
      data: { label: 'STORENEVERLOGGED', typeId: 'd1' },
      id: 'store',
      position: { x: 0, y: 200 },
      type: 'cf-node'
    }
  ],
  viewport: { x: 0, y: 0, zoom: 1 }
});

/**
 * Every distinctive string from {@link SECRET_GRAPH} that must never reach a log.
 */
const GRAPH_SECRETS = [
  'NODELABELNEVERLOGGED',
  'DESCRIPTIONNEVERLOGGED',
  'STORENEVERLOGGED',
  'EDGELABELNEVERLOGGED'
];

/**
 * One recorded structured log event.
 */
interface LogEntry {
  /**
   * Event name the tool emitted.
   */
  event: string;
  /**
   * Structured fields it attached.
   */
  context: Record<string, unknown>;
}

/**
 * Drives every tool in the catalogue once, against one diagram, recording everything logged.
 *
 * The sequence is ordered so each tool has something to act on and the fixture stays consistent:
 * create, fill, mutate, share, export, revoke, delete. Running the whole catalogue in one pass is
 * the point — the claim is about the surface, not about any one tool.
 *
 * @returns Everything logged, the raw share token that was minted, and the console calls made.
 */
async function exerciseEveryTool(): Promise<{
  consoleCalls: unknown[][];
  entries: LogEntry[];
  token: string;
}> {
  const entries: LogEntry[] = [];
  const shareRepository = new FakeShareRepository();
  const diagramService = buildDiagramService(new FakeDiagramRepository(), shareRepository).service;
  const context: McpToolContext = {
    actorEmail: ALICE,
    diagrams: diagramService,
    logger: {
      info(event: string, logContext?: Record<string, unknown>): void {
        entries.push({ context: logContext ?? {}, event });
      }
    },
    requestUrl: ORIGIN,
    shares: new ShareService(shareRepository, diagramService)
  };

  const spies = (['debug', 'error', 'info', 'log', 'warn'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined)
  );

  try {
    const diagram = await createDiagramTool(context, {
      description: 'DESCRIPTIONNEVERLOGGED',
      title: 'NODELABELNEVERLOGGED'
    });
    const diagramId = diagram.id;

    // Seeded through the service's own autosave path rather than a tool, so the graph is in place
    // before the graph tools run and every one of them has nodes and edges to act on. It is also
    // the browser's path, which means the graph reaching the log would be a leak either transport
    // could have caused.
    await diagramService.saveGraph(ALICE, diagramId, { graphData: SECRET_GRAPH });

    await listDiagramsTool(context);
    await getDiagramTool(context, diagramId);
    await renameDiagramTool(context, diagramId, { title: 'STORENEVERLOGGED' });
    await addNodeTool(context, diagramId, {
      id: 'cache',
      label: 'NODELABELNEVERLOGGED',
      position: { x: 400, y: 0 },
      typeId: 'kv'
    });
    await updateNodeTool(context, diagramId, 'cache', { label: 'EDGELABELNEVERLOGGED' });
    await addEdgeTool(context, diagramId, {
      edgeType: 'data-flow',
      id: 'cache-link',
      label: 'EDGELABELNEVERLOGGED',
      source: 'api',
      target: 'cache'
    });
    await updateEdgeTool(context, diagramId, 'cache-link', { label: 'STORENEVERLOGGED' });
    await removeEdgeTool(context, diagramId, 'cache-link');
    await removeNodeTool(context, diagramId, 'cache');
    await autoLayoutDiagramTool(context, diagramId);

    const share = await createShareLinkTool(context, diagramId);
    await getShareStatusTool(context, diagramId);
    await exportDiagramTool(context, diagramId, 'json');
    await exportDiagramTool(context, diagramId, 'scaffold');
    await revokeShareLinkTool(context, diagramId);
    await deleteDiagramTool(context, diagramId);

    return {
      consoleCalls: spies.flatMap((spy) => spy.mock.calls as unknown[][]),
      entries,
      token: share.token
    };
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
}

describe('what the MCP surface writes to a log', () => {
  it('never writes the raw share token, on any tool', async () => {
    const { consoleCalls, entries, token } = await exerciseEveryTool();

    // A sanity check on the fixture itself: a token that was never minted could not appear in a
    // log either, and an assertion that passes for that reason proves nothing.
    expect(token).toMatch(/^[A-Za-z0-9_-]{16,}$/u);
    expect(JSON.stringify(entries)).not.toContain(token);
    expect(JSON.stringify(consoleCalls)).not.toContain(token);
  });

  // Graph content is not a credential, but it is the user's own architecture, and an operator
  // reading Workers Logs to answer "did an agent or a person change this" has no business being
  // shown what was drawn. A diagram id answers the operational question; the graph does not.
  it('never writes graph content, on any tool', async () => {
    const { consoleCalls, entries } = await exerciseEveryTool();
    const logged = JSON.stringify(entries);
    const printed = JSON.stringify(consoleCalls);

    for (const secret of GRAPH_SECRETS) {
      expect(logged, `structured log containing ${secret}`).not.toContain(secret);
      expect(printed, `console output containing ${secret}`).not.toContain(secret);
    }
    expect(logged).not.toContain('graphData');
  });

  // The caller's email is personal data and is also the ownership key, so a log carrying it is
  // both a privacy question and a map of who owns what. The diagram id is sufficient: an operator
  // who genuinely needs the owner can look the row up, which is an auditable act rather than a
  // side effect of reading a log.
  it('never writes the caller’s email address, on any tool', async () => {
    const { consoleCalls, entries } = await exerciseEveryTool();

    expect(JSON.stringify(entries)).not.toContain(ALICE);
    expect(JSON.stringify(consoleCalls)).not.toContain(ALICE);
  });

  // The positive half, without which every assertion above could be satisfied by logging nothing
  // at all. The surface does log — by diagram id, with `via: 'mcp'` on every event — because that
  // is exactly what lets a presenter show an agent's edit apart from a browser's in Workers Logs.
  it('does log every mutation by diagram id, tagged as the MCP transport', async () => {
    const { entries } = await exerciseEveryTool();

    expect(entries.map((entry) => entry.event)).toEqual([
      'diagram_created',
      'diagram_opened',
      'diagram_updated',
      'diagram_updated',
      'diagram_updated',
      'diagram_updated',
      'diagram_updated',
      'diagram_updated',
      'diagram_updated',
      'diagram_updated',
      'diagram_shared',
      'diagram_share_revoked',
      'diagram_deleted'
    ]);
    for (const entry of entries) {
      expect(entry.context, entry.event).toMatchObject({
        diagramId: expect.any(String) as string,
        via: 'mcp'
      });
    }
  });
});
