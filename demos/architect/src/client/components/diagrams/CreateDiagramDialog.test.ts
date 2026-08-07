import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import CreateDiagramDialog from "./CreateDiagramDialog.vue";

const stubs = {
  VDialog: { props: ["modelValue"], template: "<div><slot /></div>" },
  VCard: { template: "<section><slot /></section>" },
  VCardText: { template: "<div><slot /></div>" },
  VCardActions: { template: "<div><slot /></div>" },
  VSpacer: { template: "<span />" },
  VTextField: {
    emits: ["update:modelValue"],
    props: ["modelValue"],
    template:
      '<input class="title-field" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  VRadioGroup: {
    emits: ["update:modelValue"],
    props: ["modelValue"],
    template: "<div><slot /></div>",
  },
  VRadio: {
    props: ["label", "value"],
    template:
      '<button class="blueprint-radio" @click="$emit(\'select\')">{{ label }}</button>',
  },
  VBtn: {
    props: ["disabled"],
    template: '<button v-bind="$attrs" :disabled="disabled"><slot /></button>',
  },
};

function mountDialog() {
  return mount(CreateDiagramDialog, {
    props: { open: true, pending: false },
    global: { stubs },
  });
}

describe("CreateDiagramDialog", () => {
  it("emits create with the trimmed title and default blueprint", async () => {
    const wrapper = mountDialog();
    await wrapper.get("input.title-field").setValue("  My diagram  ");
    // The Cancel button renders first; the Create button is the last plain (non-radio) button.
    const buttons = wrapper
      .findAll("button")
      .filter((button) => !button.classes().includes("blueprint-radio"));
    await buttons[buttons.length - 1].trigger("click");
    expect(wrapper.emitted("create")).toEqual([["My diagram", "blank"]]);
  });

  it("does not emit create for a blank title", async () => {
    const wrapper = mountDialog();
    const buttons = wrapper
      .findAll("button")
      .filter((button) => !button.classes().includes("blueprint-radio"));
    await buttons[buttons.length - 1].trigger("click");
    expect(wrapper.emitted("create")).toBeUndefined();
  });
});
