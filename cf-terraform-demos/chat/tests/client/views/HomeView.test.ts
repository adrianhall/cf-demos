import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import { createTestingPinia } from '@pinia/testing';
import { flushPromises, mount } from '@vue/test-utils';
import { useChannelsStore } from '../../../src/client/stores/channels';
import { useRoomStore } from '../../../src/client/stores/room';
import { useSessionStore } from '../../../src/client/stores/session';
import HomeView from '../../../src/client/views/HomeView.vue';

const vuetify = createVuetify({ components });

/**
 * Build a channel as the store holds one.
 *
 * @param name Channel name.
 * @returns A complete channel record.
 */
function channel(name: string) {
  return { name, createdBy: 'alice@example.com', createdAt: '2026-01-01T00:00:00.000Z' };
}

/**
 * Mount the view over stubbed stores.
 *
 * Every store action is stubbed, so these tests exercise the view's own orchestration — which
 * channel it picks, what it does after a removal — rather than re-testing the stores, which have
 * their own suites.
 *
 * @param channels Directory the channels store reports.
 * @returns The mounted wrapper and the three stores.
 */
function mountView(channels = [channel('general'), channel('deploys')]) {
  const pinia = createTestingPinia({ createSpy: vi.fn });
  const wrapper = mount(HomeView, { global: { plugins: [pinia, vuetify] } });

  const channelsStore = useChannelsStore();
  const room = useRoomStore();
  const session = useSessionStore();
  channelsStore.channels = channels;
  session.email = 'alice@example.com';

  return { wrapper, channelsStore, room, session };
}

describe('HomeView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initial channel', () => {
    it('joins general when it exists', async () => {
      const { channelsStore, room } = mountView();
      vi.mocked(channelsStore.load).mockImplementation(async () => {});

      await flushPromises();

      expect(room.connect).toHaveBeenCalledWith('general');
    });

    // `general` is only a convention. When it is absent the first channel in the directory's
    // name order is the sensible fallback.
    it('joins the first channel when general is absent', async () => {
      const { room } = mountView([channel('alpha'), channel('beta')]);
      await flushPromises();

      expect(room.connect).toHaveBeenCalledWith('alpha');
    });

    it('connects to nothing in an empty workspace', async () => {
      const { room } = mountView([]);
      await flushPromises();

      expect(room.connect).not.toHaveBeenCalled();
      expect(room.disconnect).toHaveBeenCalled();
    });
  });

  describe('creating a channel', () => {
    // Creating a channel and then having to click it would be a strange interaction, and the
    // store returns the server's normalized name so the channel joined is the one created.
    it('joins the newly created channel under its normalized name', async () => {
      const { wrapper, channelsStore, room } = mountView();
      vi.mocked(channelsStore.create).mockResolvedValue(channel('deploys'));

      await wrapper.findComponent({ name: 'ChannelSidebar' }).vm.$emit('create', '  Deploys ');
      await flushPromises();

      expect(channelsStore.create).toHaveBeenCalledWith('  Deploys ');
      expect(room.connect).toHaveBeenCalledWith('deploys');
    });

    it('shows the failure message rather than joining', async () => {
      const { wrapper, channelsStore } = mountView();
      vi.mocked(channelsStore.create).mockRejectedValue(
        new Error('A channel named "general" already exists.')
      );

      await wrapper.findComponent({ name: 'ChannelSidebar' }).vm.$emit('create', 'general');
      await flushPromises();

      expect(wrapper.text()).toContain('A channel named "general" already exists.');
    });
  });

  describe('removing a channel', () => {
    it('moves to another channel when the one being viewed is removed', async () => {
      const { wrapper, channelsStore, room } = mountView();
      await flushPromises();
      room.channel = 'deploys';
      vi.mocked(channelsStore.remove).mockImplementation(async () => {
        channelsStore.channels = [channel('general')];
      });
      vi.mocked(room.connect).mockClear();

      await wrapper.findComponent({ name: 'ChannelSidebar' }).vm.$emit('remove', 'deploys');
      await flushPromises();

      expect(room.connect).toHaveBeenCalledWith('general');
    });

    it('stays put when a different channel is removed', async () => {
      const { wrapper, channelsStore, room } = mountView();
      await flushPromises();
      room.channel = 'general';
      vi.mocked(channelsStore.remove).mockImplementation(async () => {
        channelsStore.channels = [channel('general')];
      });
      vi.mocked(room.connect).mockClear();

      await wrapper.findComponent({ name: 'ChannelSidebar' }).vm.$emit('remove', 'deploys');
      await flushPromises();

      expect(room.connect).not.toHaveBeenCalled();
    });

    it('disconnects when the last channel is removed', async () => {
      const { wrapper, channelsStore, room } = mountView([channel('general')]);
      await flushPromises();
      room.channel = 'general';
      vi.mocked(channelsStore.remove).mockImplementation(async () => {
        channelsStore.channels = [];
      });
      vi.mocked(room.disconnect).mockClear();

      await wrapper.findComponent({ name: 'ChannelSidebar' }).vm.$emit('remove', 'general');
      await flushPromises();

      expect(room.disconnect).toHaveBeenCalled();
    });
  });

  // A removal performed by another participant reaches this browser only as a status change on
  // the socket. Handling it here — rather than inside the local removal path — is what makes
  // both cases behave identically.
  describe('a removal performed by somebody else', () => {
    it('explains the removal and moves to a remaining channel', async () => {
      const { wrapper, channelsStore, room } = mountView();
      room.channel = 'deploys';
      vi.mocked(channelsStore.load).mockImplementation(async () => {
        channelsStore.channels = [channel('general')];
      });

      room.status = 'removed';
      await flushPromises();

      expect(wrapper.text()).toContain('Channel "deploys" was removed.');
      expect(channelsStore.load).toHaveBeenCalled();
      expect(room.connect).toHaveBeenCalledWith('general');
    });
  });

  describe('sending', () => {
    it('forwards the message to the room', async () => {
      const { wrapper, room } = mountView();
      room.channel = 'general';
      await flushPromises();

      await wrapper.findComponent({ name: 'MessageComposer' }).vm.$emit('send', 'hello');

      expect(room.send).toHaveBeenCalledWith('hello');
    });

    it('reports a send attempted with no connection', async () => {
      const { wrapper, room } = mountView();
      room.channel = 'general';
      await flushPromises();
      vi.mocked(room.send).mockImplementation(() => {
        throw new Error('Not connected to this channel.');
      });

      await wrapper.findComponent({ name: 'MessageComposer' }).vm.$emit('send', 'hello');
      await flushPromises();

      expect(wrapper.text()).toContain('Not connected to this channel.');
    });
  });

  describe('empty workspace', () => {
    it('invites the participant to add a channel', async () => {
      const { wrapper, channelsStore } = mountView([]);
      channelsStore.loading = false;
      await flushPromises();

      expect(wrapper.text()).toContain('No channel selected');
    });
  });

  it('closes the connection when the view is unmounted', async () => {
    const { wrapper, room } = mountView();
    await flushPromises();
    vi.mocked(room.disconnect).mockClear();

    wrapper.unmount();

    expect(room.disconnect).toHaveBeenCalled();
  });
});
