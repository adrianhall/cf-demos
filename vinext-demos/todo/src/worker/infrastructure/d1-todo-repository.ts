import { notFound } from '@adrianhall/cloudflare-toolkit/errors';
import type { CreateTodoInput, Todo, TodoRepository, UpdateTodoInput } from '../domain/todo';

/**
 * Columns selected for every task read. Kept as one constant so the projection, the {@link TodoRow}
 * type, and {@link toTodo} cannot drift apart as the schema evolves.
 */
const TODO_COLUMNS = 'id, title, completed, created_at, updated_at';

/**
 * Raw snake_cased row as stored in D1. SQLite has no boolean type, so `completed` is an integer
 * constrained to `0`/`1` by a `CHECK` in `migrations/0001_create_todos.sql`.
 */
interface TodoRow {
  /**
   * Task UUID.
   */
  id: string;
  /**
   * Task title as stored.
   */
  title: string;
  /**
   * Completion state as `0` or `1`.
   */
  completed: number;
  /**
   * ISO-8601 creation timestamp.
   */
  created_at: string;
  /**
   * ISO-8601 last-update timestamp.
   */
  updated_at: string;
}

/**
 * Convert a stored row into the camelCased domain representation.
 *
 * This mapping is the reason the rest of the application never sees `0`/`1` or snake_case: the
 * storage encoding stops at this tier's boundary.
 *
 * @param row Row returned by a D1 query using {@link TODO_COLUMNS}.
 * @returns The equivalent domain task.
 */
function toTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    title: row.title,
    completed: row.completed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * D1 implementation of the {@link TodoRepository} port.
 *
 * D1 is the right storage choice here — rather than the Workers KV used by the sibling `link` demo
 * — because task lists need a relational predicate (`WHERE user_id = ?`) evaluated server-side,
 * read-your-writes consistency so a user sees a task immediately after creating it, and a
 * schema-level `CHECK` constraint on `completed`. KV offers none of those: it is eventually
 * consistent and can only be queried by key prefix.
 *
 * Every task for every user lives in one `todos` table, distinguished only by its `user_id` column.
 * That is deliberate for this demo: isolation is proven by the query predicate rather than by
 * separate storage per user, which is how a real multi-tenant application behaves. Consequently
 * **every** statement below includes `user_id = ?`, and none of them is reachable without it, since
 * the port requires the identity as its first argument.
 */
export class D1TodoRepository implements TodoRepository {
  /**
   * @param database D1 database bound to this Worker (`env.DB`). Narrowed to the capabilities
   *   actually used so a unit test can supply a small fake rather than a whole `D1Database`.
   */
  constructor(private readonly database: Pick<D1Database, 'prepare'>) {}

  /**
   * List one user's tasks, newest first.
   *
   * @param userId Verified Cloudflare Access identity that owns the tasks.
   * @returns That user's tasks, ordered by creation time descending. An empty array when the user
   *   has no tasks — including a user who has never created one, which is not an error.
   * @throws {Error} When D1 rejects the query.
   */
  async list(userId: string): Promise<Todo[]> {
    const result = await this.database
      .prepare(
        `SELECT ${TODO_COLUMNS} FROM todos WHERE user_id = ? ORDER BY created_at DESC, id DESC`
      )
      .bind(userId)
      .all<TodoRow>();
    return result.results.map(toTodo);
  }

  /**
   * Insert a task owned by one user.
   *
   * The identifier and timestamps are generated here rather than by SQLite defaults, so the
   * returned task is exactly what was written and the caller needs no follow-up read.
   *
   * @param userId Verified Cloudflare Access identity that will own the task.
   * @param input Validated creation input.
   * @returns The persisted task.
   * @throws {Error} When D1 rejects the insert.
   */
  async create(userId: string, input: CreateTodoInput): Promise<Todo> {
    const timestamp = new Date().toISOString();
    const todo: Todo = {
      id: crypto.randomUUID(),
      title: input.title,
      completed: false,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.database
      .prepare(
        'INSERT INTO todos (id, user_id, title, completed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .bind(todo.id, userId, todo.title, 0, todo.createdAt, todo.updatedAt)
      .run();
    return todo;
  }

  /**
   * Read one task, enforcing its ownership boundary in the query itself.
   *
   * @param userId Verified Cloudflare Access identity that must own the task.
   * @param id Validated task UUID.
   * @returns The stored task.
   * @throws {ProblemDetailsError} `notFound()` (404) when no row matches both the identifier and
   *   this user. A task owned by another identity produces the same `404` as one that does not
   *   exist, so the API cannot be used to enumerate other users' identifiers.
   * @throws {Error} When D1 rejects the query.
   */
  async get(userId: string, id: string): Promise<Todo> {
    const row = await this.database
      .prepare(`SELECT ${TODO_COLUMNS} FROM todos WHERE id = ? AND user_id = ? LIMIT 1`)
      .bind(id, userId)
      .first<TodoRow>();
    if (row === null) {
      throw notFound({ detail: 'Task not found.' });
    }
    return toTodo(row);
  }

  /**
   * Apply validated changes to a task owned by one user.
   *
   * Reads the current row first so a partial update can be resolved against stored values, then
   * writes both mutable columns. The `UPDATE` repeats the `user_id` predicate rather than trusting
   * the preceding read: the check and the write are then individually safe, and the ownership
   * guarantee does not depend on the two statements running as one unit.
   *
   * @param userId Verified Cloudflare Access identity that must own the task.
   * @param id Validated task UUID.
   * @param input Validated mutable fields.
   * @returns The updated task, with a refreshed `updatedAt`.
   * @throws {ProblemDetailsError} `notFound()` (404) when the task does not belong to this user.
   * @throws {Error} When D1 rejects the read or the update.
   */
  async update(userId: string, id: string, input: UpdateTodoInput): Promise<Todo> {
    const existing = await this.get(userId, id);
    const updated: Todo = {
      ...existing,
      title: input.title ?? existing.title,
      completed: input.completed ?? existing.completed,
      updatedAt: new Date().toISOString()
    };
    await this.database
      .prepare(
        'UPDATE todos SET title = ?, completed = ?, updated_at = ? WHERE id = ? AND user_id = ?'
      )
      .bind(updated.title, updated.completed ? 1 : 0, updated.updatedAt, id, userId)
      .run();
    return updated;
  }

  /**
   * Delete one task owned by one user.
   *
   * The preceding {@link D1TodoRepository.get} exists to produce a `404` for an identifier the user
   * does not own; without it, `DELETE` would report success for a row that was never theirs.
   *
   * @param userId Verified Cloudflare Access identity that must own the task.
   * @param id Validated task UUID.
   * @returns A promise fulfilled once the row is gone.
   * @throws {ProblemDetailsError} `notFound()` (404) when the task does not belong to this user.
   * @throws {Error} When D1 rejects the read or the deletion.
   */
  async delete(userId: string, id: string): Promise<void> {
    await this.get(userId, id);
    await this.database
      .prepare('DELETE FROM todos WHERE id = ? AND user_id = ?')
      .bind(id, userId)
      .run();
  }

  /**
   * Delete every completed task owned by one user in a single statement.
   *
   * @param userId Verified Cloudflare Access identity whose completed tasks are removed.
   * @returns The number of rows deleted, taken from D1's `meta.changes`, so the API can report the
   *   outcome without a second query.
   * @throws {Error} When D1 rejects the deletion.
   */
  async deleteCompleted(userId: string): Promise<number> {
    const result = await this.database
      .prepare('DELETE FROM todos WHERE user_id = ? AND completed = 1')
      .bind(userId)
      .run();
    return result.meta.changes;
  }
}
