import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import MessageComposer from "./MessageComposer.vue";

/** Mount the composer with small DOM-focused Vuetify substitutes. */
function mountComposer(disabled = false) {
  return mount(MessageComposer, {
    props: { disabled },
    global: {
      stubs: {
        FeatherIcon: true,
        VBtn: {
          props: ["disabled"],
          template:
            '<button :disabled="disabled" v-bind="$attrs"><slot /></button>',
        },
        VTextField: {
          emits: ["update:modelValue"],
          props: ["disabled", "modelValue"],
          template:
            '<input :disabled="disabled" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
      },
    },
  });
}

describe("MessageComposer", () => {
  it("emits a trimmed message and clears the draft after submission", async () => {
    const wrapper = mountComposer();

    await wrapper.get("input").setValue("  Hello, room  ");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("send")).toEqual([["Hello, room"]]);
    expect((wrapper.get("input").element as HTMLInputElement).value).toBe("");
  });

  it("does not emit a blank message", async () => {
    const wrapper = mountComposer();

    await wrapper.get("input").setValue("   ");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("send")).toBeUndefined();
  });

  it("disables the input and send button while there is no open connection", () => {
    const wrapper = mountComposer(true);

    expect(wrapper.get("input").attributes("disabled")).toBeDefined();
    expect(wrapper.get("button").attributes("disabled")).toBeDefined();
  });
});
