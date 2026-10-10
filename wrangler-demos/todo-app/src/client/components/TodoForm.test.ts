import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import TodoForm from "./TodoForm.vue";

/** Mount the form with small DOM-focused Vuetify substitutes. */
function mountForm() {
  return mount(TodoForm, {
    global: {
      stubs: {
        VBtn: { template: '<button v-bind="$attrs"><slot /></button>' },
        VTextField: {
          emits: ["update:modelValue"],
          props: ["modelValue"],
          template:
            '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
      },
    },
  });
}

describe("TodoForm", () => {
  it("emits a trimmed title and clears the field after submission", async () => {
    const wrapper = mountForm();

    await wrapper.get("input").setValue("  Write tests  ");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("create")).toEqual([["Write tests"]]);
    expect((wrapper.get("input").element as HTMLInputElement).value).toBe("");
  });

  it("does not emit a blank task", async () => {
    const wrapper = mountForm();

    await wrapper.get("input").setValue("   ");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("create")).toBeUndefined();
  });
});
