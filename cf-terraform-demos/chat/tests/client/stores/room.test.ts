import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_REMOVED_CLOSE_CODE, type ChatMessage } from '../../../src/chat-protocol';
import { useRoomStore } from '../../../src/client/stores/room';
import { installFakeWebSocket, mostRecentSocket } from '../support/fake-websocket';

/**
 * Build a message as the room would broadcast it.
 *
 * @param id Message identifier.
 * @param body Message text.
 * @returns A complete message.
 */
function message(id: number, body: string): ChatMessage {
  return { id, author: 'alice@example.com', body, createdAt: '2026-01-01T00:00:00.000Z' };
}

/**
 * Connect a store to a channel and complete the handshake.
 *
 * @param channel Channel to join.
 * @returns The connected store.
 */
function connected(channel = 'general') {
  const room = useRoomStore();
  room.connect(channel);
  mostRecentSocket().simulateOpen();
  return room;
}

describe('useRoomStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    installFakeWebSocket();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('connecting', () => {
    it('starts idle with nothing selected', () => {
      const room = useRoomStore();

      expect(room.status).toBe('idle');
      expect(room.channel).toBeNull();
      expect(room.messages).toEqual([]);
    });

    // Same-origin is what makes the Access cookie travel with the upgrade; a browser's
    // WebSocket constructor cannot set headers, so this is the only authentication available.
    it('opens a same-origin socket on the channel path', () => {
      useRoomStore().connect('deploys');

      expect(mostRecentSocket().url).toBe(
        `${window.location.origin.replace(/^http/u, 'ws')}/api/channels/deploys/socket`
      );
    });

    it('percent-encodes the channel name in the path', () => {
      useRoomStore().connect('a-b');
      expect(mostRecentSocket().url).toContain('/api/channels/a-b/socket');
    });

    it('reports connecting until the handshake completes', () => {
      const room = useRoomStore();
      room.connect('general');
      expect(room.status).toBe('connecting');

      mostRecentSocket().simulateOpen();
      expect(room.status).toBe('connected');
      expect(room.canSend).toBe(true);
    });

    it('does not reopen a connection to the channel it is already on', () => {
      const room = connected('general');
      room.connect('general');

      expect(mostRecentSocket().sent).toEqual([]);
      expect(room.status).toBe('connected');
    });
  });

  describe('frames', () => {
    it('replaces local messages with the replayed history', () => {
      const room = connected();
      mostRecentSocket().simulateMessage({
        type: 'history',
        messages: [message(1, 'first'), message(2, 'second')]
      });

      expect(room.messages.map((entry) => entry.body)).toEqual(['first', 'second']);
    });

    it('appends a broadcast message', () => {
      const room = connected();
      const socket = mostRecentSocket();
      socket.simulateMessage({ type: 'history', messages: [message(1, 'first')] });
      socket.simulateMessage({ type: 'message', message: message(2, 'second') });

      expect(room.messages.map((entry) => entry.body)).toEqual(['first', 'second']);
    });

    it('tracks the participant count', () => {
      const room = connected();
      mostRecentSocket().simulateMessage({ type: 'presence', participants: 3 });

      expect(room.participants).toBe(3);
    });

    it('surfaces a rejected message without closing the connection', () => {
      const room = connected();
      mostRecentSocket().simulateMessage({ type: 'error', detail: 'body must be a string.' });

      expect(room.error).toBe('body must be a string.');
      expect(room.status).toBe('connected');
    });

    // An unparseable frame is not something the participant can act on, and the next history
    // replay is authoritative regardless, so dropping it is safe.
    it('ignores a frame it cannot parse', () => {
      const room = connected();
      mostRecentSocket().simulateMessage('not json at all');

      expect(room.status).toBe('connected');
      expect(room.error).toBeNull();
    });
  });

  describe('sending', () => {
    it('sends the body and nothing else', () => {
      const room = connected();
      room.send('hello');

      expect(mostRecentSocket().sent).toEqual([JSON.stringify({ body: 'hello' })]);
    });

    // The message appears when the room broadcasts it back, so what the sender sees is what was
    // actually persisted, in the order the room assigned.
    it('does not add the message locally before the room broadcasts it', () => {
      const room = connected();
      room.send('hello');

      expect(room.messages).toEqual([]);
    });

    it('refuses to send with no open connection', () => {
      const room = useRoomStore();
      room.connect('general');

      expect(() => room.send('hello')).toThrowError(/not connected/iu);
      expect(room.canSend).toBe(false);
    });
  });

  describe('switching channels', () => {
    it('clears conversation state so the previous channel never shows under the new name', () => {
      const room = connected('general');
      mostRecentSocket().simulateMessage({ type: 'history', messages: [message(1, 'first')] });
      mostRecentSocket().simulateMessage({ type: 'presence', participants: 4 });

      room.connect('deploys');

      expect(room.channel).toBe('deploys');
      expect(room.messages).toEqual([]);
      expect(room.participants).toBe(0);
    });

    // A superseded socket can still deliver events after its replacement is live. Without the
    // identity guard in the store, a late frame would be applied to the wrong channel.
    it('ignores a late frame from the socket it replaced', () => {
      const room = connected('general');
      const stale = mostRecentSocket();
      room.connect('deploys');

      stale.simulateMessage({ type: 'history', messages: [message(1, 'stale')] });

      expect(room.messages).toEqual([]);
    });

    it('closes the previous connection', () => {
      const room = connected('general');
      const previous = mostRecentSocket();
      room.connect('deploys');

      expect(previous.closedByClient).toBe(true);
    });
  });

  describe('reconnection', () => {
    it('retries after an unexpected drop', () => {
      const room = connected();
      mostRecentSocket().simulateClose(1_006);
      expect(room.status).toBe('reconnecting');

      vi.advanceTimersByTime(1_000);
      expect(mostRecentSocket().url).toContain('/api/channels/general/socket');

      mostRecentSocket().simulateOpen();
      expect(room.status).toBe('connected');
    });

    it('backs off exponentially across repeated failures', () => {
      connected();

      mostRecentSocket().simulateClose(1_006);
      vi.advanceTimersByTime(1_000);
      const afterFirst = mostRecentSocket();

      afterFirst.simulateClose(1_006);
      // Still within the first delay, so the second retry must not have fired yet.
      vi.advanceTimersByTime(1_000);
      expect(mostRecentSocket()).toBe(afterFirst);

      vi.advanceTimersByTime(1_000);
      expect(mostRecentSocket()).not.toBe(afterFirst);
    });

    it('resets the backoff after a successful connection', () => {
      connected();
      mostRecentSocket().simulateClose(1_006);
      vi.advanceTimersByTime(1_000);
      mostRecentSocket().simulateOpen();

      const reconnected = mostRecentSocket();
      reconnected.simulateClose(1_006);
      vi.advanceTimersByTime(1_000);

      expect(mostRecentSocket()).not.toBe(reconnected);
    });

    // Retrying a removed channel would loop forever against something that no longer exists.
    it('does not retry after a channel removal', () => {
      const room = connected();
      const socket = mostRecentSocket();
      socket.simulateClose(CHANNEL_REMOVED_CLOSE_CODE);

      expect(room.status).toBe('removed');
      vi.advanceTimersByTime(60_000);
      expect(mostRecentSocket()).toBe(socket);
    });

    it('does not retry after a deliberate disconnect', () => {
      const room = connected();
      const socket = mostRecentSocket();
      room.disconnect();
      socket.simulateClose(1_000);

      expect(room.status).toBe('idle');
      vi.advanceTimersByTime(60_000);
      expect(mostRecentSocket()).toBe(socket);
    });

    // A pending retry must not survive a channel switch, or it would reconnect to the channel
    // the participant just left.
    it('cancels a pending retry when the channel changes', () => {
      const room = connected('general');
      mostRecentSocket().simulateClose(1_006);

      room.connect('deploys');
      const current = mostRecentSocket();
      vi.advanceTimersByTime(60_000);

      expect(mostRecentSocket()).toBe(current);
      expect(current.url).toContain('/api/channels/deploys/socket');
    });
  });

  describe('disconnecting', () => {
    it('clears all conversation state', () => {
      const room = connected();
      mostRecentSocket().simulateMessage({ type: 'history', messages: [message(1, 'first')] });

      room.disconnect();

      expect(room.channel).toBeNull();
      expect(room.messages).toEqual([]);
      expect(room.participants).toBe(0);
    });

    it('is safe to call with no connection open', () => {
      const room = useRoomStore();
      room.disconnect();

      expect(room.status).toBe('idle');
    });
  });
});
