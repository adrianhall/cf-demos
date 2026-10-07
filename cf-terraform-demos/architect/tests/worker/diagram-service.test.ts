import { beforeEach, describe, expect, it } from 'vitest';
import { BLUEPRINTS } from '../../src/blueprints.ts';
import { DiagramService } from '../../src/worker/application/diagram-service.ts';
import type { Diagram, UpdateDiagramInput } from '../../src/worker/domain/diagram.ts';
import { DEFAULT_DIAGRAM_TITLE } from '../../src/worker/domain/diagram.ts';
import { EMPTY_GRAPH_DATA } from '../../src/worker/domain/graph.ts';
import { FakeDiagramRepository } from './fake-diagram-repository.ts';
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
  service = new DiagramService(repository, new FakeShareRepository(repository));
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
    ['remove', (svc: DiagramService, id: string) => svc.remove(ALICE, id)]
  ])('reports %s as not found when the row disappeared mid-request', async (_name, run) => {
    const vanishing = new VanishingRepository();
    const vanishingService = new DiagramService(vanishing, new FakeShareRepository(vanishing));
    const diagram = await vanishingService.create(ALICE, {});

    await expectRejectedProblemStatus(run(vanishingService, diagram.id), 404);
  });
});
