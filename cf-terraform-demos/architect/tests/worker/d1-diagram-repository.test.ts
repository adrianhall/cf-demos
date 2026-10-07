import { describe, expect, it, vi } from 'vitest';
import { D1DiagramRepository } from '../../src/worker/infrastructure/d1-diagram-repository.ts';
import { createFakeD1 } from './fake-d1.ts';

/**
 * @file Covers the D1 diagram adapter's statements and row mapping. The adapter is deliberately
 *   authorization-neutral — the ownership rule lives in the application service — so these tests
 *   assert the opposite of what a sibling demo's repository tests assert: not that every statement
 *   is owner-scoped, but that the adapter binds its values as parameters, maps D1's column names
 *   onto the domain shape, and reports "no row matched" honestly so the service above it can turn
 *   that into the uniform `404`.
 */

const OWNER = 'alice@example.com';
const DIAGRAM_ID = '11111111-1111-4111-8111-111111111111';

/**
 * A stored row as D1 returns it, in snake_case.
 */
const STORED_ROW = {
  created_at: '2026-01-01T00:00:00.000Z',
  description: 'Notes',
  graph_data: '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}',
  id: DIAGRAM_ID,
  owner_email: OWNER,
  title: 'My Diagram',
  updated_at: '2026-01-02T00:00:00.000Z'
};

/**
 * The same row in the domain vocabulary the adapter must produce.
 */
const MAPPED_DIAGRAM = {
  createdAt: '2026-01-01T00:00:00.000Z',
  description: 'Notes',
  graphData: '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}',
  id: DIAGRAM_ID,
  ownerEmail: OWNER,
  title: 'My Diagram',
  updatedAt: '2026-01-02T00:00:00.000Z'
};

describe('parameter binding', () => {
  // Every value reaches D1 as a bound parameter, never as interpolated SQL. Asserted rather than
  // reviewed, because the cost of getting it wrong is the whole table.
  it('binds hostile values as parameters rather than interpolating them', async () => {
    const injection = "'; DROP TABLE diagrams; --";
    const fake = createFakeD1({ firstRows: [STORED_ROW], changes: 1 });
    const repository = new D1DiagramRepository(fake.database);

    await repository.create(injection, { title: injection }, '{}');
    await repository.find(injection);
    await repository.listByOwner(injection);
    await repository.updateMetadata(injection, { title: injection });
    await repository.replaceGraph(injection, injection);
    await repository.remove(injection);

    expect(fake.statements).not.toHaveLength(0);
    for (const statement of fake.statements) {
      expect(statement.sql).not.toContain('DROP TABLE');
      expect(statement.parameters).toContain(injection);
    }
  });
});

describe('create', () => {
  it('generates the id and both timestamps rather than trusting a caller', async () => {
    const fake = createFakeD1();
    const repository = new D1DiagramRepository(fake.database);

    const diagram = await repository.create(OWNER, { title: 'My Diagram' }, '{}');

    expect(diagram.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(diagram.createdAt).toBe(diagram.updatedAt);
    expect(fake.statements[0]?.parameters).toContain(diagram.id);
  });

  it('records the verified owner the service passed in', async () => {
    const fake = createFakeD1();
    const repository = new D1DiagramRepository(fake.database);

    const diagram = await repository.create(OWNER, {}, '{}');

    expect(diagram.ownerEmail).toBe(OWNER);
    expect(fake.statements[0]?.parameters).toContain(OWNER);
  });

  it('defaults an omitted title and description', async () => {
    const repository = new D1DiagramRepository(createFakeD1().database);

    expect(await repository.create(OWNER, {}, '{}')).toMatchObject({
      description: null,
      title: 'Untitled Diagram'
    });
  });

  it('stores the graph it was given verbatim', async () => {
    const graphData = '{"nodes":[{"id":"n1"}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}';
    const fake = createFakeD1();
    const repository = new D1DiagramRepository(fake.database);

    const diagram = await repository.create(OWNER, {}, graphData);

    expect(diagram.graphData).toBe(graphData);
    expect(fake.statements[0]?.parameters).toContain(graphData);
  });
});

describe('find', () => {
  it('maps a stored row onto the domain shape', async () => {
    const repository = new D1DiagramRepository(createFakeD1({ firstRows: [STORED_ROW] }).database);

    expect(await repository.find(DIAGRAM_ID)).toEqual(MAPPED_DIAGRAM);
  });

  it('returns null when no row has that id', async () => {
    const repository = new D1DiagramRepository(createFakeD1().database);

    expect(await repository.find(DIAGRAM_ID)).toBeNull();
  });

  // Owner-blind by design: the application service needs the owner in order to make the access
  // decision, so a query that filtered here would move the rule somewhere a second transport
  // could bypass.
  it('selects by id alone and returns the owner for the service to judge', async () => {
    const fake = createFakeD1({ firstRows: [STORED_ROW] });
    const repository = new D1DiagramRepository(fake.database);

    const diagram = await repository.find(DIAGRAM_ID);

    expect(fake.statements[0]?.sql).not.toContain('owner_email = ?');
    expect(fake.statements[0]?.parameters).toEqual([DIAGRAM_ID]);
    expect(diagram?.ownerEmail).toBe(OWNER);
  });

  it('preserves a null description rather than coercing it to a string', async () => {
    const repository = new D1DiagramRepository(
      createFakeD1({ firstRows: [{ ...STORED_ROW, description: null }] }).database
    );

    expect((await repository.find(DIAGRAM_ID))?.description).toBeNull();
  });
});

describe('listByOwner', () => {
  it('filters by owner and orders by most recent activity', async () => {
    const fake = createFakeD1({ allRows: [STORED_ROW] });
    const repository = new D1DiagramRepository(fake.database);

    await repository.listByOwner(OWNER);

    expect(fake.statements[0]?.sql).toContain('WHERE owner_email = ?');
    expect(fake.statements[0]?.sql).toContain('ORDER BY updated_at DESC');
    expect(fake.statements[0]?.parameters).toEqual([OWNER]);
  });

  it('maps every row it returns', async () => {
    const repository = new D1DiagramRepository(createFakeD1({ allRows: [STORED_ROW] }).database);

    expect(await repository.listByOwner(OWNER)).toEqual([MAPPED_DIAGRAM]);
  });

  // The dashboard draws a real React Flow thumbnail per card, so the list has to carry the graph
  // rather than metadata alone.
  it('selects the graph alongside the metadata', async () => {
    const fake = createFakeD1({ allRows: [] });
    const repository = new D1DiagramRepository(fake.database);

    await repository.listByOwner(OWNER);

    expect(fake.statements[0]?.sql).toContain('graph_data');
  });

  it('returns an empty list rather than null when the owner has none', async () => {
    const repository = new D1DiagramRepository(createFakeD1({ allRows: [] }).database);

    expect(await repository.listByOwner(OWNER)).toEqual([]);
  });
});

describe('updateMetadata', () => {
  it('returns the updated row', async () => {
    const repository = new D1DiagramRepository(
      createFakeD1({ firstRows: [{ ...STORED_ROW, title: 'Renamed' }] }).database
    );

    expect(await repository.updateMetadata(DIAGRAM_ID, { title: 'Renamed' })).toMatchObject({
      title: 'Renamed'
    });
  });

  it('returns null when no row has that id', async () => {
    const repository = new D1DiagramRepository(createFakeD1().database);

    expect(await repository.updateMetadata(DIAGRAM_ID, { title: 'Renamed' })).toBeNull();
  });

  // `null` for the description means "clear it", which `COALESCE` would read as "leave it alone".
  // The sentinel parameter is what keeps the two apart, so it is asserted directly.
  it('flags an explicitly cleared description so it is written rather than preserved', async () => {
    const fake = createFakeD1({ firstRows: [{ ...STORED_ROW, description: null }] });
    const repository = new D1DiagramRepository(fake.database);

    await repository.updateMetadata(DIAGRAM_ID, { description: null });

    expect(fake.statements[0]?.parameters).toEqual([DIAGRAM_ID, null, 1, null, expect.any(String)]);
  });

  it('flags an omitted description so the stored value is preserved', async () => {
    const fake = createFakeD1({ firstRows: [STORED_ROW] });
    const repository = new D1DiagramRepository(fake.database);

    await repository.updateMetadata(DIAGRAM_ID, { title: 'Renamed' });

    expect(fake.statements[0]?.parameters).toEqual([
      DIAGRAM_ID,
      'Renamed',
      0,
      null,
      expect.any(String)
    ]);
  });

  it('leaves the title alone when the caller omitted it', async () => {
    const fake = createFakeD1({ firstRows: [STORED_ROW] });
    const repository = new D1DiagramRepository(fake.database);

    await repository.updateMetadata(DIAGRAM_ID, { description: 'Only this' });

    expect(fake.statements[0]?.sql).toContain('COALESCE(?2, title)');
    expect(fake.statements[0]?.parameters[1]).toBeNull();
  });

  it('writes a fresh updated_at timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T05:06:07.000Z'));
    try {
      const fake = createFakeD1({ firstRows: [STORED_ROW] });
      const repository = new D1DiagramRepository(fake.database);

      await repository.updateMetadata(DIAGRAM_ID, { title: 'Renamed' });

      expect(fake.statements[0]?.parameters[4]).toBe('2026-03-04T05:06:07.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('replaceGraph', () => {
  it('reports the new timestamp when a row was updated', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T05:06:07.000Z'));
    try {
      const repository = new D1DiagramRepository(createFakeD1({ changes: 1 }).database);

      expect(await repository.replaceGraph(DIAGRAM_ID, '{}')).toBe('2026-03-04T05:06:07.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  // The service turns this `null` into the uniform `404`, so reporting a miss honestly is what
  // stops a save against a deleted diagram looking like a success.
  it('returns null when no row matched', async () => {
    const repository = new D1DiagramRepository(createFakeD1({ changes: 0 }).database);

    expect(await repository.replaceGraph(DIAGRAM_ID, '{}')).toBeNull();
  });

  it('replaces the graph wholesale rather than merging into it', async () => {
    const fake = createFakeD1({ changes: 1 });
    const repository = new D1DiagramRepository(fake.database);

    await repository.replaceGraph(DIAGRAM_ID, '{"nodes":[]}');

    expect(fake.statements[0]?.sql).toContain('SET graph_data = ?');
    expect(fake.statements[0]?.parameters[0]).toBe('{"nodes":[]}');
  });
});

describe('remove', () => {
  it('reports a deletion', async () => {
    const repository = new D1DiagramRepository(createFakeD1({ changes: 1 }).database);

    expect(await repository.remove(DIAGRAM_ID)).toBe(true);
  });

  it('reports that nothing matched', async () => {
    const repository = new D1DiagramRepository(createFakeD1({ changes: 0 }).database);

    expect(await repository.remove(DIAGRAM_ID)).toBe(false);
  });

  it('deletes by id alone, leaving the access decision to the service', async () => {
    const fake = createFakeD1({ changes: 1 });
    const repository = new D1DiagramRepository(fake.database);

    await repository.remove(DIAGRAM_ID);

    expect(fake.statements[0]?.sql).toBe('DELETE FROM diagrams WHERE id = ?');
    expect(fake.statements[0]?.parameters).toEqual([DIAGRAM_ID]);
  });
});
