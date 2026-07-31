import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import HomeView from "./HomeView.vue";

describe("HomeView", () => {
  it("renders a status message for the authenticated shell", () => {
    const wrapper = mount(HomeView, {
      global: {
        stubs: {
          VAlert: { template: '<div role="status"><slot /></div>' },
        },
      },
    });

    expect(wrapper.get('[role="status"]').text()).toContain("signed in");
  });
});
