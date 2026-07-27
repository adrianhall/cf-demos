import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import UploadForm from "./UploadForm.vue";

/** Minimal Vuetify stubs that retain form event contracts for component tests. */
const stubs = {
  VAlert: { template: "<div><slot /></div>" },
  VBtn: { template: "<button><slot /></button>" },
  VCard: { template: "<section><slot /></section>" },
  VCardItem: { template: "<div><slot /></div>" },
  VCardText: { template: "<div><slot /></div>" },
  VFileInput: {
    name: "VFileInput",
    template:
      '<input type="file" @change="$emit(\'update:modelValue\', $event.target.files[0])" />',
  },
  VProgressLinear: { template: "<div><slot /></div>" },
  VTextField: {
    name: "VTextField",
    template:
      '<input type="text" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
};

describe("UploadForm", () => {
  it("emits a normalized upload after valid title and file selection", async () => {
    const wrapper = mount(UploadForm, {
      global: { stubs },
      props: { progress: null },
    });
    const file = new File(["image bytes"], "sample.png", { type: "image/png" });

    await wrapper
      .getComponent({ name: "VTextField" })
      .vm.$emit("update:modelValue", "  Sample image  ");
    await wrapper
      .getComponent({ name: "VFileInput" })
      .vm.$emit("update:modelValue", file);
    await wrapper.find("form").trigger("submit");

    expect(wrapper.emitted("upload")).toEqual([
      [{ file, title: "Sample image" }],
    ]);
  });

  it("shows a validation error instead of emitting unsupported media", async () => {
    const wrapper = mount(UploadForm, {
      global: { stubs },
      props: { progress: null },
    });
    await wrapper
      .getComponent({ name: "VTextField" })
      .vm.$emit("update:modelValue", "Document");
    await wrapper
      .getComponent({ name: "VFileInput" })
      .vm.$emit(
        "update:modelValue",
        new File(["pdf"], "document.pdf", { type: "application/pdf" }),
      );
    await wrapper.find("form").trigger("submit");

    expect(wrapper.text()).toContain("This file type is not supported.");
    expect(wrapper.emitted("upload")).toBeUndefined();
  });

  it.each([
    ["", null, "Enter a title between 1 and 280 characters."],
    ["Valid title", null, "Choose an image, audio file, or video file."],
    [
      "Large image",
      (() => {
        const file = new File(["large"], "large.png", { type: "image/png" });
        Object.defineProperty(file, "size", { value: 100 * 1024 * 1024 + 1 });
        return file;
      })(),
      "Media must not exceed 100 MB.",
    ],
  ])("validates invalid upload input", async (title, file, message) => {
    const wrapper = mount(UploadForm, {
      global: { stubs },
      props: { progress: 42 },
    });
    await wrapper
      .getComponent({ name: "VTextField" })
      .vm.$emit("update:modelValue", title);
    if (file !== null) {
      await wrapper
        .getComponent({ name: "VFileInput" })
        .vm.$emit("update:modelValue", file);
    }
    await wrapper.find("form").trigger("submit");

    expect(wrapper.text()).toContain(message);
    expect(wrapper.text()).toContain("42%");
  });

  it("resets exposed form state", async () => {
    const wrapper = mount(UploadForm, {
      global: { stubs },
      props: { progress: null },
    });
    await wrapper
      .getComponent({ name: "VTextField" })
      .vm.$emit("update:modelValue", "Title");
    await wrapper
      .getComponent({ name: "VFileInput" })
      .vm.$emit(
        "update:modelValue",
        new File(["image"], "sample.png", { type: "image/png" }),
      );

    (wrapper.vm as unknown as { reset: () => void }).reset();
    await wrapper.vm.$nextTick();
    await wrapper.find("form").trigger("submit");

    expect(wrapper.text()).toContain(
      "Enter a title between 1 and 280 characters.",
    );
  });
});
