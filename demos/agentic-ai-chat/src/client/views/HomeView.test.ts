import { createTestingPinia } from "@pinia/testing";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it, vi } from "vitest";
import { useChatStore } from "../stores/chat";
import { useChatsStore } from "../stores/chats";
import { useSessionStore } from "../stores/session";
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
    expect(wrapper.find(".chat-sidebar").exists()).toBe(false);
  });

  it("shows the chat directory's own error alongside the sidebar", () => {
    const wrapper = mount(HomeView, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: {
              session: { email: "alice@example.com" },
              chats: { error: "Could not load chats." },
            },
          }),
        ],
        stubs,
      },
    });

    expect(wrapper.text()).toContain("Could not load chats.");
    expect(wrapper.find(".chat-sidebar").exists()).toBe(true);
  });

  it("shows an empty state instead of the composer when no chat is selected", () => {
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

    expect(wrapper.text()).toContain("No chat selected");
    expect(wrapper.findComponent({ name: "ChatComposer" }).exists()).toBe(
      false,
    );
  });

  it("renders the transcript and composer once a chat is selected", () => {
    const wrapper = mount(HomeView, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: {
              session: { email: "alice@example.com" },
              chats: { selectedChatId: "chat-1" },
            },
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
              chats: { selectedChatId: "chat-1" },
              chat: { connectionStatus: "connecting" },
            },
          }),
        ],
        stubs,
      },
    });

    expect(wrapper.get("textarea").attributes("disabled")).toBeDefined();
  });

  it("shows a removal notice and hides the composer when the open chat was deleted", () => {
    const wrapper = mount(HomeView, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: {
              session: { email: "alice@example.com" },
              chats: { selectedChatId: "chat-1" },
              chat: { connectionStatus: "removed" },
            },
          }),
        ],
        stubs,
      },
    });

    expect(wrapper.text()).toContain("This chat was removed.");
    expect(wrapper.findComponent({ name: "ChatComposer" }).exists()).toBe(
      false,
    );
    expect(wrapper.text()).not.toContain("No chat selected");
  });

  it("renders the sidebar with the chat directory", () => {
    const wrapper = mount(HomeView, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: {
              session: { email: "alice@example.com" },
              chats: {
                chats: [
                  {
                    id: "chat-1",
                    ownerEmail: "alice@example.com",
                    title: "Trip Planning",
                    route: null,
                    createdAt: "2026-08-01T00:00:00.000Z",
                    updatedAt: "2026-08-01T00:00:00.000Z",
                  },
                ],
              },
            },
          }),
        ],
        stubs,
      },
    });

    expect(wrapper.text()).toContain("Trip Planning");
  });

  it("reloads the chat directory once the server broadcasts that its metadata write landed", async () => {
    setActivePinia(createPinia());
    const session = useSessionStore();
    const chatsStore = useChatsStore();
    const chatStore = useChatStore();
    session.email = "alice@example.com";
    const loadSpy = vi.spyOn(chatsStore, "load").mockResolvedValue(undefined);

    const wrapper = mount(HomeView, { global: { stubs } });
    await wrapper.vm.$nextTick();
    // Mounting itself triggers one `load()` call (the `session.isAuthenticated` watcher) --
    // this test only cares about the *additional* call the metadata-broadcast watcher makes.
    loadSpy.mockClear();

    // Deliberately does NOT drive `chatStore.turns`/`isStreaming` here: the turn's own
    // streaming status flips before the server's D1 writes actually land (see
    // `chat-agent.ts`'s `afterTurnCompleted()` JSDoc), so HomeView must react to the broadcast
    // signal specifically, not to the turn reaching "done". `metadataUpdatedAt` is a real,
    // writable `shallowRef` exposed straight through from `useChatAgent`, so setting it
    // directly is exactly what receiving a `chat_metadata_updated` frame does.
    chatStore.metadataUpdatedAt = Date.now();
    await wrapper.vm.$nextTick();

    expect(loadSpy).toHaveBeenCalledTimes(1);
  });
});
