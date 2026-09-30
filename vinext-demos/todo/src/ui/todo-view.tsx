'use client';

import { type FormEvent, useEffect, useState } from 'react';
import {
  clearCompletedTodos,
  createTodo,
  deleteTodo,
  listTodos,
  setTodoCompleted,
  type Todo
} from './todo-api';

/**
 * Longest title the API accepts, mirroring `MAX_TITLE_LENGTH` in
 * `src/worker/domain/todo-validation.ts`. Applied to the input as a convenience so the field cannot
 * be overfilled; the Worker enforces the same bound independently, which is the check that actually
 * matters.
 */
const MAX_TITLE_LENGTH = 280;

/**
 * Get a user-safe display message from an unknown failure.
 *
 * @param error Failure caught from an asynchronous UI action.
 * @param fallback Message to show when the failure carries nothing displayable.
 * @returns A message suitable for rendering.
 */
function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * The signed-in user's private task list.
 *
 * Every task shown here is scoped to the verified Cloudflare Access identity by the Worker, so this
 * component neither sends nor stores a user identifier — there is no client-side filtering to get
 * wrong. Server state is held in `todos` and replaced from each API response rather than updated
 * optimistically, so the rendered list always reflects what was actually persisted.
 *
 * Failures are reported per interaction and never discard the list: a rejected write means local
 * state already matches the server, so the correct recovery is a message rather than a refetch.
 *
 * @returns The task page: creation form, task list, remaining count, and status messages.
 */
export function TodoView(): React.JSX.Element {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;

    /**
     * Load the task list once, ignoring the result if the component unmounted first.
     *
     * @returns A promise fulfilled once the list or its failure message has been stored.
     */
    async function load(): Promise<void> {
      try {
        const values = await listTodos();
        if (active) {
          setTodos(values);
        }
      } catch (error) {
        if (active) {
          setMessage(errorMessage(error, 'Could not load your tasks.'));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, []);

  /**
   * Create a task from the form and place the server-confirmed item at the top of the list.
   *
   * Whitespace-only input is dropped without an error, because it is almost always an accidental
   * Enter press rather than a mistake worth reporting.
   *
   * @param event Native form-submission event.
   * @returns A promise fulfilled once the list and status message reflect the outcome.
   */
  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const value = title.trim();
    if (value.length === 0) {
      return;
    }

    setMessage('');
    setPending(true);
    try {
      const todo = await createTodo(value);
      setTodos((current) => [todo, ...current]);
      setTitle('');
      setMessage('Task added.');
    } catch (error) {
      setMessage(errorMessage(error, 'Could not add the task.'));
    } finally {
      setPending(false);
    }
  }

  /**
   * Persist a task's completion state.
   *
   * No success message is shown: the checkbox and strikethrough already reflect the outcome, so an
   * extra line of text would be noise.
   *
   * @param id Identifier of the task being toggled.
   * @param completed Desired completion state.
   * @returns A promise fulfilled once the change is persisted or a failure message is shown.
   */
  async function handleComplete(id: string, completed: boolean): Promise<void> {
    setMessage('');
    try {
      const todo = await setTodoCompleted(id, completed);
      setTodos((current) => current.map((value) => (value.id === id ? todo : value)));
    } catch (error) {
      setMessage(errorMessage(error, 'Could not update the task.'));
    }
  }

  /**
   * Delete one task, removing it locally only after the API confirms.
   *
   * @param id Identifier of the task to delete.
   * @returns A promise fulfilled once the task is gone or a failure message is shown.
   */
  async function handleDelete(id: string): Promise<void> {
    setMessage('');
    try {
      await deleteTodo(id);
      setTodos((current) => current.filter((todo) => todo.id !== id));
      setMessage('Task deleted.');
    } catch (error) {
      setMessage(errorMessage(error, 'Could not delete the task.'));
    }
  }

  /**
   * Delete every completed task, removing them locally only after the API confirms.
   *
   * @returns A promise fulfilled once the tasks are cleared or a failure message is shown.
   */
  async function handleClearCompleted(): Promise<void> {
    setMessage('');
    try {
      await clearCompletedTodos();
      setTodos((current) => current.filter((todo) => !todo.completed));
      setMessage('Completed tasks cleared.');
    } catch (error) {
      setMessage(errorMessage(error, 'Could not clear completed tasks.'));
    }
  }

  const remaining = todos.filter((todo) => !todo.completed).length;
  const hasCompleted = todos.some((todo) => todo.completed);

  return (
    <main className="container">
      <section className="intro">
        <p className="eyebrow">Cloudflare Access + D1</p>
        <h1>Your task list</h1>
        <p className="subtitle">Tasks are private to your signed-in Cloudflare Access identity.</p>
      </section>

      <section className="card" aria-labelledby="create-heading">
        <h2 className="sr-only" id="create-heading">
          Add a task
        </h2>
        <form className="todo-form" onSubmit={(event) => void handleCreate(event)}>
          <label>
            What needs doing?
            <input
              aria-label="What needs doing?"
              autoComplete="off"
              maxLength={MAX_TITLE_LENGTH}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Plan the next task"
              required
              type="text"
              value={title}
            />
          </label>
          <button disabled={pending} type="submit">
            Add task
          </button>
        </form>
      </section>

      <section className="card" aria-labelledby="tasks-heading">
        <h2 className="sr-only" id="tasks-heading">
          Your tasks
        </h2>

        {loading ? <p role="status">Loading tasks…</p> : null}

        {!loading && todos.length === 0 ? (
          <p>Nothing on your list yet. Add a task to begin.</p>
        ) : null}

        {todos.length > 0 ? (
          <ul aria-label="Your tasks" className="todo-list">
            {todos.map((todo) => (
              <li key={todo.id}>
                <label className="todo-item">
                  <input
                    aria-label={`${todo.completed ? 'Mark active' : 'Mark complete'}: ${todo.title}`}
                    checked={todo.completed}
                    onChange={(event) => void handleComplete(todo.id, event.target.checked)}
                    type="checkbox"
                  />
                  <span className={todo.completed ? 'completed' : undefined}>{todo.title}</span>
                </label>
                <button
                  aria-label={`Delete task: ${todo.title}`}
                  onClick={() => void handleDelete(todo.id)}
                  type="button"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <footer className="todo-footer">
          <span aria-live="polite">
            {remaining} {remaining === 1 ? 'task' : 'tasks'} remaining
          </span>
          <button
            disabled={!hasCompleted}
            onClick={() => void handleClearCompleted()}
            type="button"
          >
            Clear completed items
          </button>
        </footer>
      </section>

      {message ? (
        <p className="status" role="status">
          {message}
        </p>
      ) : null}
    </main>
  );
}
