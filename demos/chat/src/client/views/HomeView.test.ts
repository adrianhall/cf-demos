import { createTestingPinia } from "@pinia/testing";
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { Channel } from "../stores/channels";
import { useChannelsStore } from "../stores/channels";
import { useRoomStore } from "../stores/room";
import HomeView from "./HomeView.vue";

/** A channel fixture used across workspace tests. */
const general: Channel = {
  createdAt: "2026-07-27T00:00:00.000Z",
  createdBy: "system",
  name: "general",
};

/** A second channel fixture, used to prove routing/selection between channels. */
const random: Channel = {
  createdAt: "2026-07-27T00:00:01.000Z",
  createdBy: "system",
  name: "random",
};

/** Event-focused substitutes for every visual child component this view composes. */
const stubs = {
  ChannelSidebar: {
    emits: ["create", "remove", "select"],
    props: ["channels", "selected"],
    template: `<div>
      <button
        v-for="item in channels"
        :key="'select-' + item.name"
        :data-testid="'select-' + item.name"
        @click="$emit('select', item.name)"
      />
      <button
        v-for="item in channels"
        :key="'remove-' + item.name"
        :data-testid="'remove-' + item.name"
        @click="$emit('remove', item.name)"
      />
      <button data-testid="create" @click="$emit('create', 'deploys')" />
    </div>`,
  },
  MessageComposer: {
    emits: ["send"],
    props: ["disabled"],
    template:
      "<button data-testid=\"send\" @click=\"$emit('send', 'Hello')\" />",
  },
  MessagePane: {
    props: ["currentUserEmail", "messages", "participants", "status"],
    template: '<div data-testid="message-pane">{{ status }}</div>',
  },
  VAlert: {
    emits: ["click:close"],
    template:
      '<div role="alert"><slot /><button data-testid="dismiss-notice" @click="$emit(\'click:close\')" /></div>',
  },
};

/** Mount the view with a fully controllable testing Pinia instance. */
function mountHome(initialState: Record<string, unknown> = {}) {
  return mount(HomeView, {
    global: {
      plugins: [
        createTestingPinia({
          createSpy: vi.fn,
          initialState: {
            channels: { channels: [general, random] },
            session: { email: "alice@example.com" },
            ...initialState,
          },
          stubActions: true,
        }),
      ],
      stubs,
    },
  });
}

describe("HomeView", () => {
  it("connects to the general channel by default", async () => {
    mountHome();
    const room = useRoomStore();

    await flushPromises();

    expect(room.connect).toHaveBeenCalledWith("general");
  });

  it("renders the empty state until a channel is connected", async () => {
    const wrapper = mountHome();
    await flushPromises();

    // `connect` is a stubbed action under createTestingPinia, so it never actually updates
    // `room.channel` here — this exercises the template's own `v-else` branch directly.
    expect(wrapper.text()).toContain("No channel selected");
  });

  it("renders the message pane and composer once a channel is connected", async () => {
    const wrapper = mountHome({ room: { channel: "general" } });
    await flushPromises();

    expect(wrapper.find('[data-testid="message-pane"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="send"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain("No channel selected");
  });

  it("prefers general over channel order when both exist", async () => {
    mountHome({ channels: { channels: [random, general] } });
    const room = useRoomStore();

    await flushPromises();

    expect(room.connect).toHaveBeenCalledWith("general");
  });

  it("falls back to the first channel when general is absent", async () => {
    mountHome({ channels: { channels: [random] } });
    const room = useRoomStore();

    await flushPromises();

    expect(room.connect).toHaveBeenCalledWith("random");
  });

  it("shows the empty state and never connects when there are no channels", async () => {
    const wrapper = mountHome({ channels: { channels: [] } });
    const room = useRoomStore();

    await flushPromises();

    expect(room.connect).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("No channel selected");
  });

  it("connects to a channel selected from the sidebar and clears any notice", async () => {
    const wrapper = mountHome();
    const room = useRoomStore();
    await flushPromises();
    vi.mocked(room.connect).mockClear();

    await wrapper.get('[data-testid="select-random"]').trigger("click");

    expect(room.connect).toHaveBeenCalledWith("random");
  });

  it("adds a channel and connects to it once created", async () => {
    const wrapper = mountHome();
    const channels = useChannelsStore();
    const room = useRoomStore();
    await flushPromises();
    const deploys: Channel = {
      createdAt: "2026-07-27T00:02:00.000Z",
      createdBy: "alice@example.com",
      name: "deploys",
    };
    vi.mocked(channels.add).mockResolvedValueOnce(deploys);
    vi.mocked(room.connect).mockClear();

    await wrapper.get('[data-testid="create"]').trigger("click");
    await flushPromises();

    expect(channels.add).toHaveBeenCalledWith("deploys");
    expect(room.connect).toHaveBeenCalledWith("deploys");
  });

  it("reports a failed channel creation without connecting", async () => {
    const wrapper = mountHome();
    const channels = useChannelsStore();
    const room = useRoomStore();
    await flushPromises();
    vi.mocked(channels.add).mockRejectedValueOnce(new Error("Reserved name."));
    vi.mocked(room.connect).mockClear();

    await wrapper.get('[data-testid="create"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("Reserved name.");
    expect(room.connect).not.toHaveBeenCalled();
  });

  it("moves to a remaining channel after removing the one currently selected", async () => {
    const wrapper = mountHome({ room: { channel: "general" } });
    const channels = useChannelsStore();
    const room = useRoomStore();
    await flushPromises();
    vi.mocked(channels.remove).mockImplementationOnce(async () => {
      channels.channels = [random];
    });
    vi.mocked(room.connect).mockClear();

    await wrapper.get('[data-testid="remove-general"]').trigger("click");
    await flushPromises();

    expect(channels.remove).toHaveBeenCalledWith("general");
    expect(room.connect).toHaveBeenCalledWith("random");
  });

  it("disconnects instead of reconnecting when removing the last remaining channel", async () => {
    const wrapper = mountHome({ room: { channel: "general" } });
    const channels = useChannelsStore();
    const room = useRoomStore();
    await flushPromises();
    vi.mocked(channels.remove).mockImplementationOnce(async () => {
      channels.channels = [];
    });

    await wrapper.get('[data-testid="remove-general"]').trigger("click");
    await flushPromises();

    expect(room.disconnect).toHaveBeenCalled();
  });

  it("does not reconnect when removing a channel other than the one selected", async () => {
    const wrapper = mountHome({ room: { channel: "general" } });
    const channels = useChannelsStore();
    const room = useRoomStore();
    await flushPromises();
    vi.mocked(room.connect).mockClear();

    await wrapper.get('[data-testid="remove-random"]').trigger("click");
    await flushPromises();

    expect(channels.remove).toHaveBeenCalledWith("random");
    expect(room.connect).not.toHaveBeenCalled();
  });

  it("reports a failed channel removal", async () => {
    const wrapper = mountHome();
    const channels = useChannelsStore();
    await flushPromises();
    vi.mocked(channels.remove).mockRejectedValueOnce(
      new Error("Could not remove."),
    );

    await wrapper.get('[data-testid="remove-random"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("Could not remove.");
  });

  it("reacts to another window removing the current channel: notice, reload, and reconnect", async () => {
    const wrapper = mountHome({ room: { channel: "general" } });
    const channels = useChannelsStore();
    const room = useRoomStore();
    await flushPromises();
    vi.mocked(channels.load).mockImplementationOnce(async () => {
      channels.channels = [random];
    });
    vi.mocked(room.connect).mockClear();

    room.status = "removed";
    await flushPromises();

    expect(wrapper.text()).toContain('Channel "general" was removed.');
    expect(channels.load).toHaveBeenCalled();
    expect(room.connect).toHaveBeenCalledWith("random");
  });

  it("ignores a status change that is not a removal", async () => {
    const wrapper = mountHome({ room: { channel: "general" } });
    const channels = useChannelsStore();
    const room = useRoomStore();
    await flushPromises();
    vi.mocked(channels.load).mockClear();

    room.status = "connected";
    await flushPromises();

    expect(channels.load).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it("shows a generic removal notice when the removed channel name is unknown", async () => {
    const wrapper = mountHome({ room: { channel: null } });
    const room = useRoomStore();
    await flushPromises();

    room.status = "removed";
    await flushPromises();

    expect(wrapper.text()).toContain("This channel was removed.");
  });

  it("disconnects when a removal leaves no channels behind", async () => {
    const wrapper = mountHome({ room: { channel: "general" } });
    const channels = useChannelsStore();
    const room = useRoomStore();
    await flushPromises();
    vi.mocked(channels.load).mockImplementationOnce(async () => {
      channels.channels = [];
    });

    room.status = "removed";
    await flushPromises();

    expect(wrapper.text()).toContain("removed");
    expect(room.disconnect).toHaveBeenCalled();
  });

  it("dismisses the notice banner", async () => {
    const wrapper = mountHome({ room: { channel: "general" } });
    const room = useRoomStore();
    await flushPromises();
    room.status = "removed";
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);

    await wrapper.get('[data-testid="dismiss-notice"]').trigger("click");

    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it("sends a message over the live connection", async () => {
    const wrapper = mountHome({ room: { channel: "general" } });
    const room = useRoomStore();
    await flushPromises();

    await wrapper.get('[data-testid="send"]').trigger("click");

    expect(room.send).toHaveBeenCalledWith("Hello");
  });

  it("reports a failure sending a message without losing the composer", async () => {
    const wrapper = mountHome({ room: { channel: "general" } });
    const room = useRoomStore();
    await flushPromises();
    vi.mocked(room.send).mockImplementationOnce(() => {
      throw new Error("Not connected to the channel.");
    });

    await wrapper.get('[data-testid="send"]').trigger("click");

    expect(wrapper.text()).toContain("Not connected to the channel.");
  });

  it("uses safe fallback messages for non-Error failures", async () => {
    const wrapper = mountHome({ room: { channel: "general" } });
    const channels = useChannelsStore();
    const room = useRoomStore();
    await flushPromises();

    vi.mocked(channels.add).mockRejectedValueOnce("offline");
    await wrapper.get('[data-testid="create"]').trigger("click");
    expect(wrapper.text()).toContain("Could not add the channel.");

    vi.mocked(channels.remove).mockRejectedValueOnce("offline");
    await wrapper.get('[data-testid="remove-random"]').trigger("click");
    expect(wrapper.text()).toContain("Could not remove the channel.");

    vi.mocked(room.send).mockImplementationOnce(() => {
      throw "offline";
    });
    await wrapper.get('[data-testid="send"]').trigger("click");
    expect(wrapper.text()).toContain("Could not send the message.");
  });

  it("disconnects the live socket when the view is unmounted", async () => {
    const wrapper = mountHome();
    const room = useRoomStore();
    await flushPromises();

    wrapper.unmount();

    expect(room.disconnect).toHaveBeenCalled();
  });
});
