import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import {
  CHANNEL_REMOVED_CLOSE_CODE,
  type ChatMessage,
  type ServerFrame
} from '../../chat-protocol';

/**
 * Lifecycle of the browser's single connection to one channel at a time.
 */
export type RoomStatus =
  /**
   * No channel selected.
   */
  | 'idle'
  /**
   * A connection is being opened for the first time.
   */
  | 'connecting'
  /**
   * Connected; messages can be sent.
   */
  | 'connected'
  /**
   * The connection dropped unexpectedly and a retry is scheduled.
   */
  | 'reconnecting'
  /**
   * The channel was removed. Terminal — no retry will follow.
   */
  | 'removed';

/**
 * Delay before the first retry after an unexpected drop.
 */
const INITIAL_RECONNECT_DELAY_MS = 1_000;

/**
 * Ceiling for the exponential retry backoff, so a long outage settles into a steady ten-second poll
 * rather than growing without bound and leaving a recovered connection unclaimed for minutes.
 */
const MAX_RECONNECT_DELAY_MS = 10_000;

/**
 * Build the same-origin WebSocket URL for a channel.
 *
 * Same-origin is what makes authentication work without any token handling in this file: the
 * upgrade request carries the Cloudflare Access cookie automatically, exactly as a `fetch` would. A
 * browser's `WebSocket` constructor cannot set request headers, so an API that expected a bearer
 * token here would have to invent a query-string or post-connect handshake — both strictly worse
 * than reusing the session the page already has.
 *
 * @param channel Channel name to connect to.
 * @returns The `ws:`/`wss:` URL for that channel's socket route, matching the page's own scheme.
 */
function roomSocketUrl(channel: string): URL {
  const url = new URL(`/api/channels/${encodeURIComponent(channel)}/socket`, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

/**
 * The browser's live connection to one channel.
 *
 * Written in Pinia's setup style rather than the options style used by the sibling stores, because
 * it owns state that must _not_ be reactive: the `WebSocket` itself, a pending retry timer, and two
 * flags coordinating close handling. Those belong in closure variables — making them reactive state
 * would expose connection internals to components and let a template accidentally depend on them.
 *
 * Exactly one channel is connected at a time. That is not a limitation of the implementation but a
 * reflection of the model: each channel is a separate Durable Object, so "being in" two channels
 * means two connections, and the UI only ever shows one conversation.
 *
 * Reconnection policy distinguishes two cases that look identical at the socket level:
 *
 * - An **unexpected drop** retries with exponential backoff. The room's replayed history is
 *   authoritative, so a reconnect recovers the true conversation rather than stitching together
 *   what the client happened to remember — which is why local message state is discarded and
 *   rebuilt from the history frame on every connection.
 * - A **channel removal** ({@link CHANNEL_REMOVED_CLOSE_CODE}) does not retry. The channel is gone;
 *   retrying would loop forever against something that no longer exists.
 *
 * @returns The room store.
 */
export const useRoomStore = defineStore('room', () => {
  const channel = shallowRef<string | null>(null);
  const messages = ref<ChatMessage[]>([]);
  const participants = shallowRef(0);
  const status = shallowRef<RoomStatus>('idle');
  const error = shallowRef<string | null>(null);

  /**
   * The open connection, or `null`. Not reactive: components interact with it only through this
   * store's actions.
   */
  let socket: WebSocket | null = null;

  /**
   * Handle for a scheduled reconnect, or `null` when none is pending.
   */
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Current backoff delay, reset to {@link INITIAL_RECONNECT_DELAY_MS} on every successful
   * connection so a channel that has been stable for hours still retries promptly.
   */
  let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;

  /**
   * Set while this store is closing a socket on purpose, so the close handler can tell a deliberate
   * disconnect from a drop and skip the retry.
   */
  let closingIntentionally = false;

  /**
   * Whether the participant can currently send a message.
   */
  const canSend = computed(() => status.value === 'connected');

  /**
   * Cancel a pending reconnect, if one is scheduled.
   */
  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /**
   * Apply one decoded frame to store state.
   *
   * The `switch` is exhaustive over {@link ServerFrame}, so adding a frame to the shared protocol
   * fails the type check here until this store handles it. That is the payoff of sharing one
   * protocol module between the room and the client rather than describing the wire format twice.
   *
   * @param frame Frame received from the room.
   */
  function applyFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case 'history':
        // Replaces rather than merges: the room's history is authoritative, and anything the
        // client still held from a previous connection is by definition out of date.
        messages.value = frame.messages;
        return;
      case 'message':
        messages.value = [...messages.value, frame.message];
        return;
      case 'presence':
        participants.value = frame.participants;
        return;
      case 'error':
        error.value = frame.detail;
        return;
      case 'channel_removed':
        status.value = 'removed';
        return;
    }
  }

  /**
   * Open a connection to one channel and wire its handlers.
   *
   * Every handler begins by checking `socket !== ws`. A socket superseded by a channel switch can
   * still deliver events after its replacement is live, and without the guard a late frame from the
   * previous channel would be applied to the new one — showing one channel's messages under another
   * channel's name.
   *
   * @param name Channel to connect to.
   */
  function openSocket(name: string): void {
    status.value = 'connecting';
    const ws = new WebSocket(roomSocketUrl(name));
    socket = ws;

    ws.addEventListener('open', () => {
      if (socket !== ws) {
        return;
      }
      status.value = 'connected';
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    });

    ws.addEventListener('message', (event) => {
      if (socket !== ws) {
        return;
      }
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as ServerFrame;
      } catch {
        // A frame this client cannot parse is not something the participant can act on, and
        // showing them a JSON error would be noise. Dropping it is safe: the room's next history
        // replay is authoritative regardless.
        return;
      }
      applyFrame(frame);
    });

    ws.addEventListener('close', (event) => {
      if (socket !== ws) {
        return;
      }
      socket = null;

      if (closingIntentionally) {
        closingIntentionally = false;
        status.value = 'idle';
        return;
      }
      if (event.code === CHANNEL_REMOVED_CLOSE_CODE) {
        status.value = 'removed';
        return;
      }

      status.value = 'reconnecting';
      // No `channel.value === name` guard is needed: both `connect` and `disconnect` clear any
      // pending timer before changing `channel.value`, so a timer that fires was scheduled for
      // the channel that is still selected.
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        openSocket(name);
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    });
  }

  /**
   * Disconnect from the current channel, if any, without scheduling a retry.
   *
   * @returns Nothing; state is reset to `idle` once the socket finishes closing, or immediately
   *   when there was nothing to close.
   */
  function disconnect(): void {
    clearReconnectTimer();
    channel.value = null;
    messages.value = [];
    participants.value = 0;
    error.value = null;

    if (socket === null) {
      status.value = 'idle';
      return;
    }
    closingIntentionally = true;
    socket.close();
  }

  /**
   * Connect to a channel, replacing any current connection.
   *
   * All local conversation state is cleared before connecting. The incoming history frame is the
   * only authoritative source for what the channel contains, so carrying anything over would risk
   * showing the previous channel's messages for the moment before it arrives.
   *
   * @param name Channel to join. Must already exist in the directory; the Worker answers `404`
   *   otherwise and the socket simply fails to open.
   */
  function connect(name: string): void {
    if (channel.value === name && socket !== null) {
      return;
    }
    disconnect();
    channel.value = name;
    reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    openSocket(name);
  }

  /**
   * Send one message on the live connection.
   *
   * The message is not added to `messages` here. It appears when the room broadcasts it back, which
   * means what the sender sees is what was actually persisted, in the order the room assigned — not
   * an optimistic copy that might never have landed. The round trip is a local network hop to the
   * same object every other participant is connected to, so the delay is not perceptible.
   *
   * @param body Message text. The room validates it independently; trimming here is a convenience,
   *   not the enforcement point.
   * @throws {Error} When there is no open connection, which the view reports without discarding the
   *   participant's draft.
   */
  function send(body: string): void {
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to this channel.');
    }
    error.value = null;
    socket.send(JSON.stringify({ body }));
  }

  return {
    canSend,
    channel,
    connect,
    disconnect,
    error,
    messages,
    participants,
    send,
    status
  };
});
