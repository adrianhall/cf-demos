import { defineStore } from "pinia";
import { computed, shallowRef } from "vue";

/** A task returned by the per-user TODO API. */
export interface Todo {
  /** Immutable task UUID. */
  id: string;
  /** Human-readable task title. */
  title: string;
  /** Whether the task has been completed. */
  completed: boolean;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-update timestamp. */
  updatedAt: string;
}

/** RFC 9457 error response shape used for safe client error messages. */
interface ProblemDetails {
  /** Human-readable explanation of the failed request. */
  detail?: string;
}

/** Read a safe error message from a failed API response. */
async function responseMessage(response: Response): Promise<string> {
  const body = (await response
    .json()
    .catch(() => null)) as ProblemDetails | null;
  return body?.detail ?? `Request failed with status ${response.status}.`;
}

/** Per-user TODO state and API operations for the task interface. */
export const useTodosStore = defineStore("todos", () => {
  const todos = shallowRef<Todo[]>([]);
  const loading = shallowRef(false);
  const error = shallowRef<string | null>(null);
  const remaining = computed(
    () => todos.value.filter((todo) => !todo.completed).length,
  );
  const hasCompleted = computed(() =>
    todos.value.some((todo) => todo.completed),
  );

  /** Fetch all TODOs visible to the verified Access identity. */
  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response = await fetch("/api/todos");
      if (!response.ok) {
        throw new Error(await responseMessage(response));
      }
      const body = (await response.json()) as { todos: Todo[] };
      todos.value = body.todos;
    } catch (cause) {
      error.value =
        cause instanceof Error ? cause.message : "Could not load tasks.";
    } finally {
      loading.value = false;
    }
  }

  /** Create a new task and prepend the persisted item to local state. */
  async function create(title: string): Promise<void> {
    const response = await fetch("/api/todos", {
      body: JSON.stringify({ title }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(await responseMessage(response));
    }
    const body = (await response.json()) as { todo: Todo };
    todos.value = [body.todo, ...todos.value];
  }

  /** Persist a task's completion state and replace it in local state. */
  async function setCompleted(todo: Todo, completed: boolean): Promise<void> {
    const response = await fetch(`/api/todos/${todo.id}`, {
      body: JSON.stringify({ completed }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    if (!response.ok) {
      throw new Error(await responseMessage(response));
    }
    const body = (await response.json()) as { todo: Todo };
    todos.value = todos.value.map((item) =>
      item.id === body.todo.id ? body.todo : item,
    );
  }

  /** Delete a task and remove it from local state after the API confirms deletion. */
  async function remove(id: string): Promise<void> {
    const response = await fetch(`/api/todos/${id}`, { method: "DELETE" });
    if (!response.ok) {
      throw new Error(await responseMessage(response));
    }
    todos.value = todos.value.filter((todo) => todo.id !== id);
  }

  /** Delete all completed tasks and remove them from local state after the API confirms it. */
  async function clearCompleted(): Promise<void> {
    const response = await fetch("/api/todos/completed", { method: "DELETE" });
    if (!response.ok) {
      throw new Error(await responseMessage(response));
    }
    todos.value = todos.value.filter((todo) => !todo.completed);
  }

  return {
    clearCompleted,
    create,
    error,
    hasCompleted,
    load,
    loading,
    remaining,
    remove,
    setCompleted,
    todos,
  };
});
