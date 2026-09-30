import { describe, expect, it } from 'vitest';
import { D1TodoRepository } from '../../../src/worker/infrastructure/d1-todo-repository';
import { createFakeD1 } from '../support/fake-d1';
import { problemWithStatus } from '../support/problem-details';

const OWNER = 'alice@example.com';
const TODO_ID = '5d837139-c37f-4fe3-b95c-69757a3a823d';

/**
 * A stored row as D1 would return it, using the snake_case column names and integer `completed`.
 */
const STORED_ROW = {
  id: TODO_ID,
  title: 'Buy milk',
  completed: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z'
};

describe('D1TodoRepository', () => {
  describe('ownership scoping', () => {
    // This is the demo's central security property: every statement the repository issues must
    // constrain `user_id`, because all users' tasks share one table. Asserting it once per
    // operation — rather than trusting a review of the SQL strings — means a future edit that drops
    // a predicate fails a test instead of silently exposing another user's data.
    it('constrains every statement by user_id', async () => {
      const fake = createFakeD1({
        allRows: [STORED_ROW],
        firstRows: [STORED_ROW, STORED_ROW],
        changes: 2
      });
      const repository = new D1TodoRepository(fake.database);

      await repository.list(OWNER);
      await repository.create(OWNER, { title: 'Buy milk' });
      await repository.get(OWNER, TODO_ID);
      await repository.update(OWNER, TODO_ID, { completed: true });
      await repository.deleteCompleted(OWNER);

      expect(fake.statements).not.toHaveLength(0);
      for (const statement of fake.statements) {
        expect(statement.sql).toContain('user_id');
        expect(statement.parameters).toContain(OWNER);
      }
    });

    it('binds values as parameters rather than interpolating them into SQL', async () => {
      const injection = "'; DROP TABLE todos; --";
      const fake = createFakeD1();
      const repository = new D1TodoRepository(fake.database);

      await repository.create(injection, { title: injection });

      const [statement] = fake.statements;
      expect(statement?.sql).not.toContain('DROP TABLE');
      expect(statement?.sql).toContain('VALUES (?, ?, ?, ?, ?, ?)');
      expect(statement?.parameters).toContain(injection);
    });
  });

  describe('list', () => {
    it('maps stored rows to domain tasks', async () => {
      const fake = createFakeD1({ allRows: [{ ...STORED_ROW, completed: 1 }] });
      const repository = new D1TodoRepository(fake.database);

      const todos = await repository.list(OWNER);

      expect(todos).toEqual([
        {
          id: TODO_ID,
          title: 'Buy milk',
          completed: true,
          createdAt: STORED_ROW.created_at,
          updatedAt: STORED_ROW.updated_at
        }
      ]);
    });

    it('orders newest first so the UI does not have to sort', async () => {
      const fake = createFakeD1();
      await new D1TodoRepository(fake.database).list(OWNER);

      expect(fake.statements[0]?.sql).toContain('ORDER BY created_at DESC');
    });

    it('returns an empty list for a user with no tasks', async () => {
      const fake = createFakeD1();
      expect(await new D1TodoRepository(fake.database).list(OWNER)).toEqual([]);
    });
  });

  describe('create', () => {
    it('generates the identifier and timestamps rather than trusting the caller', async () => {
      const fake = createFakeD1();
      const repository = new D1TodoRepository(fake.database);

      const todo = await repository.create(OWNER, { title: 'Buy milk' });

      expect(todo.id).toMatch(/^[0-9a-f-]{36}$/u);
      expect(todo.completed).toBe(false);
      expect(todo.createdAt).toBe(todo.updatedAt);
      expect(Date.parse(todo.createdAt)).not.toBeNaN();
    });

    it('stores completed as the integer 0, matching the column CHECK', async () => {
      const fake = createFakeD1();
      await new D1TodoRepository(fake.database).create(OWNER, { title: 'Buy milk' });

      expect(fake.statements[0]?.parameters).toContain(0);
    });
  });

  describe('get', () => {
    it("reports another user's task as absent rather than forbidden", async () => {
      // A `null` row is what D1 returns when the identifier exists but belongs to somebody else,
      // because the query constrains `user_id`. The repository must not distinguish that case.
      const fake = createFakeD1({ firstRows: [null] });
      const repository = new D1TodoRepository(fake.database);

      await expect(repository.get(OWNER, TODO_ID)).rejects.toMatchObject(problemWithStatus(404));
    });
  });

  describe('update', () => {
    it('preserves fields the caller omitted', async () => {
      const fake = createFakeD1({ firstRows: [STORED_ROW] });
      const repository = new D1TodoRepository(fake.database);

      const todo = await repository.update(OWNER, TODO_ID, { completed: true });

      expect(todo.title).toBe('Buy milk');
      expect(todo.completed).toBe(true);
    });

    it('refreshes updatedAt while preserving createdAt', async () => {
      const fake = createFakeD1({ firstRows: [STORED_ROW] });
      const repository = new D1TodoRepository(fake.database);

      const todo = await repository.update(OWNER, TODO_ID, { title: 'Renamed' });

      expect(todo.createdAt).toBe(STORED_ROW.created_at);
      expect(Date.parse(todo.updatedAt)).toBeGreaterThanOrEqual(Date.parse(STORED_ROW.created_at));
    });

    // The UPDATE repeats the ownership predicate instead of relying on the preceding SELECT, so
    // each statement is individually safe rather than depending on the pair running as one unit.
    it('re-checks ownership in the UPDATE itself', async () => {
      const fake = createFakeD1({ firstRows: [STORED_ROW] });
      await new D1TodoRepository(fake.database).update(OWNER, TODO_ID, { completed: true });

      const update = fake.statements.find((statement) => statement.sql.startsWith('UPDATE'));
      expect(update?.sql).toContain('WHERE id = ? AND user_id = ?');
    });

    it("refuses to update another user's task", async () => {
      const fake = createFakeD1({ firstRows: [null] });
      const repository = new D1TodoRepository(fake.database);

      await expect(repository.update(OWNER, TODO_ID, { completed: true })).rejects.toMatchObject(
        problemWithStatus(404)
      );
      expect(fake.statements.some((statement) => statement.sql.startsWith('UPDATE'))).toBe(false);
    });
  });

  describe('delete', () => {
    it('deletes a task the user owns', async () => {
      const fake = createFakeD1({ firstRows: [STORED_ROW] });
      await new D1TodoRepository(fake.database).delete(OWNER, TODO_ID);

      const remove = fake.statements.find((statement) => statement.sql.startsWith('DELETE'));
      expect(remove?.parameters).toEqual([TODO_ID, OWNER]);
    });

    // Without the preceding existence check, DELETE would report success for a row that was never
    // the caller's, confirming that somebody else's identifier exists.
    it("does not issue a DELETE for another user's task", async () => {
      const fake = createFakeD1({ firstRows: [null] });
      const repository = new D1TodoRepository(fake.database);

      await expect(repository.delete(OWNER, TODO_ID)).rejects.toMatchObject(problemWithStatus(404));
      expect(fake.statements.some((statement) => statement.sql.startsWith('DELETE'))).toBe(false);
    });
  });

  describe('deleteCompleted', () => {
    it("reports how many rows were removed and touches only the user's completed tasks", async () => {
      const fake = createFakeD1({ changes: 3 });

      expect(await new D1TodoRepository(fake.database).deleteCompleted(OWNER)).toBe(3);
      expect(fake.statements[0]?.sql).toContain('WHERE user_id = ? AND completed = 1');
    });

    it('reports zero when the user has no completed tasks', async () => {
      const fake = createFakeD1({ changes: 0 });
      expect(await new D1TodoRepository(fake.database).deleteCompleted(OWNER)).toBe(0);
    });
  });
});
