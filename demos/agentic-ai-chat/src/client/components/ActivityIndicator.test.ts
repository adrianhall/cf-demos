import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ActivityIndicator from "./ActivityIndicator.vue";

describe("ActivityIndicator", () => {
  it("renders a status role with a text label alongside the animated dots", () => {
    const wrapper = mount(ActivityIndicator);

    const status = wrapper.get('[role="status"]');
    expect(status.text()).toContain("Waiting for the agent to respond");
    expect(wrapper.findAll(".dot")).toHaveLength(3);
  });

  it("hides the decorative dots from assistive technology", () => {
    const wrapper = mount(ActivityIndicator);

    expect(wrapper.get(".dots").attributes("aria-hidden")).toBe("true");
  });
});
