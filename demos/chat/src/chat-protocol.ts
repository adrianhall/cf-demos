/**
 * WebSocket wire protocol shared by the `ChatRoom` Durable Object
 * (`src/worker/chat-room/chat-room.ts`) and the browser's room store
 * (`src/client/stores/room.ts`). Keeping one module as the source of truth for the frame shapes
 * and the removal close code prevents the client and the Durable Object from silently drifting
 * apart on the protocol they both speak, the same way `src/access-policies.ts` is the single
 * source of truth for Access path policies shared by the Worker and the local Vite plugin.
 */

/** A persisted chat message sent from a verified socket attachment. */
export interface ChatMessage {
  /** Monotonic SQLite identifier assigned before broadcasting. */
  id: number;
  /** Verified Access email pinned to the sending socket. */
  author: string;
  /** Validated message body. */
  body: string;
  /** ISO 8601 server timestamp recorded with the message. */
  createdAt: string;
}

/**
 * WebSocket close code the `ChatRoom` Durable Object sends from {@link destroy} so a client can
 * distinguish an intentional channel removal from a transient connection drop and avoid
 * reconnecting to a channel that no longer exists.
 */
export const CHANNEL_REMOVED_CLOSE_CODE = 4_001;

/** The bounded recent history replayed as the first frame after a successful upgrade. */
export interface HistoryFrame {
  type: "history";
  /** Most recent messages in chronological order, oldest first. */
  messages: ChatMessage[];
}

/** One newly persisted message, broadcast to every socket connected to the same channel. */
export interface MessageFrame {
  type: "message";
  message: ChatMessage;
}

/** The current connected-participant count, broadcast after any join or leave. */
export interface PresenceFrame {
  type: "presence";
  participants: number;
}

/** A rejected client frame (invalid or unsafe payload); never persisted or broadcast. */
export interface ErrorFrame {
  type: "error";
  detail: string;
}

/** Sent to every socket immediately before {@link destroy} closes it with the removal code. */
export interface ChannelRemovedFrame {
  type: "channel_removed";
}

/** Every frame shape the `ChatRoom` Durable Object may send over a room WebSocket. */
export type ServerFrame =
  | HistoryFrame
  | MessageFrame
  | PresenceFrame
  | ErrorFrame
  | ChannelRemovedFrame;

/** The only frame shape a client may send over a room WebSocket. */
export interface ClientFrame {
  /** Candidate message content, validated server-side before it becomes durable history. */
  body: string;
}
