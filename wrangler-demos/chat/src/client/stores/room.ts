import { defineStore } from "pinia";
import { shallowRef } from "vue";
import {
  CHANNEL_REMOVED_CLOSE_CODE,
  type ChatMessage,
  type ServerFrame,
} from "../../chat-protocol";

/** Lifecycle of the room store's single WebSocket connection to one channel at a time. */
export type RoomStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "removed"
  | "error";

/** Initial delay before the first reconnect attempt after an unexpected drop. */
const INITIAL_RECONNECT_DELAY_MS = 1_000;
/** Upper bound for the exponential reconnect backoff. */
const MAX_RECONNECT_DELAY_MS = 10_000;

/** Build the same-origin WebSocket URL for a channel's upgrade route. */
function roomSocketUrl(channel: string): URL {
  const url = new URL(
    `/api/channels/${encodeURIComponent(channel)}/ws`,
    window.location.href,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

/**
 * Owns the browser's single live WebSocket connection to one channel's `ChatRoom` Durable
 * Object. Switching channels closes the previous socket and opens a new one — a different
 * channel name routes to a different Durable Object, so there is never more than one
 * conversation "live" in the browser at a time. A transient drop reconnects with exponential
 * backoff and relies on the Durable Object's replayed history to recover the authoritative
 * conversation; an intentional channel removal (the `CHANNEL_REMOVED_CLOSE_CODE` close code)
 * does not reconnect, since the channel no longer exists.
 */
export const useRoomStore = defineStore("room", () => {
  const channel = shallowRef<string | null>(null);
  const messages = shallowRef<ChatMessage[]>([]);
  const participants = shallowRef(0);
  const status = shallowRef<RoomStatus>("idle");
  const error = shallowRef<string | null>(null);

  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  let closingIntentionally = false;

  /** Cancel a pending scheduled reconnect, if one is queued. */
  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /** Apply one decoded server frame to store state. */
  function applyFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case "history":
        messages.value = frame.messages;
        return;
      case "message":
        messages.value = [...messages.value, frame.message];
        return;
      case "presence":
        participants.value = frame.participants;
        return;
      case "error":
        error.value = frame.detail;
        return;
      case "channel_removed":
        status.value = "removed";
        return;
    }
  }

  /** Open a new WebSocket to the given channel and wire its event handlers. */
  function openSocket(name: string): void {
    status.value = "connecting";
    const ws = new WebSocket(roomSocketUrl(name));
    socket = ws;

    ws.addEventListener("open", () => {
      if (socket !== ws) {
        return;
      }
      status.value = "connected";
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    });

    ws.addEventListener("message", (event) => {
      if (socket !== ws) {
        return;
      }
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as ServerFrame;
      } catch {
        return;
      }
      applyFrame(frame);
    });

    ws.addEventListener("close", (event) => {
      if (socket !== ws) {
        // Superseded by a newer connection (a channel switch); this socket's close is expected
        // and already handled by whichever code replaced it.
        return;
      }
      socket = null;
      if (closingIntentionally) {
        closingIntentionally = false;
        status.value = "idle";
        return;
      }
      if (event.code === CHANNEL_REMOVED_CLOSE_CODE) {
        status.value = "removed";
        return;
      }
      status.value = "reconnecting";
      // No `channel.value === name` guard is needed here: both `connect()` and `disconnect()`
      // clear any pending reconnect timer before ever changing `channel.value`, so if this
      // callback runs at all, the channel it was scheduled for is still the active one.
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        openSocket(name);
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    });
  }

  /**
   * Connect to a channel, closing and replacing any previous connection. Reopening always
   * clears local message/participant state — the newly connected socket's replayed history
   * frame is the only authoritative source for what the channel now contains.
   *
   * @param name Validated normalized channel name already present in the D1 directory.
   */
  function connect(name: string): void {
    if (channel.value === name && socket !== null) {
      return;
    }
    disconnect();
    channel.value = name;
    messages.value = [];
    participants.value = 0;
    error.value = null;
    reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    openSocket(name);
  }

  /** Close the current connection, if any, without scheduling a reconnect. */
  function disconnect(): void {
    clearReconnectTimer();
    channel.value = null;
    messages.value = [];
    participants.value = 0;
    error.value = null;
    if (socket !== null) {
      closingIntentionally = true;
      socket.close();
    } else {
      status.value = "idle";
    }
  }

  /**
   * Send one message over the live connection.
   *
   * @param body Non-empty message body; the Durable Object validates it before persisting.
   * @throws {Error} When there is no open connection to send over.
   */
  function send(body: string): void {
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to the channel.");
    }
    socket.send(JSON.stringify({ body }));
  }

  return {
    channel,
    connect,
    disconnect,
    error,
    messages,
    participants,
    send,
    status,
  };
});
