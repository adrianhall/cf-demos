'use client';

import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../chat-protocol';
import type { RoomStatus } from './use-room';

/**
 * Properties supplied to the message pane.
 */
export interface MessagePaneProps {
  /**
   * Replayed history plus every message broadcast since connecting, oldest first.
   */
  messages: ChatMessage[];
  /**
   * Number of participants currently connected to this channel.
   */
  participants: number;
  /**
   * Connection lifecycle, used to explain a gap in delivery rather than leaving the pane looking
   * simply quiet.
   */
  status: RoomStatus;
  /**
   * The reader's own verified identity, used to distinguish their messages from everybody else's.
   * Presentation only — authorship is decided server-side and pinned to the socket, so a wrong
   * value here could at worst mis-style a message bubble.
   */
  currentUserEmail: string | null;
}

/**
 * Format a timestamp for display beside a message author.
 *
 * Rendered in the reader's own locale and timezone rather than the server's, because the stored
 * value is an absolute instant and "when was this said" only means something relative to the person
 * reading it.
 *
 * @param iso ISO-8601 timestamp recorded when the message was persisted.
 * @returns A short local time such as `14:32`.
 */
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The conversation: participant count, connection state, and the message history.
 *
 * Each message shows the author the _room_ recorded. The client has no say in it — the wire
 * protocol has no author field at all (see `src/chat-protocol.ts`), and the room reads the author
 * back from the socket attachment on every message.
 *
 * @param props Messages, presence, connection status, and the reader's own identity.
 * @returns The scrolling conversation region.
 */
export function MessagePane({
  messages,
  participants,
  status,
  currentUserEmail
}: MessagePaneProps): React.JSX.Element {
  const scrollRegion = useRef<HTMLDivElement>(null);

  // Keeps the newest message in view as history replays and new messages arrive. Depends on the
  // message *count* rather than the array: the array is replaced wholesale on every history
  // replay, and reacting to that would re-scroll on changes that add nothing to scroll to. The
  // effect runs after React has committed the new message, so the height being scrolled to exists.
  useEffect(() => {
    const region = scrollRegion.current;
    if (region !== null) {
      region.scrollTop = region.scrollHeight;
    }
  }, [messages.length]);

  return (
    <section aria-labelledby="message-pane-heading" className="message-pane">
      <header className="message-pane-header">
        <h2 className="sr-only" id="message-pane-heading">
          Channel messages
        </h2>
        <p className="participant-count" role="status">
          {participants} {participants === 1 ? 'participant' : 'participants'}
        </p>
        {status === 'connecting' ? (
          <p className="connection-notice" role="status">
            Connecting…
          </p>
        ) : null}
        {status === 'reconnecting' ? (
          <p className="connection-notice" role="status">
            Connection lost — retrying…
          </p>
        ) : null}
      </header>

      {/*
        `role="log"` with `aria-live="polite"` announces newly appended messages to a screen
        reader without interrupting whatever it is currently reading, which is the correct
        politeness for an ongoing conversation.
      */}
      <div aria-live="polite" className="message-scroll" ref={scrollRegion} role="log">
        {messages.length === 0 ? (
          <p className="empty-state">No messages yet. Be the first to say something.</p>
        ) : null}
        {messages.map((message) => (
          <article
            className={message.author === currentUserEmail ? 'message own' : 'message'}
            key={message.id}
          >
            <p className="message-meta">
              <span className="message-author">{message.author}</span>
              <time className="message-time" dateTime={message.createdAt}>
                {formatTime(message.createdAt)}
              </time>
            </p>
            <p className="message-body">{message.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
