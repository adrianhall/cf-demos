import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { Chat } from "../stores/chats";
import ChatSidebar from "./ChatSidebar.vue";

/** A stable chat fixture for rendering tests. */
function chat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    ownerEmail: "alice@example.com",
    title: "Trip Planning",
    route: "basic",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ChatSidebar", () => {
  it("emits create when the new chat button is clicked", async () => {
    const wrapper = mount(ChatSidebar, {
      props: { chats: [], loading: false, selectedId: null },
    });

    await wrapper.get(".new-chat-button").trigger("click");

    expect(wrapper.emitted("create")).toHaveLength(1);
  });

  it("shows an empty state and no list when there are no chats", () => {
    const wrapper = mount(ChatSidebar, {
      props: { chats: [], loading: false, selectedId: null },
    });

    expect(wrapper.text()).toContain("No chats yet");
    expect(wrapper.find(".chat-list").exists()).toBe(false);
  });

  it("shows a loading state instead of the empty state while the directory is still loading", () => {
    const wrapper = mount(ChatSidebar, {
      props: { chats: [], loading: true, selectedId: null },
    });

    expect(wrapper.text()).toContain("Loading chats");
    expect(wrapper.text()).not.toContain("No chats yet");
  });

  it("renders every chat's title and falls back to a placeholder for an untitled chat", () => {
    const wrapper = mount(ChatSidebar, {
      props: {
        chats: [
          chat({ id: "a", title: "Trip Planning" }),
          chat({ id: "b", title: null }),
        ],
        loading: false,
        selectedId: null,
      },
    });

    const titles = wrapper.findAll(".chat-title").map((el) => el.text());
    expect(titles).toEqual(["Trip Planning", "New chat"]);
  });

  it("marks the selected chat with aria-current and a selected class", () => {
    const wrapper = mount(ChatSidebar, {
      props: {
        chats: [chat({ id: "a" }), chat({ id: "b" })],
        loading: false,
        selectedId: "b",
      },
    });

    const buttons = wrapper.findAll(".chat-item-button");
    expect(buttons[0]?.attributes("aria-current")).toBeUndefined();
    expect(buttons[1]?.attributes("aria-current")).toBe("true");
    expect(buttons[1]?.classes()).toContain("selected");
  });

  it("emits select with the clicked chat's id", async () => {
    const wrapper = mount(ChatSidebar, {
      props: {
        chats: [chat({ id: "a" }), chat({ id: "b" })],
        loading: false,
        selectedId: null,
      },
    });

    await wrapper.findAll(".chat-item-button")[1]?.trigger("click");

    expect(wrapper.emitted("select")).toEqual([["b"]]);
  });

  it("emits remove with the clicked chat's id without also emitting select", async () => {
    const wrapper = mount(ChatSidebar, {
      props: { chats: [chat({ id: "a" })], loading: false, selectedId: null },
    });

    await wrapper.get(".remove-button").trigger("click");

    expect(wrapper.emitted("remove")).toEqual([["a"]]);
    expect(wrapper.emitted("select")).toBeUndefined();
  });

  it("labels the remove button with the chat's own title for accessibility", () => {
    const wrapper = mount(ChatSidebar, {
      props: {
        chats: [chat({ title: "Trip Planning" })],
        loading: false,
        selectedId: null,
      },
    });

    expect(wrapper.get(".remove-button").attributes("aria-label")).toBe(
      "Delete chat: Trip Planning",
    );
  });
});
