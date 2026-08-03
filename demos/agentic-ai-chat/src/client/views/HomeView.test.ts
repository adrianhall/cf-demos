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

  it("shows nothing chat-related until the session is authenticated", () => {
    const wrapper = mount(HomeView, {
      global: {
        plugins: [createTestingPinia({ createSpy: vi.fn })],
        stubs,
      },
    });

    expect(wrapper.findComponent({ name: "ChatComposer" }).exists()).toBe(
      false,
    );
  });

  it("shows the chat initialization error instead of the composer when chat creation failed", () => {
    const wrapper = mount(HomeView, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: {
              session: { email: "alice@example.com" },
              chat: { initError: "Could not start a chat." },
            },
          }),
        ],
        stubs,
      },
    });

    expect(wrapper.text()).toContain("Could not start a chat.");
    expect(wrapper.findComponent({ name: "ChatComposer" }).exists()).toBe(
      false,
    );
  });

  it("renders the transcript and composer once the session is authenticated with no chat error", () => {
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

    expect(wrapper.find(".chat-transcript").exists()).toBe(true);
    expect(wrapper.find(".chat-composer").exists()).toBe(true);
  });

  it("disables the composer until the connection status is connected", () => {
    const wrapper = mount(HomeView, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: {
              session: { email: "alice@example.com" },
              chat: { connectionStatus: "connecting" },
            },
          }),
        ],
        stubs,
      },
    });

    expect(wrapper.get("textarea").attributes("disabled")).toBeDefined();
  });
});
