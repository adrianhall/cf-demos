// `ChatMessage` and `SendMessageInput` (aliased here as `ClientFrame`) are shared with the
// browser's room store via `src/chat-protocol.ts`, so the wire shapes on both ends of the
// WebSocket can never silently drift apart.
export type {
  ChatMessage,
  ClientFrame as SendMessageInput,
} from "../../chat-protocol";

/** Socket attachment trusted only after the Worker sets the internal identity header. */
export interface ChatSocketAttachment {
  /** Verified Access email that must be used as the message author. */
  email: string;
  /** Validated channel name supplied by the Worker for structured event logging. */
  channel: string;
}
