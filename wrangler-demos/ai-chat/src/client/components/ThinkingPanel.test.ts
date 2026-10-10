import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ThinkingPanel from "./ThinkingPanel.vue";

describe("ThinkingPanel", () => {
  it("renders the reasoning text inside a collapsed details element", () => {
    const wrapper = mount(ThinkingPanel, {
      props: { text: "First, recall the capital of France." },
    });

    const details = wrapper.get("details");
    expect(details.attributes("open")).toBeUndefined();
    expect(wrapper.get("summary").text()).toBe("Thinking");
    expect(wrapper.text()).toContain("First, recall the capital of France.");
  });

  it("updates as more reasoning text streams in", async () => {
    const wrapper = mount(ThinkingPanel, { props: { text: "Step one." } });

    await wrapper.setProps({ text: "Step one. Step two." });

    expect(wrapper.text()).toContain("Step one. Step two.");
  });
});
