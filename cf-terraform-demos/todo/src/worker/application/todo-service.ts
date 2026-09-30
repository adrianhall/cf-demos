import type { Todo, TodoRepository } from '../domain/todo';
import {
  validateCreateTodoInput,
  validateTodoId,
  validateUpdateTodoInput
} from '../domain/todo-validation';

/**
 * Business logic for personal task lists — the tier between the HTTP API and persistence.
 *
 * Routes hand this service the verified Cloudflare Access identity plus raw, untrusted values (a
 * parsed JSON body, a path parameter) and receive domain objects back. Validation and the order of
 * operations live here rather than in the Hono handlers, so the same rules apply no matter which
 * transport calls them and the routes stay thin enough to read as a description of the API
 * surface.
 *
 * Every method takes `userId` first and passes it straight through to the {@link TodoRepository}
 * port. The service never widens that scope, so no use case can read or write across the ownership
 * boundary — the isolation this demo teaches is enforced in one place rather than per route.
 *
 * The service depends only on the port, not on D1, so the storage technology can change (or be
 * faked in a unit test) without touching business logic.
 */
export class TodoService {
  /**
   * @param repository Persistence port used to store and retrieve tasks.
   */
  constructor(private readonly repository: TodoRepository) {}

  /**
   * List every task belonging to one user.
   *
   * @param userId Verified Cloudflare Access identity that owns the tasks.
   * @returns That user's tasks, newest first.
   * @throws {Error} When the repository cannot list tasks.
   */
  async listTodos(userId: string): Promise<Todo[]> {
    return this.repository.list(userId);
  }

  /**
   * Create a task for one user.
   *
   * @param userId Verified Cloudflare Access identity that will own the task.
   * @param body Unvalidated JSON body from the request.
   * @returns The newly created task.
   * @throws {ProblemDetailsError} When the body is not a valid create-task payload.
   * @throws {Error} When the repository cannot store the task.
   */
  async createTodo(userId: string, body: unknown): Promise<Todo> {
    return this.repository.create(userId, validateCreateTodoInput(body));
  }

  /**
   * Apply a partial update to one of a user's tasks.
   *
   * The body is validated before the identifier is used for a lookup, so an invalid payload cannot
   * be used to probe which identifiers exist.
   *
   * @param userId Verified Cloudflare Access identity that must own the task.
   * @param id Unvalidated task identifier from the request path.
   * @param body Unvalidated JSON body from the request.
   * @returns The updated task.
   * @throws {ProblemDetailsError} When the body is invalid, or the identifier is malformed or does
   *   not belong to this user (reported as `404`).
   * @throws {Error} When the repository cannot read or write the task.
   */
  async updateTodo(userId: string, id: string, body: unknown): Promise<Todo> {
    const input = validateUpdateTodoInput(body);
    return this.repository.update(userId, validateTodoId(id), input);
  }

  /**
   * Delete one of a user's tasks.
   *
   * @param userId Verified Cloudflare Access identity that must own the task.
   * @param id Unvalidated task identifier from the request path.
   * @returns A promise fulfilled once the task has been deleted.
   * @throws {ProblemDetailsError} When the identifier is malformed or does not belong to this user
   *   (both reported as `404`).
   * @throws {Error} When the repository cannot delete the task.
   */
  async deleteTodo(userId: string, id: string): Promise<void> {
    await this.repository.delete(userId, validateTodoId(id));
  }

  /**
   * Delete every completed task belonging to one user.
   *
   * @param userId Verified Cloudflare Access identity whose completed tasks are removed.
   * @returns The number of tasks deleted; `0` when the user had none completed, which is a success
   *   rather than an error.
   * @throws {Error} When the repository cannot delete the tasks.
   */
  async clearCompletedTodos(userId: string): Promise<number> {
    return this.repository.deleteCompleted(userId);
  }
}
