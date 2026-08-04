/**
 * One `chat_files` row (docs/06-AGENTIC-CHAT.md Section 6.4, Phase 9, US-8) -- metadata for a
 * single Markdown document `ChatAgent`'s `writeMarkdown` tool wrote to R2, attached to the chat
 * that produced it. The row is written only after a confirmed R2 write
 * (`../files/storage.ts`'s `putChatFile()`), so a row existing at all is a guarantee its R2
 * object does too -- see `../agent/tools/write-markdown.ts`'s own ordering comment.
 */
export interface ChatFile {
  /** Server-generated identifier, also embedded in the R2 key (`../files/storage.ts`'s
   * `chatFileKey()`) and returned to the model as the tool result the assistant's reply can
   * reference. */
  readonly id: string;
  /** The chat this file is attached to -- also the owning `ChatAgent` Durable Object's instance
   * name. */
  readonly chatId: string;
  /** The sanitized filename presented to the user (`../files/validation.ts`'s
   * `sanitizeFilename()`), always ending in `.md`. Never the model's raw, unsanitized input. */
  readonly filename: string;
  /** The R2 object key this file's content is stored under. Never exposed to the client --
   * `GET /api/chats/:id/files/:fileId` resolves it server-side after an ownership check. */
  readonly r2Key: string;
  /** The file's exact byte size, computed from its UTF-8-encoded content at write time. */
  readonly sizeBytes: number;
  /** The turn's own correlation UUID (docs/06-AGENTIC-CHAT.md Section 6.6/15) -- the same value
   * stamped on that turn's `chat_usage` row (`../usage/types.ts`'s `ChatUsageRow.correlationId`),
   * so a later phase's per-file export can join the two exactly, not approximately. */
  readonly correlationId: string;
  /** ISO 8601 timestamp this row was written. */
  readonly createdAt: string;
}
