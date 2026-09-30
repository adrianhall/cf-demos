/**
 * @file Same-origin HTTP client for the task API. This is the only module in the UI tier that knows
 *   the API's URLs and payload shapes, so components deal in tasks rather than in `fetch` calls. It
 *   never sends an identity: the Worker derives the owner from the verified Cloudflare Access JWT
 *   (see `src/worker/routes/identity.ts`), so there is nothing for the client to pass and no way
 *   for it to ask for another user's tasks.
 */

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
 * Execute an API request that returns no content.
 *
 * `Content-Type` is deliberately omitted: these requests carry no body, so announcing a JSON
 * payload that does not exist would be misleading.
 *
 * @param path Same-origin API path to request.
 * @param method HTTP method to use.
 * @returns A promise fulfilled once the API confirms the operation with a `204`.
 * @throws {Error} When authentication, transport, or API processing fails.
 */
async function requestNoContent(path: string, method: string): Promise<void> {
  const response = await fetch(path, { method });
  if (!response.ok) {
    throw await requestError(response);
  }
}

/**
 * Fetch every task belonging to the signed-in user.
 *
 * @returns That user's tasks, newest first. An empty array for a user who has none, which is not an
 *   error.
 * @throws {Error} When authentication, transport, or API processing fails.
 */
export async function listTodos(): Promise<Todo[]> {
  return (await request<{ todos: Todo[] }>('/api/todos')).todos;
}

/**
 * Create a task.
 *
 * @param title Task title entered by the user.
 * @returns The API-confirmed task, carrying its real identifier and timestamps rather than the
 *   optimistic values the caller submitted.
 * @throws {Error} When validation, authentication, transport, or API processing fails.
 */
export async function createTodo(title: string): Promise<Todo> {
  return (
    await request<{ todo: Todo }>('/api/todos', {
      body: JSON.stringify({ title }),
      method: 'POST'
    })
  ).todo;
}

/**
 * Persist a task's completion state.
 *
 * @param id Identifier of the task to change.
 * @param completed Desired completion state.
 * @returns The API-confirmed task.
 * @throws {Error} When authentication, transport, or API processing fails, or the task is not the
 *   signed-in user's (`404`).
 */
export async function setTodoCompleted(id: string, completed: boolean): Promise<Todo> {
  return (
    await request<{ todo: Todo }>(`/api/todos/${encodeURIComponent(id)}`, {
      body: JSON.stringify({ completed }),
      method: 'PATCH'
    })
  ).todo;
}

/**
 * Delete one task.
 *
 * @param id Identifier of the task to delete.
 * @returns A promise fulfilled once the API confirms the deletion.
 * @throws {Error} When authentication, transport, or API processing fails, or the task is not the
 *   signed-in user's (`404`).
 */
export async function deleteTodo(id: string): Promise<void> {
  await requestNoContent(`/api/todos/${encodeURIComponent(id)}`, 'DELETE');
}

/**
 * Delete every completed task belonging to the signed-in user.
 *
 * @returns A promise fulfilled once the API confirms the deletion, including when the user had no
 *   completed tasks — clearing nothing is a successful outcome.
 * @throws {Error} When authentication, transport, or API processing fails.
 */
export async function clearCompletedTodos(): Promise<void> {
  await requestNoContent('/api/todos/completed', 'DELETE');
}

/**
 * Fetch the Worker's verified view of the current Cloudflare Access identity.
 *
 * This is how the UI notices an expired Access session: once the JWT is no longer valid, `/api/me`
 * answers `401` and this resolves to `null` rather than rejecting, because an unavailable identity
 * indicator must not prevent the rest of the page from rendering.
 *
 * @returns The verified identity's email address, or `null` when the session cannot be verified.
 */
export async function getIdentity(): Promise<string | null> {
  try {
    const response = await fetch('/api/me');
    if (!response.ok) {
      return null;
    }
    return ((await response.json()) as { email: string }).email;
  } catch {
    return null;
  }
}
