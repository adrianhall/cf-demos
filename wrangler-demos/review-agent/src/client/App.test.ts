import { createTestingPinia } from "@pinia/testing";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import App from "./App.vue";

/** Shared Vuetify/Vue Router component stubs so these tests exercise real markup, not Vuetify or
 * Vue Router internals (mirrors `demos/agentic-ai-chat/src/client/App.test.ts`). */
const stubs = {
  RouterLink: { template: '<a v-bind="$attrs"><slot /></a>' },
  RouterView: { template: '<div data-testid="router-view">Home</div>' },
  VApp: { template: "<div><slot /></div>" },
  VBtn: { template: '<a v-bind="$attrs"><slot /></a>' },
  VMain: { template: "<main><slot /></main>" },
};

describe("App", () => {
  it("renders an unconditional logout control alongside the routed page", () => {
    const wrapper = mount(App, {
      global: {
        plugins: [createTestingPinia({ createSpy: vi.fn })],
        stubs,
      },
    });

    expect(wrapper.get('a[href="/cdn-cgi/access/logout"]').text()).toBe(
      "Sign out",
    );
    expect(wrapper.get('[data-testid="router-view"]').text()).toBe("Home");
  });

  it("renders the verified email once the session store loads it", () => {
    const wrapper = mount(App, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: { session: { email: "reviewer@example.com" } },
          }),
        ],
        stubs,
      },
    });

    expect(wrapper.text()).toContain("reviewer@example.com");
  });

  it("shows identity verification while the session is loading", () => {
    const wrapper = mount(App, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: { session: { loading: true } },
          }),
        ],
        stubs,
      },
    });

    expect(wrapper.text()).toContain("Verifying identity…");
  });

  it("still renders the logout control when the session check itself failed", () => {
    const wrapper = mount(App, {
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
    expect(wrapper.find('a[href="/cdn-cgi/access/logout"]').exists()).toBe(
      true,
    );
  });
});
