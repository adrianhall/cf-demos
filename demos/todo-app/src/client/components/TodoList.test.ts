import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { Todo } from "../stores/todos";
import TodoList from "./TodoList.vue";

/** A TODO fixture used to verify list events and labels. */
const todo: Todo = {
  completed: false,
  createdAt: "2026-07-27T10:00:00.000Z",
  id: "5d837139-c37f-4fe3-b95c-69757a3a823d",
  title: "Write tests",
  updatedAt: "2026-07-27T10:00:00.000Z",
};

/** Mount the list with slot-preserving Vuetify substitutes. */
function mountList(todos: Todo[]) {
  return mount(TodoList, {
    props: { todos },
    global: {
      stubs: {
        VBtn: { template: '<button v-bind="$attrs"><slot /></button>' },
        VCard: { template: "<div><slot /></div>" },
        VCardText: { template: "<div><slot /></div>" },
        VList: { template: "<ul><slot /></ul>" },
        VListItem: {
          template:
            '<li><slot name="prepend" /><slot /><slot name="append" /></li>',
        },
        VListItemTitle: { template: "<span><slot /></span>" },
      },
    },
  });
}

describe("TodoList", () => {
  it("renders an empty-list message", () => {
    expect(mountList([]).text()).toContain("Nothing on your list yet");
  });

  it("emits completion and deletion events for a task", async () => {
    const wrapper = mountList([todo]);

    await wrapper.get('input[type="checkbox"]').setValue(true);
    await wrapper
      .get('button[aria-label="Delete task: Write tests"]')
      .trigger("click");

    expect(wrapper.emitted("complete")).toEqual([[todo, true]]);
    expect(wrapper.emitted("remove")).toEqual([[todo.id]]);
  });

  it("labels completed TODOs as active actions", () => {
    const wrapper = mountList([{ ...todo, completed: true }]);

    expect(wrapper.get('input[type="checkbox"]').attributes("aria-label")).toBe(
      "Mark active: Write tests",
    );
  });
});
