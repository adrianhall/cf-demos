'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CHANNEL_REMOVED_CLOSE_CODE, type ChatMessage, type ServerFrame } from '../chat-protocol';

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
 * Everything the workspace needs to render and drive one channel connection.
 */
export interface Room {
  /**
   * Channel currently connected or being connected to, or `null` when none is selected.
   */
  channel: string | null;
  /**
   * Replayed history plus every message broadcast since connecting, oldest first.
   */
  messages: ChatMessage[];
  /**
   * Number of participants currently connected to this channel.
   */
  participants: number;
  /**
   * Connection lifecycle.
   */
  status: RoomStatus;
  /**
   * Most recent rejection reported by the room, or `null`.
   */
  error: string | null;
  /**
   * Whether the participant can currently send a message.
   */
  canSend: boolean;
  /**
   * Connect to a channel, replacing any current connection.
   */
  connect: (name: string) => void;
  /**
   * Disconnect from the current channel without scheduling a retry.
   */
  disconnect: () => void;
  /**
   * Send one message on the live connection.
   */
  send: (body: string) => void;
}

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
 * Connection internals — the `WebSocket` itself, a pending retry timer, the current backoff, and
 * the flag distinguishing a deliberate close from a drop — are held in refs rather than state. They
 * are deliberately _not_ reactive: a component must never re-render because a socket's internals
 * changed, and only the derived values in {@link Room} are worth rendering. That mirrors the Vue
 * sibling's use of closure variables in a setup-style Pinia store for exactly the same reason.
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
 * @returns The room state and the actions that drive it.
 */
export function useRoom(): Room {
  const [channel, setChannel] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [participants, setParticipants] = useState(0);
  const [status, setStatus] = useState<RoomStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY_MS);
  const closingIntentionallyRef = useRef(false);

  /**
   * Cancel a pending reconnect, if one is scheduled.
   */
  const clearReconnectTimer = useCallback((): void => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  /**
   * Apply one decoded frame to room state.
   *
   * The `switch` is exhaustive over {@link ServerFrame}, so adding a frame to the shared protocol
   * fails the type check here until this hook handles it. That is the payoff of sharing one
   * protocol module between the room and the client rather than describing the wire format twice.
   *
   * @param frame Frame received from the room.
   */
  const applyFrame = useCallback((frame: ServerFrame): void => {
    switch (frame.type) {
      case 'history':
        // Replaces rather than merges: the room's history is authoritative, and anything the
        // client still held from a previous connection is by definition out of date.
        setMessages(frame.messages);
        return;
      case 'message':
        setMessages((current) => [...current, frame.message]);
        return;
      case 'presence':
        setParticipants(frame.participants);
        return;
      case 'error':
        setError(frame.detail);
        return;
      case 'channel_removed':
        setStatus('removed');
        return;
    }
  }, []);

  /**
   * Open a connection to one channel and wire its handlers.
   *
   * Every handler begins by checking `socketRef.current !== ws`. A socket superseded by a channel
   * switch can still deliver events after its replacement is live, and without the guard a late
   * frame from the previous channel would be applied to the new one — showing one channel's
   * messages under another channel's name.
   *
   * Declared as a mutable ref-held function rather than a `useCallback`, because it is recursive:
   * the close handler schedules a retry that calls it again, and a plain `const` would capture a
   * stale binding.
   *
   * @param name Channel to connect to.
   */
  const openSocketRef = useRef<(name: string) => void>(() => {});
  openSocketRef.current = (name: string): void => {
    setStatus('connecting');
    const ws = new WebSocket(roomSocketUrl(name));
    socketRef.current = ws;

    ws.addEventListener('open', () => {
      if (socketRef.current !== ws) {
        return;
      }
      setStatus('connected');
      reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;
    });

    ws.addEventListener('message', (event) => {
      if (socketRef.current !== ws) {
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
      if (socketRef.current !== ws) {
        return;
      }
      socketRef.current = null;

      if (closingIntentionallyRef.current) {
        closingIntentionallyRef.current = false;
        setStatus('idle');
        return;
      }
      if (event.code === CHANNEL_REMOVED_CLOSE_CODE) {
        setStatus('removed');
        return;
      }

      setStatus('reconnecting');
      // No channel guard is needed: both `connect` and `disconnect` clear any pending timer
      // before changing the selected channel, so a timer that fires was scheduled for the channel
      // that is still selected.
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        openSocketRef.current(name);
      }, reconnectDelayRef.current);
      reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, MAX_RECONNECT_DELAY_MS);
    });
  };

  /**
   * Disconnect from the current channel, if any, without scheduling a retry.
   */
  const disconnect = useCallback((): void => {
    clearReconnectTimer();
    setChannel(null);
    setMessages([]);
    setParticipants(0);
    setError(null);

    if (socketRef.current === null) {
      setStatus('idle');
      return;
    }
    closingIntentionallyRef.current = true;
    socketRef.current.close();
  }, [clearReconnectTimer]);

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
  const connect = useCallback(
    (name: string): void => {
      if (socketRef.current !== null && channel === name) {
        return;
      }
      disconnect();
      setChannel(name);
      reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;
      openSocketRef.current(name);
    },
    [channel, disconnect]
  );

  /**
   * Send one message on the live connection.
   *
   * The message is not added to `messages` here. It appears when the room broadcasts it back, which
   * means what the sender sees is what was actually persisted, in the order the room assigned — not
   * an optimistic copy that might never have landed. The round trip is a local network hop to the
   * same object every other participant is connected to, so the delay is not perceptible.
   *
   * @param body Message text. The room validates it independently; trimming in the composer is a
   *   convenience, not the enforcement point.
   * @throws {Error} When there is no open connection, which the view reports without discarding the
   *   participant's draft.
   */
  const send = useCallback((body: string): void => {
    const ws = socketRef.current;
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to this channel.');
    }
    setError(null);
    ws.send(JSON.stringify({ body }));
  }, []);

  // Close the connection when the workspace unmounts, so no socket outlives the page that opened
  // it. A retry timer is cleared too: firing after unmount would open a socket nothing owns.
  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      closingIntentionallyRef.current = true;
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  return {
    canSend: status === 'connected',
    channel,
    connect,
    disconnect,
    error,
    messages,
    participants,
    send,
    status
  };
}
