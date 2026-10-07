import { describe, expect, it } from 'vitest';
import { D1KvShareRepository } from '../../src/worker/infrastructure/d1-kv-share-repository.ts';
import { createFakeD1 } from './fake-d1.ts';
import { createFakeKv } from './fake-kv.ts';

/**
 * @file Covers the share adapter's statements, its bound values and — most of all — the division of
 *   labour between its two stores. D1 is authoritative for the share lifecycle; KV is a disposable
 *   lookup in front of it. The tests that matter here are the ones that would still pass if the two
 *   were confused: that a revocation deletes the KV entry as well as writing `revoked_at`, and that
 *   a KV miss falls back to D1 rather than reporting the share gone. The SQL's validity is proven
 *   in the Workers-runtime suite against a real migrated database, not here against a double that
 *   never parses it.
 */

const DIAGRAM_ID = '11111111-1111-4111-8111-111111111111';
const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);
const CREATED_AT = '2026-01-01T00:00:00.000Z';
const REVOKED_AT = '2026-01-02T00:00:00.000Z';

describe('parameter binding', () => {
  // Every value reaches D1 as a bound parameter. A digest is hex and a diagram id is a UUID, so
  // neither is plausibly hostile today — but the adapter must not be the place that assumes it.
  it('binds hostile values as parameters rather than interpolating them', async () => {
    const injection = "'; DROP TABLE diagram_shares; --";
    const fake = createFakeD1({ changes: 1, firstRows: [{ token_digest: DIGEST }] });
    const repository = new D1KvShareRepository(fake.database, createFakeKv().kv);

    await repository.findActive(injection);
    await repository.create(injection, injection, CREATED_AT);
    await repository.revokeActive(injection, REVOKED_AT);
    await repository.resolve(injection);
    await repository.findSharedDiagram(injection);

    expect(fake.statements).not.toHaveLength(0);
    for (const statement of fake.statements) {
      expect(statement.sql).not.toContain('DROP TABLE');
      expect(statement.parameters).toContain(injection);
    }
  });
});

describe('findActive', () => {
  it('reads only the unrevoked row for the diagram', async () => {
    const fake = createFakeD1({
      firstRows: [{ created_at: CREATED_AT, token_digest: DIGEST }]
    });
    const repository = new D1KvShareRepository(fake.database, createFakeKv().kv);

    await expect(repository.findActive(DIAGRAM_ID)).resolves.toEqual({
      createdAt: CREATED_AT,
      tokenDigest: DIGEST
    });
    expect(fake.statements[0]?.sql).toContain('revoked_at IS NULL');
    expect(fake.statements[0]?.parameters).toEqual([DIAGRAM_ID]);
  });

  it('reports no active share when nothing matches', async () => {
    const repository = new D1KvShareRepository(createFakeD1().database, createFakeKv().kv);

    await expect(repository.findActive(DIAGRAM_ID)).resolves.toBeNull();
  });
});

describe('create', () => {
  it('writes the digest to D1 and makes it resolvable through the lookup', async () => {
    const fake = createFakeD1({ changes: 1 });
    const kv = createFakeKv();
    const repository = new D1KvShareRepository(fake.database, kv.kv);

    await repository.create(DIAGRAM_ID, DIGEST, CREATED_AT);

    expect(fake.statements[0]?.sql).toContain('INSERT INTO diagram_shares');
    expect(fake.statements[0]?.parameters).toEqual([DIGEST, DIAGRAM_ID, CREATED_AT]);
    expect(kv.entries.get(DIGEST)).toBe(DIAGRAM_ID);
  });

  // The whole security property, asserted at the only layer that writes anything down: a store
  // that received only a digest cannot have kept the token.
  it('writes nothing but the digest, the diagram id and the timestamp', async () => {
    const fake = createFakeD1({ changes: 1 });
    const kv = createFakeKv();
    const repository = new D1KvShareRepository(fake.database, kv.kv);

    await repository.create(DIAGRAM_ID, DIGEST, CREATED_AT);

    const written = JSON.stringify([fake.statements, [...kv.entries]]);

    expect(written).not.toContain('token"');
    expect(fake.statements[0]?.parameters).toHaveLength(3);
  });
});

describe('revokeActive', () => {
  it('records the revocation in D1 and deletes the lookup entry', async () => {
    const fake = createFakeD1({ changes: 1, firstRows: [{ token_digest: DIGEST }] });
    const kv = createFakeKv({ [DIGEST]: DIAGRAM_ID });
    const repository = new D1KvShareRepository(fake.database, kv.kv);

    await expect(repository.revokeActive(DIAGRAM_ID, REVOKED_AT)).resolves.toBe(true);

    expect(fake.statements[1]?.sql).toContain('SET revoked_at');
    expect(fake.statements[1]?.parameters).toEqual([REVOKED_AT, DIGEST]);
    expect(kv.entries.has(DIGEST)).toBe(false);
  });

  // The row is updated rather than deleted, so `revoked_at` is a lightweight audit trail of links
  // that once existed. Deleting it would make a revoked share indistinguishable from one that was
  // never created — in the operator's own records, not just in the API's answers.
  it('keeps the revoked row rather than deleting it', async () => {
    const fake = createFakeD1({ changes: 1, firstRows: [{ token_digest: DIGEST }] });
    const repository = new D1KvShareRepository(fake.database, createFakeKv().kv);

    await repository.revokeActive(DIAGRAM_ID, REVOKED_AT);

    for (const statement of fake.statements) {
      expect(statement.sql).not.toContain('DELETE FROM diagram_shares');
    }
  });

  it('reports nothing revoked and touches no lookup entry when none is active', async () => {
    const fake = createFakeD1();
    const kv = createFakeKv({ [OTHER_DIGEST]: DIAGRAM_ID });
    const repository = new D1KvShareRepository(fake.database, kv.kv);

    await expect(repository.revokeActive(DIAGRAM_ID, REVOKED_AT)).resolves.toBe(false);

    expect(fake.statements).toHaveLength(1);
    expect(kv.entries.has(OTHER_DIGEST)).toBe(true);
  });
});

describe('revokeAllForDiagram', () => {
  it('deletes every lookup entry and revokes every row', async () => {
    const fake = createFakeD1({
      allRows: [{ token_digest: DIGEST }, { token_digest: OTHER_DIGEST }],
      changes: 2
    });
    const kv = createFakeKv({ [DIGEST]: DIAGRAM_ID, [OTHER_DIGEST]: DIAGRAM_ID });
    const repository = new D1KvShareRepository(fake.database, kv.kv);

    await expect(repository.revokeAllForDiagram(DIAGRAM_ID, REVOKED_AT)).resolves.toBe(2);

    expect(kv.entries.size).toBe(0);
  });

  it('writes nothing when the diagram was never shared', async () => {
    const fake = createFakeD1();
    const repository = new D1KvShareRepository(fake.database, createFakeKv().kv);

    await expect(repository.revokeAllForDiagram(DIAGRAM_ID, REVOKED_AT)).resolves.toBe(0);

    expect(fake.statements).toHaveLength(1);
  });
});

describe('resolve', () => {
  it('confirms a lookup hit against D1 before serving it', async () => {
    const fake = createFakeD1({ firstRows: [{ diagram_id: DIAGRAM_ID }] });
    const repository = new D1KvShareRepository(
      fake.database,
      createFakeKv({ [DIGEST]: DIAGRAM_ID }).kv
    );

    await expect(repository.resolve(DIGEST)).resolves.toBe(DIAGRAM_ID);
    expect(fake.statements[0]?.sql).toContain('revoked_at IS NULL');
  });

  // KV is eventually consistent after deletes as well as writes. A stale hit must not let a
  // revoked bearer credential keep working at a location that has not seen the delete yet.
  it('refuses and cleans up a stale lookup hit D1 says is revoked', async () => {
    const kv = createFakeKv({ [DIGEST]: DIAGRAM_ID });
    const repository = new D1KvShareRepository(createFakeD1().database, kv.kv);

    await expect(repository.resolve(DIGEST)).resolves.toBeNull();
    expect(kv.entries.has(DIGEST)).toBe(false);
  });

  it('still refuses when best-effort stale-entry cleanup fails', async () => {
    const kv = createFakeKv({ [DIGEST]: DIAGRAM_ID }).kv;
    kv.delete = async () => {
      throw new Error('KV unavailable');
    };
    const repository = new D1KvShareRepository(createFakeD1().database, kv);

    await expect(repository.resolve(DIGEST)).resolves.toBeNull();
  });

  // KV is eventually consistent across locations, so a link opened moments after it was minted can
  // miss. Treating that as "revoked" would make a brand-new share fail for its first viewer, which
  // is exactly the moment an owner is watching.
  it('falls back to D1 on a lookup miss and backfills the lookup', async () => {
    const fake = createFakeD1({ firstRows: [{ diagram_id: DIAGRAM_ID }] });
    const kv = createFakeKv();
    const repository = new D1KvShareRepository(fake.database, kv.kv);

    await expect(repository.resolve(DIGEST)).resolves.toBe(DIAGRAM_ID);

    expect(fake.statements[0]?.sql).toContain('revoked_at IS NULL');
    expect(kv.entries.get(DIGEST)).toBe(DIAGRAM_ID);
  });

  it('repairs a lookup value that disagrees with D1', async () => {
    const fake = createFakeD1({ firstRows: [{ diagram_id: DIAGRAM_ID }] });
    const kv = createFakeKv({ [DIGEST]: '22222222-2222-4222-8222-222222222222' });
    const repository = new D1KvShareRepository(fake.database, kv.kv);

    await expect(repository.resolve(DIGEST)).resolves.toBe(DIAGRAM_ID);
    expect(kv.entries.get(DIGEST)).toBe(DIAGRAM_ID);
  });

  it('reports an unknown digest as unresolvable', async () => {
    const kv = createFakeKv();
    const repository = new D1KvShareRepository(createFakeD1().database, kv.kv);

    await expect(repository.resolve(DIGEST)).resolves.toBeNull();
    expect(kv.entries.size).toBe(0);
  });

  // D1 is authoritative, so the fallback must not resurrect a revoked share. The filter is
  // asserted on the statement because a double cannot evaluate a `WHERE` clause: the Workers
  // runtime suite proves the same thing against a real database, through the API.
  it('excludes revoked rows from the fallback query and caches nothing for them', async () => {
    const fake = createFakeD1();
    const kv = createFakeKv();
    const repository = new D1KvShareRepository(fake.database, kv.kv);

    await expect(repository.resolve(OTHER_DIGEST)).resolves.toBeNull();

    expect(fake.statements[0]?.sql).toContain('revoked_at IS NULL');
    expect(kv.entries.size).toBe(0);
  });
});

describe('findSharedDiagram', () => {
  it('maps the public columns onto the domain shape', async () => {
    const fake = createFakeD1({
      firstRows: [
        {
          description: 'Notes',
          graph_data: '{"nodes":[],"edges":[]}',
          id: DIAGRAM_ID,
          title: 'Shared'
        }
      ]
    });
    const repository = new D1KvShareRepository(fake.database, createFakeKv().kv);

    await expect(repository.findSharedDiagram(DIAGRAM_ID)).resolves.toEqual({
      description: 'Notes',
      graphData: '{"nodes":[],"edges":[]}',
      id: DIAGRAM_ID,
      title: 'Shared'
    });
  });

  // Asserted against the statement rather than only the mapped result: selecting the owner and
  // dropping it afterwards would pass a shape assertion while still reading it out of storage,
  // one careless spread away from being returned.
  it('never selects the owner column', async () => {
    const fake = createFakeD1({ firstRows: [{ id: DIAGRAM_ID, title: 'Shared' }] });
    const repository = new D1KvShareRepository(fake.database, createFakeKv().kv);

    await repository.findSharedDiagram(DIAGRAM_ID);

    expect(fake.statements[0]?.sql).not.toContain('owner_email');
  });

  it('reports a diagram that no longer exists as absent', async () => {
    const repository = new D1KvShareRepository(createFakeD1().database, createFakeKv().kv);

    await expect(repository.findSharedDiagram(DIAGRAM_ID)).resolves.toBeNull();
  });
});
