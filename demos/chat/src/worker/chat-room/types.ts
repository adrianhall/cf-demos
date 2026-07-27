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

/** Socket attachment trusted only after the Worker sets the internal identity header. */
export interface ChatSocketAttachment {
  /** Verified Access email that must be used as the message author. */
  email: string;
  /** Validated channel name supplied by the Worker for structured event logging. */
  channel: string;
}

/** Client message format accepted over a room WebSocket. */
export interface SendMessageInput {
  /** Candidate message content. */
  body: string;
}
