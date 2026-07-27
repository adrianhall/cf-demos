import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTodosStore, type Todo } from "./todos";

/** A stable TODO fixture returned by mocked API responses. */
const todo: Todo = {
  completed: false,
  createdAt: "2026-07-27T10:00:00.000Z",
  id: "5d837139-c37f-4fe3-b95c-69757a3a823d",
  title: "Write tests",
  updatedAt: "2026-07-27T10:00:00.000Z",
};

/** Build a JSON response with the requested HTTP status. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("useTodosStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads TODOs and derives remaining and completed state", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        todos: [todo, { ...todo, completed: true, id: "completed" }],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const store = useTodosStore();

    await store.load();

    expect(fetch).toHaveBeenCalledWith("/api/todos");
    expect(store.todos).toHaveLength(2);
    expect(store.remaining).toBe(1);
    expect(store.hasCompleted).toBe(true);
    expect(store.loading).toBe(false);
  });

  it("stores a problem-detail message when loading fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ detail: "Access expired." }, 401)),
    );
    const store = useTodosStore();

    await store.load();

    expect(store.error).toBe("Access expired.");
    expect(store.loading).toBe(false);
  });

  it("falls back to an HTTP-status message for a non-JSON load failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("upstream error", { status: 502 })),
    );
    const store = useTodosStore();

    await store.load();

    expect(store.error).toBe("Request failed with status 502.");
  });

  it("persists create, complete, remove, and clear-completed transactions", async () => {
    const completedTodo = { ...todo, completed: true };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ todo }))
      .mockResolvedValueOnce(jsonResponse({ todo: completedTodo }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const store = useTodosStore();

    await store.create(todo.title);
    await store.setCompleted(todo, true);
    expect(store.todos).toEqual([completedTodo]);

    await store.remove(todo.id);
    expect(store.todos).toEqual([]);

    store.todos = [completedTodo, { ...todo, id: "active" }];
    await store.clearCompleted();

    expect(store.todos).toEqual([{ ...todo, id: "active" }]);
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/todos", {
      body: JSON.stringify({ title: todo.title }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(fetch).toHaveBeenNthCalledWith(2, `/api/todos/${todo.id}`, {
      body: JSON.stringify({ completed: true }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    expect(fetch).toHaveBeenNthCalledWith(3, `/api/todos/${todo.id}`, {
      method: "DELETE",
    });
    expect(fetch).toHaveBeenNthCalledWith(4, "/api/todos/completed", {
      method: "DELETE",
    });
  });

  it("does not alter local state after a failed mutation", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: "Create failed." }, 422))
      .mockResolvedValueOnce(jsonResponse({ detail: "Update failed." }, 422))
      .mockResolvedValueOnce(jsonResponse({ detail: "Delete failed." }, 422))
      .mockResolvedValueOnce(jsonResponse({ detail: "Clear failed." }, 422));
    vi.stubGlobal("fetch", fetch);
    const store = useTodosStore();
    store.todos = [todo];

    await expect(store.create(todo.title)).rejects.toThrow("Create failed.");
    await expect(store.setCompleted(todo, true)).rejects.toThrow(
      "Update failed.",
    );
    await expect(store.remove(todo.id)).rejects.toThrow("Delete failed.");
    await expect(store.clearCompleted()).rejects.toThrow("Clear failed.");

    expect(store.todos).toEqual([todo]);
  });

  it("uses a safe message when loading rejects a non-Error value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
    const store = useTodosStore();

    await store.load();

    expect(store.error).toBe("Could not load tasks.");
  });

  it("replaces only the TODO returned by a completion update", async () => {
    const updated = { ...todo, completed: true };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ todo: updated })),
    );
    const store = useTodosStore();
    const untouched = { ...todo, id: "untouched" };
    store.todos = [todo, untouched];

    await store.setCompleted(todo, true);

    expect(store.todos).toEqual([updated, untouched]);
  });
});
