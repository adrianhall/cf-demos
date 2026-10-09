import { beforeEach, describe, expect, it } from 'vitest';
import { BLUEPRINTS } from '../../src/blueprints.ts';
import { DiagramService } from '../../src/worker/application/diagram-service.ts';
import type { Diagram, UpdateDiagramInput } from '../../src/worker/domain/diagram.ts';
import { DEFAULT_DIAGRAM_TITLE } from '../../src/worker/domain/diagram.ts';
import { EMPTY_GRAPH_DATA } from '../../src/worker/domain/graph.ts';
import { buildDiagramService } from './build-diagram-service.ts';
import { FakeDiagramRepository } from './fake-diagram-repository.ts';
import { FakeDiagramSessions } from './fake-diagram-sessions.ts';
import { FakeShareRepository } from './fake-share-repository.ts';
import { expectRejectedProblemStatus } from './problem-details.ts';

/**
 * @file Covers the diagram use cases against an in-memory port, which is the point of the port
 *   existing: the ownership rule and the validation order are business decisions, and they are
 *   asserted here without a database in the way. The assertions that matter most are the negative
 *   ones. A foreign diagram and an absent one must be indistinguishable in both status and detail,
 *   because anything that tells them apart lets a caller confirm that a guessed id belongs to
 *   somebody. The Workers-runtime suite proves the same outcomes through the real HTTP surface;
 *   these prove they come from the service rather than from a query that happens to be scoped.
 */

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

/**
 * A valid diagram id. Written out rather than generated so a failure message names a constant.
 */
const MISSING_ID = '11111111-1111-4111-8111-111111111111';

let repository: FakeDiagramRepository;
let service: DiagramService;

beforeEach(() => {
  repository = new FakeDiagramRepository();
  service = buildDiagramService(repository).service;
});

describe('creating a diagram', () => {
  it('seeds a blank canvas with the canonical empty graph and the default title', async () => {
    const diagram = await service.create(ALICE, {});

    expect(diagram).toMatchObject({
      description: null,
      graphData: EMPTY_GRAPH_DATA,
      ownerEmail: ALICE,
      title: DEFAULT_DIAGRAM_TITLE
    });
  });

  it('records the title and description the caller supplied', async () => {
    const diagram = await service.create(ALICE, { description: ' Notes ', title: ' My Diagram ' });

    expect(diagram).toMatchObject({ description: 'Notes', title: 'My Diagram' });
  });

  // The owner comes from the verified identity the route passed in, never from the body, so a
  // caller cannot create a diagram in somebody else's name.
  it('ignores an owner the caller tried to supply in the body', async () => {
    const diagram = await service.create(ALICE, { ownerEmail: BOB });

    expect(diagram.ownerEmail).toBe(ALICE);
  });

  it('seeds the graph from a named blueprint', async () => {
    const blueprint = BLUEPRINTS[0];
    const diagram = await service.create(ALICE, { blueprintId: blueprint?.id });

    expect(diagram.graphData).toBe(blueprint?.graphData);
  });

  // Refused before any write, so probing for template slugs leaves no half-created diagrams.
  it('refuses an unknown blueprint without writing anything', async () => {
    await expectRejectedProblemStatus(service.create(ALICE, { blueprintId: 'nope' }), 404);

    expect(repository.rows.size).toBe(0);
  });

  it('rejects an invalid body before writing anything', async () => {
    await expectRejectedProblemStatus(service.create(ALICE, { title: '' }), 422);

    expect(repository.rows.size).toBe(0);
  });
});

describe('listing diagrams', () => {
  it('returns only the actor\u2019s own diagrams, most recently updated first', async () => {
    const first = await service.create(ALICE, { title: 'First' });
    await service.create(ALICE, { title: 'Second' });
    await service.create(BOB, { title: "Bob's" });
    await service.updateMetadata(ALICE, first.id, { title: 'First (renamed)' });

    const listed = await service.list(ALICE);

    expect(listed.map((diagram) => diagram.title)).toEqual(['First (renamed)', 'Second']);
  });

  it('returns an empty list for an identity with no diagrams', async () => {
    await service.create(BOB, {});

    expect(await service.list(ALICE)).toEqual([]);
  });

  // The dashboard renders a real React Flow thumbnail per card, so a metadata-only projection
  // would cost one extra request per diagram to draw the page.
  it('includes each diagram\u2019s full graph for the dashboard thumbnails', async () => {
    const blueprint = BLUEPRINTS[0];
    await service.create(ALICE, { blueprintId: blueprint?.id });

    expect((await service.list(ALICE))[0]?.graphData).toBe(blueprint?.graphData);
  });
});

describe('owner isolation', () => {
  /**
   * Every use case that addresses a single diagram, as a callable taking an actor and an id.
   *
   * Driving them from one table is deliberate: the ownership rule lives in exactly one private
   * method, and a use case added later that bypasses it should fail here rather than need somebody
   * to remember to write the matching test.
   */
  const operations: [string, (actor: string, id: string) => Promise<unknown>][] = [
    ['get', (actor, id) => service.get(actor, id)],
    ['updateMetadata', (actor, id) => service.updateMetadata(actor, id, { title: 'Hijacked' })],
    [
      'saveGraph',
      (actor, id) => service.saveGraph(actor, id, { graphData: '{"nodes":[],"edges":[]}' })
    ],
    ['duplicate', (actor, id) => service.duplicate(actor, id)],
    ['remove', (actor, id) => service.remove(actor, id)]
  ];

  it.each(operations)('refuses %s for a diagram owned by another identity', async (_name, run) => {
    const diagram = await service.create(ALICE, { title: "Alice's" });

    await expectRejectedProblemStatus(run(BOB, diagram.id), 404);
  });

  it.each(operations)('refuses %s for a diagram that does not exist', async (_name, run) => {
    await expectRejectedProblemStatus(run(ALICE, MISSING_ID), 404);
  });

  it.each(operations)('refuses %s for a malformed diagram id', async (_name, run) => {
    await expectRejectedProblemStatus(run(ALICE, 'not-a-uuid'), 404);
  });

  // The refusal must not distinguish the three cases, or the response becomes an oracle for
  // whether a guessed id belongs to somebody.
  it('gives absent, foreign and malformed ids an identical refusal', async () => {
    const diagram = await service.create(ALICE, {});
    const details: unknown[] = [];

    for (const id of [diagram.id, MISSING_ID, 'not-a-uuid']) {
      try {
        await service.get(BOB, id);
      } catch (error) {
        details.push((error as { problemDetails: unknown }).problemDetails);
      }
    }

    expect(details).toHaveLength(3);
    expect(new Set(details.map((detail) => JSON.stringify(detail))).size).toBe(1);
  });

  // The refusal has to happen before the write, not merely instead of returning it.
  it('leaves a foreign diagram untouched after a refused update', async () => {
    const diagram = await service.create(ALICE, { title: 'Original' });

    await expectRejectedProblemStatus(
      service.updateMetadata(BOB, diagram.id, { title: 'Hijacked' }),
      404
    );

    expect((await service.get(ALICE, diagram.id)).title).toBe('Original');
  });

  it('leaves a foreign diagram in place after a refused delete', async () => {
    const diagram = await service.create(ALICE, {});

    await expectRejectedProblemStatus(service.remove(BOB, diagram.id), 404);

    expect(await service.get(ALICE, diagram.id)).toMatchObject({ id: diagram.id });
  });

  it('creates no copy when duplication is refused', async () => {
    const diagram = await service.create(ALICE, {});

    await expectRejectedProblemStatus(service.duplicate(BOB, diagram.id), 404);

    expect(repository.rows.size).toBe(1);
  });
});

describe('updating metadata', () => {
  it('renames a diagram the actor owns', async () => {
    const diagram = await service.create(ALICE, { title: 'Before' });

    expect(await service.updateMetadata(ALICE, diagram.id, { title: 'After' })).toMatchObject({
      title: 'After'
    });
  });

  it('clears a description when given an explicit null', async () => {
    const diagram = await service.create(ALICE, { description: 'Notes' });

    expect(await service.updateMetadata(ALICE, diagram.id, { description: null })).toMatchObject({
      description: null
    });
  });

  it('leaves the description alone when the property is omitted', async () => {
    const diagram = await service.create(ALICE, { description: 'Notes' });

    expect(await service.updateMetadata(ALICE, diagram.id, { title: 'Renamed' })).toMatchObject({
      description: 'Notes'
    });
  });

  // Validation runs first, so an invalid body cannot be used to learn whether an id exists.
  it('rejects an invalid body before looking the diagram up', async () => {
    await expectRejectedProblemStatus(service.updateMetadata(ALICE, MISSING_ID, {}), 422);
  });
});

describe('saving a graph', () => {
  it('replaces the graph and reports the new timestamp', async () => {
    const diagram = await service.create(ALICE, {});
    const graphData = JSON.stringify({
      edges: [],
      nodes: [{ id: 'n1' }],
      viewport: { x: 0, y: 0, zoom: 1 }
    });

    const updatedAt = await service.saveGraph(ALICE, diagram.id, { graphData });

    expect(updatedAt).not.toBe(diagram.updatedAt);
    // Compared as a decoded graph rather than as a string: canonicalisation fixes the key order,
    // and a caller's own ordering is not part of the contract.
    expect(JSON.parse((await service.get(ALICE, diagram.id)).graphData)).toEqual(
      JSON.parse(graphData)
    );
  });

  it('stores the canonical form, defaulting an omitted viewport', async () => {
    const diagram = await service.create(ALICE, {});

    await service.saveGraph(ALICE, diagram.id, { graphData: '{"nodes":[{"id":"n1"}]}' });

    expect(JSON.parse((await service.get(ALICE, diagram.id)).graphData)).toEqual({
      edges: [],
      nodes: [{ id: 'n1' }],
      viewport: { x: 0, y: 0, zoom: 1 }
    });
  });

  it('rejects a malformed graph before looking the diagram up', async () => {
    await expectRejectedProblemStatus(
      service.saveGraph(ALICE, MISSING_ID, { graphData: '{"nodes":[{}]}' }),
      422
    );
  });

  it('leaves the stored graph unchanged when the new one is invalid', async () => {
    const diagram = await service.create(ALICE, {});

    await expectRejectedProblemStatus(
      service.saveGraph(ALICE, diagram.id, { graphData: 'not json' }),
      422
    );

    expect((await service.get(ALICE, diagram.id)).graphData).toBe(EMPTY_GRAPH_DATA);
  });
});

describe('duplicating a diagram', () => {
  it('copies the graph and suffixes the title', async () => {
    const blueprint = BLUEPRINTS[0];
    const source = await service.create(ALICE, {
      blueprintId: blueprint?.id,
      description: 'Notes',
      title: 'Source'
    });

    const copy = await service.duplicate(ALICE, source.id);

    expect(copy).toMatchObject({
      description: 'Notes',
      graphData: source.graphData,
      ownerEmail: ALICE,
      title: 'Source (copy)'
    });
    expect(copy.id).not.toBe(source.id);
  });

  // A copy is independent from the moment it is made, exactly as a diagram created from a
  // blueprint is independent of the template.
  it('leaves the copy unaffected by a later change to the source', async () => {
    const source = await service.create(ALICE, { title: 'Source' });
    const copy = await service.duplicate(ALICE, source.id);

    await service.saveGraph(ALICE, source.id, { graphData: '{"nodes":[{"id":"later"}]}' });

    expect((await service.get(ALICE, copy.id)).graphData).toBe(EMPTY_GRAPH_DATA);
  });

  it('keeps the source diagram', async () => {
    const source = await service.create(ALICE, { title: 'Source' });

    await service.duplicate(ALICE, source.id);

    expect(await service.list(ALICE)).toHaveLength(2);
  });
});

describe('deleting a diagram', () => {
  it('removes a diagram the actor owns', async () => {
    const diagram = await service.create(ALICE, {});

    await service.remove(ALICE, diagram.id);

    await expectRejectedProblemStatus(service.get(ALICE, diagram.id), 404);
  });

  it('leaves other diagrams in place', async () => {
    const first = await service.create(ALICE, { title: 'First' });
    await service.create(ALICE, { title: 'Second' });

    await service.remove(ALICE, first.id);

    expect((await service.list(ALICE)).map((diagram) => diagram.title)).toEqual(['Second']);
  });
});

describe('concurrent removal between the ownership read and the write', () => {
  /**
   * A repository whose row vanishes after the ownership read, reproducing the same owner deleting a
   * diagram in a second tab. The service must answer `404` rather than treating the port's `null`
   * as a success.
   */
  class VanishingRepository extends FakeDiagramRepository {
    /**
     * @param id Diagram id.
     * @param input Validated fields.
     * @returns Always `null`, as though the row had just been deleted.
     */
    override async updateMetadata(id: string, input: UpdateDiagramInput): Promise<Diagram | null> {
      void id;
      void input;
      return null;
    }

    /**
     * @param id Diagram id.
     * @param graphData Canonical graph JSON.
     * @returns Always `null`, as though the row had just been deleted.
     */
    override async replaceGraph(id: string, graphData: string): Promise<string | null> {
      void id;
      void graphData;
      return null;
    }

    /**
     * @param id Diagram id.
     * @returns Always `false`, as though the row had just been deleted.
     */
    override async remove(id: string): Promise<boolean> {
      void id;
      return false;
    }
  }

  it.each([
    [
      'updateMetadata',
      (svc: DiagramService, id: string) => svc.updateMetadata(ALICE, id, { title: 'x' })
    ],
    [
      'saveGraph',
      (svc: DiagramService, id: string) => svc.saveGraph(ALICE, id, { graphData: '{}' })
    ],
    [
      'applyGraphOperation',
      (svc: DiagramService, id: string) =>
        svc.applyGraphOperation(ALICE, id, { kind: 'auto_layout' })
    ],
    ['remove', (svc: DiagramService, id: string) => svc.remove(ALICE, id)]
  ])('reports %s as not found when the row disappeared mid-request', async (_name, run) => {
    const vanishing = new VanishingRepository();
    const vanishingService = buildDiagramService(vanishing).service;
    const diagram = await vanishingService.create(ALICE, {});

    await expectRejectedProblemStatus(run(vanishingService, diagram.id), 404);
  });
});

describe('applying a graph operation', () => {
  /**
   * Creates a diagram owned by Alice carrying one node.
   *
   * @param svc Service to create through, so the fixture goes down the same path the application
   *   does rather than seeding a repository row the application could never have produced.
   * @returns The new diagram.
   */
  async function withOneNode(svc: DiagramService): Promise<Diagram> {
    const diagram = await svc.create(ALICE, {});
    await svc.saveGraph(ALICE, diagram.id, {
      graphData: JSON.stringify({
        edges: [],
        nodes: [{ data: { label: 'API' }, id: 'api', position: { x: 0, y: 0 }, type: 'cf-node' }],
        viewport: { x: 0, y: 0, zoom: 1 }
      })
    });
    return diagram;
  }

  it('applies the operation and returns the diagram carrying the new graph', async () => {
    const diagram = await withOneNode(service);

    const result = await service.applyGraphOperation(ALICE, diagram.id, {
      input: { label: 'DB', position: { x: 0, y: 200 }, typeId: 'd1' },
      kind: 'add_node'
    });

    expect((JSON.parse(result.graphData) as { nodes: { id: string }[] }).nodes).toEqual([
      expect.objectContaining({ id: 'api' }),
      expect.objectContaining({ data: expect.objectContaining({ label: 'DB' }) })
    ]);
  });

  it('reports the new timestamp, so a caller sees its own change without a second read', async () => {
    const diagram = await withOneNode(service);

    const result = await service.applyGraphOperation(ALICE, diagram.id, { kind: 'auto_layout' });

    expect(result.updatedAt > diagram.updatedAt).toBe(true);
  });

  // The whole point of the port change: the service hands the operation over and keeps nothing
  // back. A service that still applied the mutation itself would make everything above it a
  // second writer, which is exactly the race this phase removes.
  it('writes through the session rather than to the repository itself', async () => {
    const sessions = new FakeDiagramSessions(repository);
    const svc = buildDiagramService(repository, new FakeShareRepository(), sessions).service;
    const diagram = await withOneNode(svc);

    const result = await svc.applyGraphOperation(ALICE, diagram.id, { kind: 'auto_layout' });

    expect(sessions.notifications).toEqual([
      { diagramId: diagram.id, graphData: result.graphData, updatedAt: result.updatedAt }
    ]);
    // What the caller was told is what storage holds, which is the observable half of
    // persist-before-broadcast. The ordering itself is asserted against the real object in
    // `../integration/live-sync.test.ts`, where there is a real socket to observe it on.
    expect((await repository.find(diagram.id))?.graphData).toBe(result.graphData);
  });

  // A refusal must leave the stored diagram untouched, and it must arrive as the problem document
  // every transport already answers with — the session reports it as a value precisely because a
  // thrown status would not survive the RPC boundary, and this is where that is undone.
  it.each([
    ['a stale node', { kind: 'remove_node', nodeId: 'ghost' } as const, 404],
    [
      'a duplicate node id',
      {
        input: { id: 'api', label: 'x', position: { x: 0, y: 0 }, typeId: 'worker' },
        kind: 'add_node'
      } as const,
      400
    ],
    ['a stale edge', { edgeId: 'ghost', kind: 'remove_edge' } as const, 404]
  ])(
    'refuses %s with %i, writing nothing and notifying nobody',
    async (_label, operation, status) => {
      const sessions = new FakeDiagramSessions(repository);
      const svc = buildDiagramService(repository, new FakeShareRepository(), sessions).service;
      const diagram = await withOneNode(svc);
      const before = await repository.find(diagram.id);

      await expectRejectedProblemStatus(
        svc.applyGraphOperation(ALICE, diagram.id, operation),
        status
      );

      expect((await repository.find(diagram.id))?.graphData).toBe(before?.graphData);
      expect(sessions.notifications).toEqual([]);
    }
  );

  // A storage failure must not be reported as success, and must not leak the underlying error's
  // own text — which can name a table or a query — into a response.
  it('reports a failed persist as a server fault, and pushes nothing', async () => {
    const sessions = new FakeDiagramSessions(repository);
    const svc = buildDiagramService(repository, new FakeShareRepository(), sessions).service;
    const diagram = await withOneNode(svc);
    sessions.persistError = new Error('D1_ERROR: no such table: diagrams');

    await expectRejectedProblemStatus(
      svc.applyGraphOperation(ALICE, diagram.id, { kind: 'auto_layout' }),
      500
    );
    expect(sessions.notifications).toEqual([]);
  });

  it.each([
    ['a foreign diagram', async () => (await service.create(BOB, {})).id],
    ['an absent diagram', () => Promise.resolve(MISSING_ID)],
    ['a malformed id', () => Promise.resolve('not-a-uuid')]
  ])('refuses %s with the uniform 404 and never mutates', async (_label, resolveId) => {
    const sessions = new FakeDiagramSessions(repository);
    const svc = buildDiagramService(repository, new FakeShareRepository(), sessions).service;

    await expectRejectedProblemStatus(
      svc.applyGraphOperation(ALICE, await resolveId(), { kind: 'auto_layout' }),
      404
    );
    expect(sessions.notifications).toEqual([]);
  });
});

describe('connecting a live session', () => {
  it('forwards the upgrade once ownership is established', async () => {
    const sessions = new FakeDiagramSessions(repository);
    const svc = buildDiagramService(repository, new FakeShareRepository(), sessions).service;
    const diagram = await svc.create(ALICE, {});

    // What this asserts is that the service resolved the right diagram and reached the port at
    // all. The real `101` and its socket are covered against `workerd` in
    // `../integration/live-sync.test.ts`, because Node can construct neither.
    await svc.connectLiveSession(
      ALICE,
      diagram.id,
      new Request('https://diagrams.test/api/diagrams/x/live', {
        headers: { Upgrade: 'websocket' }
      })
    );

    expect(sessions.connections).toEqual([{ diagramId: diagram.id, viewer: ALICE }]);
  });

  // The identity the session pins comes from the verified actor the service was given, never
  // from the request — so there is nothing on the wire that could influence it.
  it('pins the verified actor rather than anything on the request', async () => {
    const sessions = new FakeDiagramSessions(repository);
    const svc = buildDiagramService(repository, new FakeShareRepository(), sessions).service;
    const diagram = await svc.create(ALICE, {});

    await svc.connectLiveSession(
      ALICE,
      diagram.id,
      new Request('https://diagrams.test/api/diagrams/x/live', {
        headers: { 'Upgrade': 'websocket', 'X-Architect-Identity': BOB }
      })
    );

    expect(sessions.connections[0]?.viewer).toBe(ALICE);
  });

  it.each([
    ['a foreign diagram', async () => (await service.create(BOB, {})).id],
    ['an absent diagram', () => Promise.resolve(MISSING_ID)],
    ['a malformed id', () => Promise.resolve('not-a-uuid')]
  ])('refuses %s before the session is ever reached', async (_label, resolveId) => {
    const sessions = new FakeDiagramSessions(repository);
    const svc = buildDiagramService(repository, new FakeShareRepository(), sessions).service;

    await expectRejectedProblemStatus(
      svc.connectLiveSession(
        ALICE,
        await resolveId(),
        new Request('https://diagrams.test/api/diagrams/x/live', {
          headers: { Upgrade: 'websocket' }
        })
      ),
      404
    );
    expect(sessions.connections).toEqual([]);
  });
});
