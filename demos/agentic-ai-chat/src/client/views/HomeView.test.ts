import { createTestingPinia } from "@pinia/testing";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import HomeView from "./HomeView.vue";

const stubs = {
  VCard: { template: "<div><slot /></div>" },
  VCardText: { template: "<div><slot /></div>" },
  VContainer: { template: "<div><slot /></div>" },
};

describe("HomeView", () => {
  it("shows the baseline placeholder once the session is authenticated", () => {
    const wrapper = mount(HomeView, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: { session: { email: "alice@example.com" } },
          }),
        ],
        stubs,
      },
    });

    expect(wrapper.text()).toContain("You're signed in.");
  });

  it("surfaces the session error when identity verification fails", () => {
    const wrapper = mount(HomeView, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: { session: { error: "Access expired." } },
          }),
        ],
        stubs,
      },
    });

    expect(wrapper.text()).toContain("Access expired.");
  });
});
