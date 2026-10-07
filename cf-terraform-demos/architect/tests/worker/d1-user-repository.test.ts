import { describe, expect, it } from 'vitest';
import { D1UserRepository } from '../../src/worker/infrastructure/d1-user-repository.ts';
import { createFakeD1 } from './fake-d1.ts';

/**
 * @file Covers the D1 user adapter's statements, its bound values and its row mapping. The SQL's
 *   validity is proven in the Workers-runtime suite against a real migrated database; what is
 *   asserted here is the shape of what the adapter asks for — notably that the diagram count comes
 *   from a correlated subquery rather than a stored column, and that the total is read
 *   independently of the page.
 */

const ALICE = 'alice@example.com';
const SEEN_AT = '2026-01-02T00:00:00.000Z';

/**
 * A directory row as D1 returns it, in snake_case.
 */
const STORED_ROW = {
  diagram_count: 3,
  display_name: null,
  email: ALICE,
  first_seen_at: '2026-01-01T00:00:00.000Z',
  last_seen_at: SEEN_AT
};

describe('parameter binding', () => {
  it('binds hostile values as parameters rather than interpolating them', async () => {
    const injection = "'; DROP TABLE users; --";
    const fake = createFakeD1({ changes: 1 });
    const repository = new D1UserRepository(fake.database);

    await repository.recordSeen(injection, SEEN_AT);

    expect(fake.statements).not.toHaveLength(0);
    for (const statement of fake.statements) {
      expect(statement.sql).not.toContain('DROP TABLE');
      expect(statement.parameters).toContain(injection);
    }
  });
});

describe('recordSeen', () => {
  // One statement rather than a read followed by a conditional write: check-then-write races two
  // concurrent requests from the same identity against each other and can lose the insert.
  it('upserts in a single statement', async () => {
    const fake = createFakeD1({ changes: 1 });

    await new D1UserRepository(fake.database).recordSeen(ALICE, SEEN_AT);

    expect(fake.statements).toHaveLength(1);
    expect(fake.statements[0]?.sql).toContain('ON CONFLICT(email) DO UPDATE');
  });

  // `first_seen_at` is the one value in the directory that would be destroyed rather than merely
  // stale if the update branch touched it.
  it('refreshes only last_seen_at on a repeat visit', async () => {
    const fake = createFakeD1({ changes: 1 });

    await new D1UserRepository(fake.database).recordSeen(ALICE, SEEN_AT);

    const sql = fake.statements[0]?.sql ?? '';

    expect(sql).toContain('last_seen_at = excluded.last_seen_at');
    expect(sql).not.toContain('first_seen_at = excluded');
  });

  // No request-time source for a name exists: the verified Access identity carries only `email`,
  // `sub` and `source`, and this demo provisions no identity provider that could supply one.
  it('writes a null display name and never updates it', async () => {
    const fake = createFakeD1({ changes: 1 });

    await new D1UserRepository(fake.database).recordSeen(ALICE, SEEN_AT);

    const sql = fake.statements[0]?.sql ?? '';

    expect(sql).toContain('NULL');
    expect(sql).not.toContain('display_name = excluded');
  });

  it('records the timestamp it was given rather than reading a clock', async () => {
    const fake = createFakeD1({ changes: 1 });

    await new D1UserRepository(fake.database).recordSeen(ALICE, SEEN_AT);

    expect(fake.statements[0]?.parameters).toEqual([ALICE, SEEN_AT, SEEN_AT]);
  });
});

describe('listWithDiagramCounts', () => {
  it('maps stored rows onto the domain shape', async () => {
    const fake = createFakeD1({ allRows: [STORED_ROW], firstRows: [{ count: 1 }] });

    await expect(
      new D1UserRepository(fake.database).listWithDiagramCounts({ limit: 20, offset: 0 })
    ).resolves.toEqual({
      total: 1,
      users: [
        {
          diagramCount: 3,
          displayName: null,
          email: ALICE,
          firstSeenAt: '2026-01-01T00:00:00.000Z',
          lastSeenAt: SEEN_AT
        }
      ]
    });
  });

  it('binds the pagination window rather than interpolating it', async () => {
    const fake = createFakeD1({ allRows: [], firstRows: [{ count: 0 }] });

    await new D1UserRepository(fake.database).listWithDiagramCounts({ limit: 10, offset: 40 });

    expect(fake.statements[0]?.sql).toContain('LIMIT ? OFFSET ?');
    expect(fake.statements[0]?.parameters).toEqual([10, 40]);
  });

  // The administrative view exists to answer "who has been using this deployment", so a page
  // ordered by anything else would make the first page the least interesting one. The email
  // tiebreak keeps paging stable when two identities share a timestamp.
  it('orders by recent activity, with a stable tiebreak', async () => {
    const fake = createFakeD1({ allRows: [], firstRows: [{ count: 0 }] });

    await new D1UserRepository(fake.database).listWithDiagramCounts({ limit: 20, offset: 0 });

    expect(fake.statements[0]?.sql).toMatch(/ORDER BY\s+u\.last_seen_at DESC,\s+u\.email ASC/u);
  });

  // Computed at read time from `diagrams.owner_email`, so the count cannot drift from the
  // diagrams an identity actually owns — including after a moderation delete, which is exactly
  // the operation a denormalised counter would be forgotten in.
  it('counts diagrams with a correlated subquery rather than reading a counter column', async () => {
    const fake = createFakeD1({ allRows: [], firstRows: [{ count: 0 }] });

    await new D1UserRepository(fake.database).listWithDiagramCounts({ limit: 20, offset: 0 });

    const sql = fake.statements[0]?.sql ?? '';

    expect(sql).toContain('SELECT COUNT(*) FROM diagrams d WHERE d.owner_email = u.email');
    expect(sql).not.toContain('u.diagram_count');
  });

  // `LIMIT` is applied before a window function would be evaluated, so the paged query simply
  // cannot see the rows it excluded — the total has to be its own statement.
  it('reads the total independently of the page', async () => {
    const fake = createFakeD1({ allRows: [STORED_ROW], firstRows: [{ count: 42 }] });

    const page = await new D1UserRepository(fake.database).listWithDiagramCounts({
      limit: 1,
      offset: 0
    });

    expect(fake.statements).toHaveLength(2);
    expect(fake.statements[1]?.sql).toContain('SELECT COUNT(*) AS count FROM users');
    expect(page.total).toBe(42);
  });

  it('reports an empty directory as zero rather than as an error', async () => {
    const fake = createFakeD1({ allRows: [], firstRows: [{ count: 0 }] });

    await expect(
      new D1UserRepository(fake.database).listWithDiagramCounts({ limit: 20, offset: 0 })
    ).resolves.toEqual({ total: 0, users: [] });
  });

  // A `COUNT(*)` always produces a row, so a missing one is a storage fault rather than an empty
  // directory. Failing is the right answer: `?? 0` would report "nobody has ever signed in" to an
  // administrator looking at a broken database, which is the one reading they could not act on.
  it('fails rather than reporting an empty directory when the count returned no row', async () => {
    const fake = createFakeD1({ allRows: [] });

    await expect(
      new D1UserRepository(fake.database).listWithDiagramCounts({ limit: 20, offset: 0 })
    ).rejects.toThrow();
  });

  it('preserves a display name when the row happens to carry one', async () => {
    const fake = createFakeD1({
      allRows: [{ ...STORED_ROW, display_name: 'Alice Example' }],
      firstRows: [{ count: 1 }]
    });

    const page = await new D1UserRepository(fake.database).listWithDiagramCounts({
      limit: 20,
      offset: 0
    });

    expect(page.users[0]?.displayName).toBe('Alice Example');
  });
});
