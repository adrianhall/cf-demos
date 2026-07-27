import { createTestingPinia } from "@pinia/testing";
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { Todo } from "../stores/todos";
import { useTodosStore } from "../stores/todos";
import HomeView from "./HomeView.vue";

/** A TODO fixture supplied through the testing store. */
const todo: Todo = {
  completed: true,
  createdAt: "2026-07-27T10:00:00.000Z",
  id: "5d837139-c37f-4fe3-b95c-69757a3a823d",
  title: "Write tests",
  updatedAt: "2026-07-27T10:00:00.000Z",
};

/** Mount the view with event-focused substitutes for its visual child components. */
function mountHome() {
  return mount(HomeView, {
    global: {
      plugins: [
        createTestingPinia({
          createSpy: vi.fn,
          initialState: { todos: { todos: [todo] } },
        }),
      ],
      stubs: {
        TodoForm: {
          emits: ["create"],
          template:
            "<button data-testid=\"create\" @click=\"$emit('create', 'New task')\" />",
        },
        TodoList: {
          emits: ["complete", "remove"],
          template:
            "<div><button data-testid=\"complete\" @click=\"$emit('complete', { id: 'todo' }, true)\" /><button data-testid=\"remove\" @click=\"$emit('remove', 'todo')\" /></div>",
        },
        VBtn: { template: '<button v-bind="$attrs"><slot /></button>' },
        VCard: { template: "<section><slot /></section>" },
        VCardText: { template: "<div><slot /></div>" },
        VContainer: { template: "<main><slot /></main>" },
        VProgressCircular: true,
      },
    },
  });
}

describe("HomeView", () => {
  it("loads tasks and reports successful user mutations", async () => {
    const wrapper = mountHome();
    const store = useTodosStore();

    await flushPromises();
    await wrapper.get('[data-testid="create"]').trigger("click");
    expect(store.load).toHaveBeenCalledOnce();
    expect(store.create).toHaveBeenCalledWith("New task");
    expect(wrapper.text()).toContain("Task added.");

    await wrapper.get('[data-testid="complete"]').trigger("click");
    await wrapper.get('[data-testid="remove"]').trigger("click");
    await wrapper.get(".todo-footer button").trigger("click");

    expect(store.setCompleted).toHaveBeenCalledWith({ id: "todo" }, true);
    expect(store.remove).toHaveBeenCalledWith("todo");
    expect(store.clearCompleted).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("Completed tasks cleared.");
  });

  it("reports mutation failures without removing the task interface", async () => {
    const wrapper = mountHome();
    const store = useTodosStore();
    vi.mocked(store.create).mockRejectedValueOnce(new Error("Create failed."));

    await wrapper.get('[data-testid="create"]').trigger("click");

    expect(wrapper.text()).toContain("Create failed.");
    expect(wrapper.get('[data-testid="create"]')).toBeDefined();
  });

  it("reports failures for complete, delete, and clear-completed actions", async () => {
    const wrapper = mountHome();
    const store = useTodosStore();
    vi.mocked(store.setCompleted).mockRejectedValueOnce(
      new Error("Update failed."),
    );
    vi.mocked(store.remove).mockRejectedValueOnce(new Error("Delete failed."));
    vi.mocked(store.clearCompleted).mockRejectedValueOnce(
      new Error("Clear failed."),
    );

    await wrapper.get('[data-testid="complete"]').trigger("click");
    expect(wrapper.text()).toContain("Update failed.");

    await wrapper.get('[data-testid="remove"]').trigger("click");
    expect(wrapper.text()).toContain("Delete failed.");

    await wrapper.get(".todo-footer button").trigger("click");
    expect(wrapper.text()).toContain("Clear failed.");
  });

  it("surfaces the initial loading error", async () => {
    const wrapper = mount(HomeView, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: { todos: { error: "Load failed." } },
          }),
        ],
        stubs: {
          TodoForm: true,
          TodoList: true,
          VBtn: { template: "<button><slot /></button>" },
          VCard: { template: "<section><slot /></section>" },
          VCardText: { template: "<div><slot /></div>" },
          VContainer: { template: "<main><slot /></main>" },
          VProgressCircular: true,
        },
      },
    });

    await flushPromises();

    expect(wrapper.text()).toContain("Load failed.");
  });

  it("shows the loading indicator and singular remaining-task label", () => {
    const wrapper = mount(HomeView, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: {
              todos: { loading: true, todos: [{ ...todo, completed: false }] },
            },
          }),
        ],
        stubs: {
          TodoForm: true,
          TodoList: { template: '<div data-testid="list" />' },
          VBtn: { template: "<button><slot /></button>" },
          VCard: { template: "<section><slot /></section>" },
          VCardText: { template: "<div><slot /></div>" },
          VContainer: { template: "<main><slot /></main>" },
          VProgressCircular: { template: '<div data-testid="loading" />' },
        },
      },
    });

    expect(wrapper.get('[data-testid="loading"]')).toBeDefined();
    expect(wrapper.find('[data-testid="list"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("1 task remaining");
  });

  it("uses the action-specific fallback for non-Error failures", async () => {
    const wrapper = mountHome();
    const store = useTodosStore();
    vi.mocked(store.setCompleted).mockRejectedValueOnce("offline");

    await wrapper.get('[data-testid="complete"]').trigger("click");

    expect(wrapper.text()).toContain("Could not update the task.");
  });
});
