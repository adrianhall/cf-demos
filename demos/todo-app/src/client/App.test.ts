import { mount } from "@vue/test-utils";
import { createTestingPinia } from "@pinia/testing";
import { describe, expect, it, vi } from "vitest";
import App from "./App.vue";

describe("App", () => {
  it("renders a logout control alongside the routed page", () => {
    const wrapper = mount(App, {
      global: {
        plugins: [createTestingPinia({ createSpy: vi.fn })],
        stubs: {
          RouterView: {
            template: '<div data-testid="router-view">Tasks</div>',
          },
          VApp: { template: "<div><slot /></div>" },
          VBtn: { template: '<a v-bind="$attrs"><slot /></a>' },
          VMain: { template: "<main><slot /></main>" },
        },
      },
    });

    expect(wrapper.get('a[href="/cdn-cgi/access/logout"]').text()).toBe(
      "Sign out",
    );
    expect(wrapper.get('[data-testid="router-view"]').text()).toBe("Tasks");
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
        stubs: {
          RouterView: true,
          VApp: { template: "<div><slot /></div>" },
          VBtn: { template: '<a v-bind="$attrs"><slot /></a>' },
          VMain: { template: "<main><slot /></main>" },
        },
      },
    });

    expect(wrapper.text()).toContain("alice@example.com");
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
        stubs: {
          RouterView: true,
          VApp: { template: "<div><slot /></div>" },
          VBtn: { template: '<a v-bind="$attrs"><slot /></a>' },
          VMain: { template: "<main><slot /></main>" },
        },
      },
    });

    expect(wrapper.text()).toContain("Verifying identity…");
  });
});
