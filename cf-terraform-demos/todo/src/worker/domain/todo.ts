/**
 * A task owned by exactly one verified Cloudflare Access identity.
 */
export interface Todo {
  /**
   * Immutable UUID assigned when the task is created.
   */
  id: string;
  /**
   * Human-readable task text, normalized by domain validation.
   */
  title: string;
  /**
   * Whether the task has been completed.
   */
  completed: boolean;
  /**
   * ISO-8601 timestamp recorded when the task was created.
   */
  createdAt: string;
  /**
   * ISO-8601 timestamp recorded when the task last changed.
   */
  updatedAt: string;
}

/**
 * Validated input required to create a task.
 */
export interface CreateTodoInput {
  /**
   * Normalized task text.
   */
  title: string;
}

/**
 * Validated set of mutable task fields. At least one field is always present — the domain rejects
 * an update that would change nothing, so a caller cannot use a no-op write to probe for the
 * existence of another user's task.
 */
export interface UpdateTodoInput {
  /**
   * Replacement task text, when renaming the task.
   */
  title?: string;
  /**
   * Replacement completion state, when toggling the task.
   */
  completed?: boolean;
}

/**
 * Persistence port owned by the application layer rather than by HTTP routes or a storage product.
 *
 * Every method takes the owner's verified identity as its first argument, so ownership is part of
 * the port's contract rather than an optional filter an implementation might forget. An
 * implementation must scope every read and write by `userId` and must not reveal whether an
 * identifier belongs to a different user — see {@link TodoRepository.get}.
 */
export interface TodoRepository {
  /**
   * List one user's tasks, newest first.
   *
   * @param userId Verified Cloudflare Access identity that owns the tasks.
   * @returns That user's tasks, ordered by creation time descending.
   * @throws {Error} When the underlying storage rejects the read.
   */
  list(userId: string): Promise<Todo[]>;

  /**
   * Persist a new task for one user.
   *
   * @param userId Verified Cloudflare Access identity that will own the task.
   * @param input Validated creation input.
   * @returns The persisted task, including its generated identifier and timestamps.
   * @throws {Error} When the underlying storage rejects the write.
   */
  create(userId: string, input: CreateTodoInput): Promise<Todo>;

  /**
   * Read one task while enforcing its ownership boundary.
   *
   * @param userId Verified Cloudflare Access identity that must own the task.
   * @param id Validated task UUID.
   * @returns The stored task.
   * @throws {ProblemDetailsError} `notFound()` (404) when no task with that identifier belongs to
   *   this user. A task owned by somebody else is reported as absent rather than forbidden, so the
   *   response cannot be used to confirm that another user's identifier exists.
   * @throws {Error} When the underlying storage rejects the read.
   */
  get(userId: string, id: string): Promise<Todo>;

  /**
   * Apply validated changes to a task owned by one user.
   *
   * @param userId Verified Cloudflare Access identity that must own the task.
   * @param id Validated task UUID.
   * @param input Validated mutable fields.
   * @returns The updated task, with a refreshed `updatedAt` timestamp.
   * @throws {ProblemDetailsError} `notFound()` (404) when the task does not belong to this user.
   * @throws {Error} When the underlying storage rejects the read or write.
   */
  update(userId: string, id: string, input: UpdateTodoInput): Promise<Todo>;

  /**
   * Delete a task owned by one user.
   *
   * @param userId Verified Cloudflare Access identity that must own the task.
   * @param id Validated task UUID.
   * @returns A promise fulfilled once the task no longer exists.
   * @throws {ProblemDetailsError} `notFound()` (404) when the task does not belong to this user.
   * @throws {Error} When the underlying storage rejects the deletion.
   */
  delete(userId: string, id: string): Promise<void>;

  /**
   * Delete every completed task owned by one user.
   *
   * @param userId Verified Cloudflare Access identity whose completed tasks are removed.
   * @returns The number of tasks deleted, so the API can report the outcome without a second read.
   * @throws {Error} When the underlying storage rejects the deletion.
   */
  deleteCompleted(userId: string): Promise<number>;
}
