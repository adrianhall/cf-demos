import type { Chat } from "./types";

/** Raw snake-cased chat row returned by D1. */
interface ChatRow {
  id: string;
  owner_email: string;
  title: string | null;
  route: string | null;
  created_at: string;
  updated_at: string;
}

/** Convert D1's storage shape into the API representation. */
function toChat(row: ChatRow): Chat {
  return {
    id: row.id,
    ownerEmail: row.owner_email,
    title: row.title,
    route: row.route,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * D1 persistence boundary for the chat directory (docs/06-AGENTIC-CHAT.md Section 6.4). Message
 * content deliberately never lives here -- it stays in each chat's own `ChatAgent` Durable
 * Object (Section 6.2), exactly as `demos/chat`'s `ChannelRepository` keeps message data out of
 * its shared channel directory.
 */
export class ChatRepository {
  /** @param database D1 capability used to query and update the directory. */
  constructor(private readonly database: Pick<D1Database, "prepare">) {}

  /**
   * Create a new chat directory row for the given owner.
   *
   * @param ownerEmail Verified Cloudflare Access identity creating the chat.
   * @returns The persisted chat, whose `id` is also the `ChatAgent` Durable Object instance name
   * the caller should route to next (`getAgentByName(env.CHAT_AGENT, chat.id, ...)`).
   */
  async create(ownerEmail: string): Promise<Chat> {
    const now = new Date().toISOString();
    const chat: Chat = {
      id: crypto.randomUUID(),
      ownerEmail,
      title: null,
      route: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.database
      .prepare(
        `INSERT INTO chats (id, owner_email, title, route, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, ?, ?)`,
      )
      .bind(chat.id, chat.ownerEmail, chat.createdAt, chat.updatedAt)
      .run();
    return chat;
  }

  /**
   * Look up a chat, scoped to its owner in the same query rather than checked afterward -- a
   * chat ID that exists but belongs to a different identity is indistinguishable from one that
   * does not exist at all, so a caller can reject both the same way (`404`, not `403`,
   * docs/06-AGENTIC-CHAT.md Phase 2, step 3) without ever confirming another user's chat ID is
   * valid.
   *
   * @param id Chat ID from the request path.
   * @param ownerEmail Verified Cloudflare Access identity making the request.
   * @returns The chat if it exists and is owned by `ownerEmail`, otherwise `null`.
   */
  async findOwned(id: string, ownerEmail: string): Promise<Chat | null> {
    const row = await this.database
      .prepare(
        `SELECT id, owner_email, title, route, created_at, updated_at
         FROM chats WHERE id = ? AND owner_email = ? LIMIT 1`,
      )
      .bind(id, ownerEmail)
      .first<ChatRow>();
    return row === null ? null : toChat(row);
  }
}
