/**
 * @file The WebSocket wire protocol, shared verbatim by the room that produces the frames
 *   (`src/worker/infrastructure/chat-room.ts`) and the browser store that consumes them
 *   (`src/client/stores/room.ts`). This module sits outside both `src/worker/` and `src/client/`
 *   because it belongs to neither: it is the contract between them. Keeping one definition means a
 *   frame the room can send is, by construction, a frame the client can handle — TypeScript fails
 *   the build otherwise. The sibling `src/access-policies.ts` plays the same role for
 *   authorization, giving local development and the deployed Worker one shared policy list rather
 *   than two that can drift. Nothing here is transport-specific beyond the frames themselves. The
 *   domain types it re-uses ({@link ChatMessage}) come from the domain layer, so the wire format is
 *   a projection of the domain rather than a parallel model that has to be kept in sync by hand.
 */

import type { ChatMessage } from './worker/domain/channel';

export type { ChatMessage };

/**
 * WebSocket close code the room sends when a channel is removed.
 *
 * It exists so the client can tell an intentional removal apart from a dropped connection. Those
 * two look identical at the socket level, but call for opposite responses: a drop should reconnect,
 * while reconnecting to a removed channel would retry forever against a channel that no longer
 * exists. `4001` sits in the 4000–4999 range RFC 6455 reserves for application use.
 */
export const CHANNEL_REMOVED_CLOSE_CODE = 4_001;

/**
 * The bounded recent history the room replays as the first frame after a successful join.
 *
 * Sending history as a frame rather than a separate HTTP fetch means the connection itself defines
 * the starting point: everything in this frame happened before the socket opened, and everything
 * that arrives afterwards happened after. A separate fetch would leave a window in which a message
 * could be both in the fetched history and in a subsequent broadcast, or in neither.
 */
export interface HistoryFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'history';
  /**
   * Recent messages in chronological order, oldest first.
   */
  messages: ChatMessage[];
}

/**
 * One newly persisted message, broadcast to every participant in the channel.
 */
export interface MessageFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'message';
  /**
   * The message as persisted, including the identifier and timestamp the room assigned.
   */
  message: ChatMessage;
}

/**
 * The current participant count, broadcast whenever somebody joins or leaves.
 */
export interface PresenceFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'presence';
  /**
   * Number of connections currently open to this channel's room.
   */
  participants: number;
}

/**
 * A rejected frame, sent only to the participant that sent it.
 *
 * A rejected message is never persisted or broadcast, so this frame is the sender's only signal
 * that their message did not land. It is deliberately sent rather than closing the connection: a
 * typo in one message should not disconnect the participant.
 */
export interface ErrorFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'error';
  /**
   * User-safe explanation, taken from the `detail` of the RFC 9457 problem the domain raised, so a
   * rejection over the socket reads the same as the equivalent rejection over HTTP.
   */
  detail: string;
}

/**
 * Sent to every participant immediately before the room closes their socket with
 * {@link CHANNEL_REMOVED_CLOSE_CODE}.
 *
 * Strictly redundant with the close code, and sent anyway: the frame arrives with the reason intact
 * even in a client that only inspects messages, and it is delivered before the close handshake
 * rather than as part of it.
 */
export interface ChannelRemovedFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'channel_removed';
}

/**
 * Every frame the room may send. A discriminated union, so a `switch` on `type` in the client is
 * checked for exhaustiveness and adding a frame here fails the build until the client handles it.
 */
export type ServerFrame =
  | HistoryFrame
  | MessageFrame
  | PresenceFrame
  | ErrorFrame
  | ChannelRemovedFrame;

/**
 * The only frame a participant may send.
 *
 * There is exactly one, and it carries no author. The author is pinned to the connection when it is
 * accepted, so there is nothing for a client to assert and no field for it to forge — see
 * `src/worker/infrastructure/chat-room.ts`.
 */
export interface ClientFrame {
  /**
   * Candidate message text, validated by the domain before it becomes durable history.
   */
  body: string;
}
