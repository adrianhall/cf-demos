import { describe, expect, it, vi } from 'vitest';
import { TodoService } from '../../../src/worker/application/todo-service';
import type { Todo, TodoRepository } from '../../../src/worker/domain/todo';
import { problemWithStatus } from '../support/problem-details';

const OWNER = 'alice@example.com';
const TODO_ID = '5d837139-c37f-4fe3-b95c-69757a3a823d';

const SAMPLE_TODO: Todo = {
  id: TODO_ID,
  title: 'Buy milk',
  completed: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

/**
 * Build a fully mocked {@link TodoRepository}.
 *
 * The service is tested against the port rather than against D1, which is the point of having the
 * port: these tests cover validation order and identity propagation without a database.
 *
 * @returns A repository whose every method is a Vitest mock with a sensible default resolution.
 */
function createRepository() {
  return {
    list: vi.fn<TodoRepository['list']>().mockResolvedValue([SAMPLE_TODO]),
    create: vi.fn<TodoRepository['create']>().mockResolvedValue(SAMPLE_TODO),
    get: vi.fn<TodoRepository['get']>().mockResolvedValue(SAMPLE_TODO),
    update: vi.fn<TodoRepository['update']>().mockResolvedValue(SAMPLE_TODO),
    delete: vi.fn<TodoRepository['delete']>().mockResolvedValue(undefined),
    deleteCompleted: vi.fn<TodoRepository['deleteCompleted']>().mockResolvedValue(0)
  } satisfies TodoRepository;
}

describe('TodoService', () => {
  describe('identity propagation', () => {
    // The service must never widen the ownership scope it was given. If it did, validation and
    // route-level checks would not matter: the repository would be asked for the wrong user's data.
    it('passes the caller identity unchanged to every repository call', async () => {
      const repository = createRepository();
      const service = new TodoService(repository);

      await service.listTodos(OWNER);
      await service.createTodo(OWNER, { title: 'Buy milk' });
      await service.updateTodo(OWNER, TODO_ID, { completed: true });
      await service.deleteTodo(OWNER, TODO_ID);
      await service.clearCompletedTodos(OWNER);

      expect(repository.list).toHaveBeenCalledWith(OWNER);
      expect(repository.create).toHaveBeenCalledWith(OWNER, { title: 'Buy milk' });
      expect(repository.update).toHaveBeenCalledWith(OWNER, TODO_ID, { completed: true });
      expect(repository.delete).toHaveBeenCalledWith(OWNER, TODO_ID);
      expect(repository.deleteCompleted).toHaveBeenCalledWith(OWNER);
    });
  });

  describe('createTodo', () => {
    it('normalizes the title before persisting it', async () => {
      const repository = createRepository();

      await new TodoService(repository).createTodo(OWNER, { title: '  Buy milk  ' });

      expect(repository.create).toHaveBeenCalledWith(OWNER, { title: 'Buy milk' });
    });

    it('rejects an invalid payload without touching storage', async () => {
      const repository = createRepository();

      await expect(new TodoService(repository).createTodo(OWNER, { title: '' })).rejects.toThrow();
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  describe('updateTodo', () => {
    it('validates the body before using the identifier', async () => {
      // Body validation runs first on purpose: an invalid payload then cannot be used to probe
      // which identifiers exist, because the lookup never happens.
      const repository = createRepository();

      await expect(
        new TodoService(repository).updateTodo(OWNER, 'not-a-uuid', { nope: true })
      ).rejects.toMatchObject(problemWithStatus(422));
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('rejects a malformed identifier as not found', async () => {
      const repository = createRepository();

      await expect(
        new TodoService(repository).updateTodo(OWNER, 'not-a-uuid', { completed: true })
      ).rejects.toMatchObject(problemWithStatus(404));
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteTodo', () => {
    it('rejects a malformed identifier without touching storage', async () => {
      const repository = createRepository();

      await expect(
        new TodoService(repository).deleteTodo(OWNER, 'completed')
      ).rejects.toMatchObject(problemWithStatus(404));
      expect(repository.delete).not.toHaveBeenCalled();
    });
  });

  describe('clearCompletedTodos', () => {
    it('reports the number of tasks the repository removed', async () => {
      const repository = createRepository();
      repository.deleteCompleted.mockResolvedValue(4);

      expect(await new TodoService(repository).clearCompletedTodos(OWNER)).toBe(4);
    });
  });
});
