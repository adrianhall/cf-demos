import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Todo, useTodosStore } from '../../../src/client/stores/todos';

let fetchMock: ReturnType<typeof vi.fn>;

const TODO_ID = '5d837139-c37f-4fe3-b95c-69757a3a823d';

const SAMPLE_TODO: Todo = {
  id: TODO_ID,
  title: 'Buy milk',
  completed: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

/**
 * Build a JSON response for the mocked `fetch`.
 *
 * @param body Value to serialize as the response body.
 * @param status HTTP status to report. Defaults to `200`.
 * @returns A response the store can consume.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('todos store', () => {
  describe('load', () => {
    it('replaces the list from the API and clears the loading flag', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ todos: [SAMPLE_TODO] }));
      const store = useTodosStore();

      await store.load();

      expect(fetchMock).toHaveBeenCalledWith('/api/todos', expect.anything());
      expect(store.todos).toEqual([SAMPLE_TODO]);
      expect(store.loading).toBe(false);
      expect(store.error).toBeNull();
    });

    // A failed initial load has no user interaction to report against, so the store records the
    // message instead of rejecting and leaving the page with an unhandled error.
    it('records an RFC 9457 detail instead of throwing', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ detail: 'Session expired.' }, 401));
      const store = useTodosStore();

      await store.load();

      expect(store.error).toBe('Session expired.');
      expect(store.loading).toBe(false);
    });

    it('falls back to a generic message when the error body is unparseable', async () => {
      fetchMock.mockResolvedValue(new Response('<html>gateway error</html>', { status: 502 }));
      const store = useTodosStore();

      await store.load();

      expect(store.error).toBe('The request could not be completed.');
    });

    it('records a transport failure', async () => {
      fetchMock.mockRejectedValue(new Error('network down'));
      const store = useTodosStore();

      await store.load();

      expect(store.error).toBe('network down');
      expect(store.loading).toBe(false);
    });
  });

  describe('create', () => {
    it('prepends the server-confirmed task', async () => {
      const existing = { ...SAMPLE_TODO, id: 'a0000000-0000-4000-8000-000000000000' };
      fetchMock.mockResolvedValue(jsonResponse({ todo: SAMPLE_TODO }, 201));
      const store = useTodosStore();
      store.todos = [existing];

      await store.create('Buy milk');

      expect(store.todos).toEqual([SAMPLE_TODO, existing]);
    });

    // The rendered task must carry the real identifier and timestamps, so the list is rebuilt from
    // the response rather than from the submitted title.
    it('uses the response body rather than the submitted title', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ todo: { ...SAMPLE_TODO, title: 'Buy milk' } }, 201)
      );
      const store = useTodosStore();

      await store.create('  Buy milk  ');

      expect(store.todos[0]?.title).toBe('Buy milk');
      expect(store.todos[0]?.id).toBe(TODO_ID);
    });

    it('propagates a validation failure and leaves the list untouched', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ detail: 'title is required.' }, 422));
      const store = useTodosStore();

      await expect(store.create('')).rejects.toThrow('title is required.');
      expect(store.todos).toEqual([]);
    });
  });

  describe('setCompleted', () => {
    it('replaces only the changed task', async () => {
      const other = { ...SAMPLE_TODO, id: 'a0000000-0000-4000-8000-000000000000' };
      const updated = { ...SAMPLE_TODO, completed: true };
      fetchMock.mockResolvedValue(jsonResponse({ todo: updated }));
      const store = useTodosStore();
      store.todos = [SAMPLE_TODO, other];

      await store.setCompleted(TODO_ID, true);

      expect(store.todos).toEqual([updated, other]);
    });

    it('sends only the completed field', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ todo: { ...SAMPLE_TODO, completed: true } }));
      const store = useTodosStore();

      await store.setCompleted(TODO_ID, true);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body as string)).toEqual({ completed: true });
    });
  });

  describe('remove', () => {
    it('removes the task after the API confirms deletion', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
      const store = useTodosStore();
      store.todos = [SAMPLE_TODO];

      await store.remove(TODO_ID);

      expect(store.todos).toEqual([]);
    });

    // Removing it locally first would hide a failed delete and show a list that disagrees with the
    // server until the next reload.
    it('keeps the task when deletion fails', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ detail: 'Task not found.' }, 404));
      const store = useTodosStore();
      store.todos = [SAMPLE_TODO];

      await expect(store.remove(TODO_ID)).rejects.toThrow('Task not found.');
      expect(store.todos).toEqual([SAMPLE_TODO]);
    });
  });

  describe('clearCompleted', () => {
    it('retains only outstanding tasks', async () => {
      const done = { ...SAMPLE_TODO, completed: true };
      const pending = {
        ...SAMPLE_TODO,
        id: 'a0000000-0000-4000-8000-000000000000',
        completed: false
      };
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
      const store = useTodosStore();
      store.todos = [done, pending];

      await store.clearCompleted();

      expect(store.todos).toEqual([pending]);
    });
  });

  describe('getters', () => {
    it('counts only outstanding tasks and detects completed ones', () => {
      const store = useTodosStore();
      store.todos = [
        SAMPLE_TODO,
        { ...SAMPLE_TODO, id: 'a0000000-0000-4000-8000-000000000000', completed: true }
      ];

      expect(store.remaining).toBe(1);
      expect(store.hasCompleted).toBe(true);
    });

    it('reports an empty list as nothing remaining and nothing completed', () => {
      const store = useTodosStore();
      expect(store.remaining).toBe(0);
      expect(store.hasCompleted).toBe(false);
    });
  });
});
