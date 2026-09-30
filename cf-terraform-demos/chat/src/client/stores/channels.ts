import { defineStore } from 'pinia';
import { requestEmpty, requestJson } from '../lib/api';

/**
 * A channel as returned by the same-origin channel API.
 */
export interface Channel {
  /**
   * Normalized channel name, also used as the Durable Object's name.
   */
  name: string;
  /**
   * Verified identity that created the channel.
   */
  createdBy: string;
  /**
   * ISO-8601 creation timestamp.
   */
  createdAt: string;
}

/**
 * Client state and operations for the shared channel directory.
 *
 * Every mutation reloads the directory from the Worker rather than patching local state
 * optimistically, and that is a considered choice rather than laziness. This directory is _shared_:
 * between a participant creating a channel and the response arriving, somebody else may have
 * created or removed one. Re-reading means the sidebar reflects the server's actual state —
 * including the server's normalization of the submitted name and its ordering — instead of a local
 * guess that is right only when nobody else is using the workspace.
 *
 * The same reasoning does not apply to messages. Those arrive over a WebSocket (see `./room.ts`),
 * which pushes changes as they happen, so there is no equivalent staleness to correct.
 *
 * Mutating actions propagate errors to the caller rather than storing them. The view renders a
 * per-interaction message, which keeps presentation concerns out of the store; `load` is the one
 * exception, because a failed initial load has no interaction to report against.
 */
export const useChannelsStore = defineStore('channels', {
  actions: {
    /**
     * Fetch the channel directory.
     *
     * @returns A promise fulfilled after `channels` is replaced and `loading` is reset. A failure
     *   is recorded in `error` rather than thrown, so the view can show a message without the
     *   initial page load rejecting.
     */
    async load(): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        const response = await requestJson<{ channels: Channel[] }>('/api/channels');
        this.channels = response.channels;
      } catch (cause) {
        this.error = cause instanceof Error ? cause.message : 'Could not load the channels.';
      } finally {
        this.loading = false;
      }
    },

    /**
     * Create a channel and refresh the directory.
     *
     * The created channel is returned so the caller can join it immediately — creating a channel
     * and then having to click it would be a strange interaction. The returned value comes from the
     * API rather than from the submitted text, so the name joined is the normalized name the server
     * actually stored.
     *
     * @param name Candidate channel name entered by the participant.
     * @returns The API-confirmed channel.
     * @throws {Error} When the name is invalid (`422`), already taken (`409`), or the request
     *   otherwise fails.
     */
    async create(name: string): Promise<Channel> {
      const response = await requestJson<{ channel: Channel }>('/api/channels', {
        body: JSON.stringify({ name }),
        method: 'POST'
      });
      await this.load();
      return response.channel;
    },

    /**
     * Remove a channel and refresh the directory.
     *
     * @param name Name of the channel to remove.
     * @returns A promise fulfilled once the channel is gone and the directory has been re-read.
     * @throws {Error} When the channel no longer exists (`404`) or the request otherwise fails.
     */
    async remove(name: string): Promise<void> {
      await requestEmpty(`/api/channels/${encodeURIComponent(name)}`, { method: 'DELETE' });
      await this.load();
    }
  },
  getters: {
    /**
     * Whether the directory currently holds no channels, which the sidebar renders as an empty
     * state rather than a blank list.
     *
     * @param state Current store state.
     * @returns `true` when there are no channels.
     */
    isEmpty: (state): boolean => state.channels.length === 0
  },
  state: () => ({
    /**
     * Every channel in the workspace, name-ordered as the API returned them.
     */
    channels: [] as Channel[],
    /**
     * Whether a directory request is pending.
     */
    loading: false,
    /**
     * Message from a failed {@link useChannelsStore.load}, or `null`.
     */
    error: null as string | null
  })
});
