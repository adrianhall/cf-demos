import { describe, expect, it } from 'vitest';
import { D1ChannelRepository } from '../../../src/worker/infrastructure/d1-channel-repository';
import { createFakeD1 } from '../support/fake-d1';
import { problemWithStatus } from '../support/problem-details';

/**
 * A stored row as D1 would return it, used to check the snake_case-to-camelCase mapping.
 */
const GENERAL_ROW = {
  name: 'general',
  created_by: 'alice@example.com',
  created_at: '2026-01-01T00:00:00.000Z'
};

describe('D1ChannelRepository', () => {
  describe('list', () => {
    it('maps stored rows into the domain shape', async () => {
      const { database } = createFakeD1({ allRows: [GENERAL_ROW] });

      expect(await new D1ChannelRepository(database).list()).toEqual([
        {
          name: 'general',
          createdBy: 'alice@example.com',
          createdAt: '2026-01-01T00:00:00.000Z'
        }
      ]);
    });

    // Name order is what makes every participant's sidebar identical and stable, so it is part
    // of the repository's contract rather than an incidental detail of the query.
    it('orders by name in the query rather than in memory', async () => {
      const { database, statements } = createFakeD1();
      await new D1ChannelRepository(database).list();

      expect(statements[0]?.sql).toContain('ORDER BY name');
    });

    it('returns an empty array for an empty directory', async () => {
      const { database } = createFakeD1();
      expect(await new D1ChannelRepository(database).list()).toEqual([]);
    });
  });

  describe('find', () => {
    it('returns the mapped channel when a row exists', async () => {
      const { database } = createFakeD1({ firstRows: [GENERAL_ROW] });

      expect(await new D1ChannelRepository(database).find('general')).toEqual({
        name: 'general',
        createdBy: 'alice@example.com',
        createdAt: '2026-01-01T00:00:00.000Z'
      });
    });

    // `null` rather than a thrown error: a missing channel is an ordinary outcome, and the
    // application layer decides what it means in each use case.
    it('returns null when no row exists', async () => {
      const { database } = createFakeD1({ firstRows: [null] });
      expect(await new D1ChannelRepository(database).find('missing')).toBeNull();
    });

    it('binds the requested name', async () => {
      const { database, statements } = createFakeD1({ firstRows: [null] });
      await new D1ChannelRepository(database).find('deploys');

      expect(statements[0]?.parameters).toEqual(['deploys']);
    });
  });

  describe('create', () => {
    it('persists the name, creator, and a generated timestamp', async () => {
      const { database, statements } = createFakeD1({ changes: 1 });

      const channel = await new D1ChannelRepository(database).create(
        { name: 'deploys' },
        'alice@example.com'
      );

      expect(channel.name).toBe('deploys');
      expect(channel.createdBy).toBe('alice@example.com');
      expect(Date.parse(channel.createdAt)).not.toBeNaN();
      expect(statements[0]?.parameters).toEqual([
        'deploys',
        'alice@example.com',
        channel.createdAt
      ]);
    });

    // A read-then-write would leave a window in which two concurrent creations both see the
    // name as free. Letting the primary key arbitrate is the whole point of this statement.
    it('lets the primary key arbitrate instead of reading first', async () => {
      const { database, statements } = createFakeD1({ changes: 1 });
      await new D1ChannelRepository(database).create({ name: 'deploys' }, 'alice@example.com');

      expect(statements).toHaveLength(1);
      expect(statements[0]?.sql).toContain('INSERT OR IGNORE');
    });

    // `changes === 0` means the insert was ignored, which can only happen when the name is
    // already taken.
    it('reports a taken name as 409 rather than overwriting it', async () => {
      const { database } = createFakeD1({ changes: 0 });

      await expect(
        new D1ChannelRepository(database).create({ name: 'general' }, 'bob@example.com')
      ).rejects.toMatchObject(problemWithStatus(409));
    });
  });

  describe('remove', () => {
    it('reports true when a row was deleted', async () => {
      const { database } = createFakeD1({ changes: 1 });
      expect(await new D1ChannelRepository(database).remove('general')).toBe(true);
    });

    it('reports false when there was nothing to delete', async () => {
      const { database } = createFakeD1({ changes: 0 });
      expect(await new D1ChannelRepository(database).remove('missing')).toBe(false);
    });
  });

  // The directory is shared, so unlike the sibling `todo` demo no statement is scoped to an
  // identity. This asserts that explicitly, so a future change that starts filtering by
  // participant has to acknowledge it is changing the product rather than doing it silently.
  it('scopes no statement to a participant identity', async () => {
    const { database, statements } = createFakeD1({ changes: 1, firstRows: [GENERAL_ROW] });
    const repository = new D1ChannelRepository(database);

    await repository.list();
    await repository.find('general');
    await repository.create({ name: 'deploys' }, 'alice@example.com');
    await repository.remove('general');

    for (const statement of statements) {
      expect(statement.sql).not.toContain('created_by = ?');
    }
  });
});
