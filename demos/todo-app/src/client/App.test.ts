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
});
