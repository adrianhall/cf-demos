import { createTestingPinia } from "@pinia/testing";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import App from "./App.vue";

/** Shared Vuetify component stubs so these tests exercise real markup, not Vuetify internals. */
const stubs = {
  RouterView: { template: '<div data-testid="router-view">Chat</div>' },
  VApp: { template: "<div><slot /></div>" },
  VBtn: { template: '<a v-bind="$attrs"><slot /></a>' },
  VMain: { template: "<main><slot /></main>" },
};

describe("App", () => {
  it("renders a logout control alongside the routed page", () => {
    const wrapper = mount(App, {
      global: {
        plugins: [createTestingPinia({ createSpy: vi.fn })],
        stubs,
      },
    });

    expect(wrapper.get('a[href="/cdn-cgi/access/logout"]').text()).toBe(
      "Sign out",
    );
    expect(wrapper.get('[data-testid="router-view"]').text()).toBe("Chat");
  });

  it("renders the verified email after the session store loads it", () => {
    const wrapper = mount(App, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: { session: { email: "alice@example.com" } },
          }),
        ],
        stubs: { ...stubs, RouterView: true },
      },
    });

    expect(wrapper.text()).toContain("alice@example.com");
    expect(wrapper.text()).not.toContain("Administrator");
  });

  it("renders an administrator badge for the D1-flagged administrator role", () => {
    const wrapper = mount(App, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: {
              session: { email: "admin@example.com", isAdmin: true },
            },
          }),
        ],
        stubs: { ...stubs, RouterView: true },
      },
    });

    expect(wrapper.text()).toContain("admin@example.com");
    expect(wrapper.text()).toContain("Administrator");
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
        stubs: { ...stubs, RouterView: true },
      },
    });

    expect(wrapper.text()).toContain("Verifying identity…");
  });
});
