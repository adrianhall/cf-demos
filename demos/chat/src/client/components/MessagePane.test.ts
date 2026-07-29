import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../chat-protocol";
import MessagePane from "./MessagePane.vue";

/** A message fixture used across message-pane tests. */
const fromAlice: ChatMessage = {
  author: "alice@example.com",
  body: "Hello, room",
  createdAt: "2026-07-27T10:15:00.000Z",
  id: 1,
};

/** Mount the pane with an icon substitute; every other element is plain markup. */
function mountPane(props: {
  messages: ChatMessage[];
  participants: number;
  status:
    | "idle"
    | "connecting"
    | "connected"
    | "reconnecting"
    | "removed"
    | "error";
  currentUserEmail: string | null;
}) {
  return mount(MessagePane, {
    props,
    global: { stubs: { FeatherIcon: true } },
  });
}

describe("MessagePane", () => {
  it("renders an empty-state prompt when there is no history yet", () => {
    const wrapper = mountPane({
      currentUserEmail: null,
      messages: [],
      participants: 1,
      status: "connected",
    });

    expect(wrapper.text()).toContain("No messages yet");
  });

  it("renders each message with its author and does not highlight another participant's message", () => {
    const wrapper = mountPane({
      currentUserEmail: "bob@example.com",
      messages: [fromAlice],
      participants: 2,
      status: "connected",
    });

    expect(wrapper.text()).toContain("alice@example.com");
    expect(wrapper.text()).toContain("Hello, room");
    expect(wrapper.find(".message").classes()).not.toContain("own");
  });

  it("highlights the signed-in participant's own message", () => {
    const wrapper = mountPane({
      currentUserEmail: "alice@example.com",
      messages: [fromAlice],
      participants: 2,
      status: "connected",
    });

    expect(wrapper.find(".message").classes()).toContain("own");
  });

  it("shows the connected-participant count", () => {
    const wrapper = mountPane({
      currentUserEmail: null,
      messages: [],
      participants: 4,
      status: "connected",
    });

    expect(wrapper.text()).toContain("4 participants");
  });

  it("scrolls to the newest message as history replays", async () => {
    const wrapper = mountPane({
      currentUserEmail: null,
      messages: [],
      participants: 0,
      status: "connected",
    });

    await wrapper.setProps({ messages: [fromAlice] });

    const region = wrapper.get('[role="log"]').element as HTMLDivElement;
    expect(region.scrollTop).toBe(region.scrollHeight);
  });

  it("does not throw if the pane is unmounted before a pending scroll can run", async () => {
    const wrapper = mountPane({
      currentUserEmail: null,
      messages: [],
      participants: 0,
      status: "connected",
    });

    await wrapper.setProps({ messages: [fromAlice] });
    // Unmount clears the scroll region's template ref before the watcher's own queued
    // `nextTick` continuation (still pending from the prop change above) gets to run it.
    wrapper.unmount();
    await flushPromises();
  });

  it("uses the singular form for exactly one participant", () => {
    const wrapper = mountPane({
      currentUserEmail: null,
      messages: [],
      participants: 1,
      status: "connected",
    });

    expect(wrapper.text()).toContain("1 participant");
    expect(wrapper.text()).not.toContain("1 participants");
  });

  it("shows a connecting notice while the socket is not yet open", () => {
    const wrapper = mountPane({
      currentUserEmail: null,
      messages: [],
      participants: 0,
      status: "connecting",
    });

    expect(wrapper.text()).toContain("Connecting");
  });

  it("shows a reconnecting notice after a transient drop", () => {
    const wrapper = mountPane({
      currentUserEmail: null,
      messages: [],
      participants: 0,
      status: "reconnecting",
    });

    expect(wrapper.text()).toContain("retrying");
  });
});
