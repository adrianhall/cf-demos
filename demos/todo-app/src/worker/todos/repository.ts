import { notFound } from "@adrianhall/cloudflare-toolkit/errors";
import type { CreateTodoInput, Todo, UpdateTodoInput } from "./types";

/** Raw snake-cased TODO row returned by D1. */
interface TodoRow {
  id: string;
  title: string;
  completed: number;
  created_at: string;
  updated_at: string;
}

/** Convert a D1 row to the API's camel-cased TODO representation. */
function toTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    title: row.title,
    completed: row.completed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * D1 persistence boundary for per-user TODO items. Every lookup and mutation includes the
 * verified Access email in its predicate so an identifier cannot cross user boundaries.
 */
export class TodoRepository {
  /** @param database D1 database bound to this Worker (`env.DB`). */
  constructor(private readonly database: D1Database) {}

  /**
   * List one user's TODOs, newest first.
   *
   * @param userId Verified Cloudflare Access email.
   * @returns The user's TODOs.
   */
  async list(userId: string): Promise<Todo[]> {
    const result = await this.database
      .prepare(
        "SELECT id, title, completed, created_at, updated_at FROM todos WHERE user_id = ? ORDER BY created_at DESC",
      )
      .bind(userId)
      .all<TodoRow>();
    return result.results.map(toTodo);
  }

  /**
   * Create a TODO for one verified user.
   *
   * @param userId Verified Cloudflare Access email.
   * @param input Validated creation input.
   * @returns Newly persisted TODO.
   */
  async create(userId: string, input: CreateTodoInput): Promise<Todo> {
    const timestamp = new Date().toISOString();
    const todo: Todo = {
      id: crypto.randomUUID(),
      title: input.title,
      completed: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.database
      .prepare(
        "INSERT INTO todos (id, user_id, title, completed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(todo.id, userId, todo.title, 0, todo.createdAt, todo.updatedAt)
      .run();
    return todo;
  }

  /**
   * Update a TODO owned by one verified user.
   *
   * @param userId Verified Cloudflare Access email.
   * @param id Validated TODO UUID.
   * @param input Validated mutable fields.
   * @returns Updated TODO.
   * @throws {ProblemDetailsError} When the TODO does not belong to the user.
   */
  async update(
    userId: string,
    id: string,
    input: UpdateTodoInput,
  ): Promise<Todo> {
    const existing = await this.get(userId, id);
    const updatedAt = new Date().toISOString();
    const title = input.title ?? existing.title;
    const completed = input.completed ?? existing.completed;
    await this.database
      .prepare(
        "UPDATE todos SET title = ?, completed = ?, updated_at = ? WHERE id = ? AND user_id = ?",
      )
      .bind(title, completed ? 1 : 0, updatedAt, id, userId)
      .run();
    return { ...existing, title, completed, updatedAt };
  }

  /**
   * Delete a TODO owned by one verified user.
   *
   * @param userId Verified Cloudflare Access email.
   * @param id Validated TODO UUID.
   * @returns Promise resolved after deletion.
   * @throws {ProblemDetailsError} When the TODO does not belong to the user.
   */
  async delete(userId: string, id: string): Promise<void> {
    await this.get(userId, id);
    await this.database
      .prepare("DELETE FROM todos WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .run();
  }

  /**
   * Delete every completed TODO owned by one verified user.
   *
   * @param userId Verified Cloudflare Access email.
   * @returns Promise resolved after all matching TODOs are deleted.
   */
  async deleteCompleted(userId: string): Promise<void> {
    await this.database
      .prepare("DELETE FROM todos WHERE user_id = ? AND completed = 1")
      .bind(userId)
      .run();
  }

  /**
   * Read one TODO while enforcing its owner boundary.
   *
   * @param userId Verified Cloudflare Access email.
   * @param id Validated TODO UUID.
   * @returns Persisted TODO.
   * @throws {ProblemDetailsError} When the TODO does not belong to the user.
   */
  private async get(userId: string, id: string): Promise<Todo> {
    const row = await this.database
      .prepare(
        "SELECT id, title, completed, created_at, updated_at FROM todos WHERE id = ? AND user_id = ? LIMIT 1",
      )
      .bind(id, userId)
      .first<TodoRow>();
    if (row === null) {
      throw notFound({ detail: "TODO not found." });
    }
    return toTodo(row);
  }
}
