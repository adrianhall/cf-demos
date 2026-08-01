import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ChatComposer from "./ChatComposer.vue";

describe("ChatComposer", () => {
  it("sends a trimmed, non-empty prompt and clears the composer", async () => {
    const wrapper = mount(ChatComposer, { props: { isStreaming: false } });
    const textarea = wrapper.get("textarea");

    await textarea.setValue("  What is the capital of France?  ");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("send")).toEqual([
      ["What is the capital of France?"],
    ]);
    expect((textarea.element as HTMLTextAreaElement).value).toBe("");
  });

  it("does not emit send for a blank draft", async () => {
    const wrapper = mount(ChatComposer, { props: { isStreaming: false } });

    await wrapper.get("textarea").setValue("   ");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("send")).toBeUndefined();
  });

  it("submits on Enter but inserts a newline on Shift+Enter", async () => {
    const wrapper = mount(ChatComposer, { props: { isStreaming: false } });
    const textarea = wrapper.get("textarea");

    await textarea.setValue("Hello");
    await textarea.trigger("keydown", { key: "Enter", shiftKey: true });
    expect(wrapper.emitted("send")).toBeUndefined();

    await textarea.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("send")).toEqual([["Hello"]]);
  });

  it("disables the textarea and shows Stop instead of Send while streaming", () => {
    const wrapper = mount(ChatComposer, { props: { isStreaming: true } });

    expect(wrapper.get("textarea").attributes("disabled")).toBeDefined();
    expect(wrapper.find(".send-button").exists()).toBe(false);
    expect(wrapper.get(".stop-button").text()).toContain("Stop");
  });

  it("emits stop when the Stop control is activated", async () => {
    const wrapper = mount(ChatComposer, { props: { isStreaming: true } });

    await wrapper.get(".stop-button").trigger("click");

    expect(wrapper.emitted("stop")).toHaveLength(1);
  });

  it("disables Send while the draft is empty", () => {
    const wrapper = mount(ChatComposer, { props: { isStreaming: false } });

    expect(wrapper.get(".send-button").attributes("disabled")).toBeDefined();
  });
});
