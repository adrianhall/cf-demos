import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ChatComposer from "./ChatComposer.vue";

describe("ChatComposer", () => {
  it("sends a trimmed, non-empty prompt and clears the composer", async () => {
    const wrapper = mount(ChatComposer, {
      props: { isStreaming: false, disabled: false },
    });
    const textarea = wrapper.get("textarea");

    await textarea.setValue("  What is the capital of France?  ");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("send")).toEqual([
      ["What is the capital of France?"],
    ]);
    expect((textarea.element as HTMLTextAreaElement).value).toBe("");
  });

  it("does not emit send for a blank draft", async () => {
    const wrapper = mount(ChatComposer, {
      props: { isStreaming: false, disabled: false },
    });

    await wrapper.get("textarea").setValue("   ");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("send")).toBeUndefined();
  });

  it("submits on Enter but inserts a newline on Shift+Enter", async () => {
    const wrapper = mount(ChatComposer, {
      props: { isStreaming: false, disabled: false },
    });
    const textarea = wrapper.get("textarea");

    await textarea.setValue("Hello");
    await textarea.trigger("keydown", { key: "Enter", shiftKey: true });
    expect(wrapper.emitted("send")).toBeUndefined();

    await textarea.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("send")).toEqual([["Hello"]]);
  });

  it("disables the textarea and Send control while streaming", () => {
    const wrapper = mount(ChatComposer, {
      props: { isStreaming: true, disabled: false },
    });

    expect(wrapper.get("textarea").attributes("disabled")).toBeDefined();
    expect(wrapper.get(".send-button").attributes("disabled")).toBeDefined();
  });

  it("disables the textarea and Send control while there is no live connection", () => {
    const wrapper = mount(ChatComposer, {
      props: { isStreaming: false, disabled: true },
    });

    expect(wrapper.get("textarea").attributes("disabled")).toBeDefined();
    expect(wrapper.get(".send-button").attributes("disabled")).toBeDefined();
  });

  it("disables Send while the draft is empty", () => {
    const wrapper = mount(ChatComposer, {
      props: { isStreaming: false, disabled: false },
    });

    expect(wrapper.get(".send-button").attributes("disabled")).toBeDefined();
  });
});
