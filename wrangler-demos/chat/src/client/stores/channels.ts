import { defineStore } from "pinia";
import { shallowRef } from "vue";

/** A channel directory entry shared by every authenticated participant, from `GET /api/channels`. */
export interface Channel {
  /** Immutable normalized channel name used as the Durable Object name. */
  name: string;
  /** Verified Access email of the participant who created the channel. */
  createdBy: string;
  /** ISO 8601 timestamp of channel creation. */
  createdAt: string;
}

/** RFC 9457 error response shape used for safe client error messages. */
interface ProblemDetails {
  /** Human-readable explanation of the failed request. */
  detail?: string;
}

/** Read a safe error message from a failed API response. */
async function responseMessage(response: Response): Promise<string> {
  const body = (await response
    .json()
    .catch(() => null)) as ProblemDetails | null;
  return body?.detail ?? `Request failed with status ${response.status}.`;
}

/**
 * The shared, D1-backed channel directory. Every signed-in participant may add or remove a
 * channel — there is no admin role — so this store always reloads the directory from the
 * Worker after a mutation rather than optimistically guessing the server's resulting order.
 */
export const useChannelsStore = defineStore("channels", () => {
  const channels = shallowRef<Channel[]>([]);
  const loading = shallowRef(false);
  const error = shallowRef<string | null>(null);

  /** Fetch the current channel directory. */
  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response = await fetch("/api/channels");
      if (!response.ok) {
        throw new Error(await responseMessage(response));
      }
      const body = (await response.json()) as { channels: Channel[] };
      channels.value = body.channels;
    } catch (cause) {
      error.value =
        cause instanceof Error ? cause.message : "Could not load channels.";
    } finally {
      loading.value = false;
    }
  }

  /**
   * Add one channel for every participant, then reload the directory so the list reflects the
   * server's own normalization and ordering.
   *
   * @param name Candidate channel name; the Worker normalizes and validates it.
   * @returns The newly created channel.
   * @throws {Error} When the Worker rejects the name or the request otherwise fails.
   */
  async function add(name: string): Promise<Channel> {
    const response = await fetch("/api/channels", {
      body: JSON.stringify({ name }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(await responseMessage(response));
    }
    const body = (await response.json()) as { channel: Channel };
    await load();
    return body.channel;
  }

  /**
   * Remove a channel's Durable Object state and directory entry, then reload the directory.
   * Any authenticated participant may remove any channel — removal is intentionally
   * unrestricted, matching channel creation.
   *
   * @param name Validated normalized channel name.
   * @throws {Error} When the removal request fails.
   */
  async function remove(name: string): Promise<void> {
    const response = await fetch(`/api/channels/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      throw new Error(await responseMessage(response));
    }
    await load();
  }

  return { add, channels, error, load, loading, remove };
});
