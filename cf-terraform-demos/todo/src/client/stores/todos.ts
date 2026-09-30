import { defineStore } from 'pinia';

/**
 * A task as returned by the same-origin task API.
 */
export interface Todo {
  /**
   * Immutable task UUID.
   */
  id: string;
  /**
   * Human-readable task title.
   */
  title: string;
  /**
   * Whether the task has been completed.
   */
  completed: boolean;
  /**
   * ISO-8601 creation timestamp.
   */
  createdAt: string;
  /**
   * ISO-8601 last-update timestamp.
   */
  updatedAt: string;
}

/**
 * RFC 9457 response fields the UI is willing to display.
 */
interface ProblemDetails {
  /**
   * User-safe explanation of a failed request.
   */
  detail?: string;
  /**
   * Standard status-text fallback.
   */
  title?: string;
}

/**
 * Convert an unsuccessful API response into a user-safe error.
 *
 * Only `detail` and `title` are read. The Worker never emits a stack trace in production (see
 * `src/worker/index.ts`), and this keeps the client from rendering anything else even if it did.
 *
 * @param response Non-successful HTTP response returned by the same-origin API.
 * @returns An error carrying the RFC 9457 detail/title, or a generic message when the body is
 *   absent or unparseable.
 */
async function requestError(response: Response): Promise<Error> {
  try {
    const problem = (await response.json()) as ProblemDetails;
    return new Error(problem.detail ?? problem.title ?? 'The request could not be completed.');
  } catch {
    return new Error('The request could not be completed.');
  }
}

/**
 * Execute a JSON API request and decode the response.
 *
 * @typeParam T Expected JSON response shape supplied by the caller.
 * @param path Same-origin API path to request.
 * @param init Optional fetch options, including the HTTP method and request body.
 * @returns The successful response body decoded as the caller's expected shape.
 * @throws {Error} When the API returns a non-success response — with an RFC 9457-derived message
 *   when one is available. Transport and JSON-decoding failures also reject.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers }
  });
  if (!response.ok) {
    throw await requestError(response);
  }
  return (await response.json()) as T;
}

/**
 * Client state and operations for the signed-in user's task list.
 *
 * The store never sends an identity: the Worker derives the owner from the verified Cloudflare
 * Access JWT (see `src/worker/routes/identity.ts`), so there is nothing for the client to pass and
 * no way for it to ask for another user's tasks.
 *
 * Mutating actions propagate errors to the caller rather than storing them. The view renders a
 * per-interaction message, which keeps presentation concerns out of the store; `load` is the one
 * exception, because a failed initial load has no interaction to report against.
 */
export const useTodosStore = defineStore('todos', {
  actions: {
    /**
     * Fetch every task belonging to the signed-in user.
     *
     * @returns A promise fulfilled after `todos` is replaced and `loading` is reset. A failure is
     *   recorded in `error` rather than thrown, so the view can show a message without the initial
     *   page load rejecting.
     */
    async load(): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        const response = await request<{ todos: Todo[] }>('/api/todos');
        this.todos = response.todos;
      } catch (cause) {
        this.error = cause instanceof Error ? cause.message : 'Could not load your tasks.';
      } finally {
        this.loading = false;
      }
    },

    /**
     * Create a task and place the server-confirmed item at the top of the list.
     *
     * The list is rebuilt from the API's response rather than from the submitted title, so the
     * rendered task carries the real identifier and timestamps and no optimistic entry can persist
     * if the write actually failed.
     *
     * @param title Task title entered by the user.
     * @returns The API-confirmed task.
     * @throws {Error} When validation, authentication, transport, or API processing fails.
     */
    async create(title: string): Promise<Todo> {
      const response = await request<{ todo: Todo }>('/api/todos', {
        body: JSON.stringify({ title }),
        method: 'POST'
      });
      this.todos = [response.todo, ...this.todos];
      return response.todo;
    },

    /**
     * Persist a task's completion state and replace it in local state.
     *
     * @param id Identifier of the task to change.
     * @param completed Desired completion state.
     * @returns The API-confirmed task.
     * @throws {Error} When authentication, transport, or API processing fails, or the task is not
     *   the signed-in user's (`404`).
     */
    async setCompleted(id: string, completed: boolean): Promise<Todo> {
      const response = await request<{ todo: Todo }>(`/api/todos/${encodeURIComponent(id)}`, {
        body: JSON.stringify({ completed }),
        method: 'PATCH'
      });
      this.todos = this.todos.map((todo) => (todo.id === id ? response.todo : todo));
      return response.todo;
    },

    /**
     * Delete one task, removing it locally only after the API confirms the deletion.
     *
     * @param id Identifier of the task to delete.
     * @returns A promise fulfilled once the task is gone both remotely and locally.
     * @throws {Error} When authentication, transport, or API processing fails, or the task is not
     *   the signed-in user's (`404`).
     */
    async remove(id: string): Promise<void> {
      const response = await fetch(`/api/todos/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!response.ok) {
        throw await requestError(response);
      }
      this.todos = this.todos.filter((todo) => todo.id !== id);
    },

    /**
     * Delete every completed task, removing them locally only after the API confirms.
     *
     * @returns A promise fulfilled once the completed tasks are gone both remotely and locally.
     * @throws {Error} When authentication, transport, or API processing fails.
     */
    async clearCompleted(): Promise<void> {
      const response = await fetch('/api/todos/completed', { method: 'DELETE' });
      if (!response.ok) {
        throw await requestError(response);
      }
      this.todos = this.todos.filter((todo) => !todo.completed);
    }
  },
  getters: {
    /**
     * Number of tasks still outstanding, shown in the list footer.
     *
     * @param state Current store state.
     * @returns The count of tasks that are not completed.
     */
    remaining: (state): number => state.todos.filter((todo) => !todo.completed).length,

    /**
     * Whether any task is completed, which enables the "clear completed" control.
     *
     * @param state Current store state.
     * @returns `true` when at least one task is completed.
     */
    hasCompleted: (state): boolean => state.todos.some((todo) => todo.completed)
  },
  state: () => ({
    /**
     * The signed-in user's tasks, newest first.
     */
    todos: [] as Todo[],
    /**
     * Whether the initial list request is pending.
     */
    loading: false,
    /**
     * Message from a failed {@link useTodosStore.load}, or `null`.
     */
    error: null as string | null
  })
});
