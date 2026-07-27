import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import HomeView from "./HomeView.vue";

describe("HomeView", () => {
  it("renders the Phase 1/2 scaffold placeholder", () => {
    const wrapper = mount(HomeView, {
      global: {
        stubs: {
          VContainer: { template: "<main><slot /></main>" },
        },
      },
    });

    expect(wrapper.text()).toContain("Chat");
    expect(wrapper.text()).toContain(
      "The channel workspace UI is not implemented yet.",
    );
  });
});
