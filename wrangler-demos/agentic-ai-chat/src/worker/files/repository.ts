import type { ChatFile } from "./types";

/** Raw snake-cased `chat_files` row returned by D1. */
interface ChatFileRow {
  id: string;
  chat_id: string;
  filename: string;
  r2_key: string;
  size_bytes: number;
  correlation_id: string;
  created_at: string;
}

/** Convert D1's storage shape into the API representation. */
function toChatFile(row: ChatFileRow): ChatFile {
  return {
    id: row.id,
    chatId: row.chat_id,
    filename: row.filename,
    r2Key: row.r2_key,
    sizeBytes: row.size_bytes,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
  };
}

/** Input to {@link ChatFilesRepository.create}. */
export interface CreateChatFileInput {
  /** Server-generated file id, already embedded in {@link r2Key} (`../files/storage.ts`'s
   * `chatFileKey()`). */
  readonly id: string;
  /** The owning chat's id. */
  readonly chatId: string;
  /** The already-sanitized filename (`../files/validation.ts`'s `sanitizeFilename()`). */
  readonly filename: string;
  /** The R2 key this file's content was already, successfully written to (Section 11's
   * "R2 write before D1 insert" ordering). */
  readonly r2Key: string;
  /** The file's exact byte size. */
  readonly sizeBytes: number;
  /** This turn's correlation UUID (Section 6.6/15) -- the exact join key back to the
   * `chat_usage` row this same turn produced. */
  readonly correlationId: string;
}

/**
 * D1 persistence boundary for agent-generated file metadata (docs/06-AGENTIC-CHAT.md Section
 * 6.4, Phase 9, US-8). The file's actual content never lives here -- it stays in R2
 * (`../files/storage.ts`), exactly as `../chats/repository.ts`'s `ChatRepository` keeps
 * conversation content out of the chat directory.
 */
export class ChatFilesRepository {
  /** @param database D1 capability used to query and update this table. */
  constructor(private readonly database: Pick<D1Database, "prepare">) {}

  /**
   * Persist one file's metadata. Called only after {@link ../files/storage.ts!putChatFile}
   * has already confirmed the R2 write (Section 11) -- never the other way around.
   *
   * @param input The file's id, owning chat, sanitized filename, R2 key, and size.
   * @returns The persisted row.
   */
  async create(input: CreateChatFileInput): Promise<ChatFile> {
    const file: ChatFile = { ...input, createdAt: new Date().toISOString() };
    await this.database
      .prepare(
        `INSERT INTO chat_files
           (id, chat_id, filename, r2_key, size_bytes, correlation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        file.id,
        file.chatId,
        file.filename,
        file.r2Key,
        file.sizeBytes,
        file.correlationId,
        file.createdAt,
      )
      .run();
    return file;
  }

  /**
   * Look up a file, scoped to the chat it must belong to -- a file id that exists but is
   * attached to a *different* chat is indistinguishable from one that does not exist at all,
   * mirroring `../chats/repository.ts`'s `findOwned()` "scope inside the query, not afterward"
   * discipline. The route calling this (`../routes/chats.ts`) has already separately confirmed
   * the requesting identity owns `chatId` itself (`ChatRepository.findOwned()`) before this is
   * ever called, so the combination of both checks is what actually enforces "only the chat's
   * owner can download it" (US-8's acceptance criterion).
   *
   * @param chatId The chat this file must belong to.
   * @param fileId The file id from the request path.
   * @returns The file if it exists and belongs to `chatId`, otherwise `null`. Its
   * {@link ChatFile.correlationId} is always populated -- needed by Phase 12's per-file export
   * (`../routes/chats.ts`'s `GET /:id/files/:fileId/export`) to join this file back to the
   * exact `chat_usage` row the same turn produced (Section 6.6/15).
   */
  async findByChatAndId(
    chatId: string,
    fileId: string,
  ): Promise<ChatFile | null> {
    const row = await this.database
      .prepare(
        `SELECT id, chat_id, filename, r2_key, size_bytes, correlation_id, created_at
         FROM chat_files WHERE id = ? AND chat_id = ? LIMIT 1`,
      )
      .bind(fileId, chatId)
      .first<ChatFileRow>();
    return row === null ? null : toChatFile(row);
  }
}
