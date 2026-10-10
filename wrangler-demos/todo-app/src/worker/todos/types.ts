/** A TODO item owned by one verified Cloudflare Access identity. */
export interface Todo {
  /** Immutable UUID assigned when the TODO is created. */
  id: string;
  /** Human-readable task text, normalized by validation. */
  title: string;
  /** Whether the task has been completed. */
  completed: boolean;
  /** ISO-8601 timestamp recorded when the task was created. */
  createdAt: string;
  /** ISO-8601 timestamp recorded when the task was last changed. */
  updatedAt: string;
}

/** Validated input required to create a TODO item. */
export interface CreateTodoInput {
  /** Normalized task text. */
  title: string;
}

/** Validated set of mutable TODO fields. */
export interface UpdateTodoInput {
  /** Replacement task text, when renaming the task. */
  title?: string;
  /** Replacement completion state, when toggling the task. */
  completed?: boolean;
}
