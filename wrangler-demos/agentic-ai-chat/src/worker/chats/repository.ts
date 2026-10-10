import { type ChatRoute, DEFAULT_CHAT_ROUTE, isChatRoute } from "./route";
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

/**
 * Convert D1's storage shape into the API representation. `row.route` is defensively coerced
 * back to {@link DEFAULT_CHAT_ROUTE} for anything that is not a valid chat route -- covers a
 * pre-Phase-4 row this repository itself never wrote with a non-`NULL` route, and any value that
 * reached the column by some path other than `create()`/`setRouteIfUnstarted()` (both of which
 * only ever write a validated route) -- so `Chat.route` can stay non-nullable rather than pushing
 * a `null` check onto every caller.
 */
function toChat(row: ChatRow): Chat {
  return {
    id: row.id,
    ownerEmail: row.owner_email,
    title: row.title,
    route: isChatRoute(row.route) ? row.route : DEFAULT_CHAT_ROUTE,
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
   * Create a new chat directory row for the given owner, defaulting its governed model route to
   * {@link DEFAULT_CHAT_ROUTE} (docs/06-AGENTIC-CHAT.md Phase 4, US-3's "defaulting to Basic"
   * acceptance criterion) -- a brand-new chat always has zero turns yet, so this default is
   * always still changeable via {@link setRouteIfUnstarted} immediately afterward.
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
      route: DEFAULT_CHAT_ROUTE,
      createdAt: now,
      updatedAt: now,
    };
    await this.database
      .prepare(
        `INSERT INTO chats (id, owner_email, title, route, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?)`,
      )
      .bind(
        chat.id,
        chat.ownerEmail,
        chat.route,
        chat.createdAt,
        chat.updatedAt,
      )
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

  /**
   * Look up a chat by id with **no** ownership scoping -- for `ChatAgent`'s own internal use
   * only (Phase 3's auto-titling/recency bookkeeping), where the Durable Object's own instance
   * name already *is* the chat id and is never client-supplied input requiring
   * re-validation. Every client-facing route must use {@link findOwned} instead.
   *
   * @param id Chat ID (the calling `ChatAgent`'s own `this.name`).
   * @returns The chat if its directory row still exists, otherwise `null` (tolerated the same
   * way a deleted-mid-turn chat is tolerated elsewhere in this demo -- see
   * docs/06-AGENTIC-CHAT.md Section 11).
   */
  async findById(id: string): Promise<Chat | null> {
    const row = await this.database
      .prepare(
        `SELECT id, owner_email, title, route, created_at, updated_at
         FROM chats WHERE id = ? LIMIT 1`,
      )
      .bind(id)
      .first<ChatRow>();
    return row === null ? null : toChat(row);
  }

  /**
   * List every chat owned by the given identity, most recently updated first -- the sidebar's
   * directory listing (docs/06-AGENTIC-CHAT.md Phase 3, US-2).
   *
   * @param ownerEmail Verified Cloudflare Access identity making the request.
   * @returns The identity's own chats, newest activity first.
   */
  async listOwned(ownerEmail: string): Promise<Chat[]> {
    const { results } = await this.database
      .prepare(
        `SELECT id, owner_email, title, route, created_at, updated_at
         FROM chats WHERE owner_email = ? ORDER BY updated_at DESC`,
      )
      .bind(ownerEmail)
      .all<ChatRow>();
    return results.map(toChat);
  }

  /**
   * Bump a chat's `updated_at` to now, so the sidebar's recency ordering reflects its latest
   * activity (docs/06-AGENTIC-CHAT.md Phase 3, US-2). Called by `ChatAgent` itself after every
   * completed turn -- never scoped by owner, for the same reason {@link findById} is not: the
   * calling Durable Object's own instance name already is the chat id.
   *
   * @param id Chat id to touch. A no-op (zero rows affected, no error) if the chat's directory
   * row no longer exists.
   */
  async touch(id: string): Promise<void> {
    await this.database
      .prepare(`UPDATE chats SET updated_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), id)
      .run();
  }

  /**
   * Persist a chat's auto-generated title, but only the first time: the `title IS NULL` guard
   * makes a second call (a retried completion, or two turns racing before the first write
   * lands) a silent no-op rather than clobbering a title a later turn -- or eventually a user
   * edit -- might already have set (docs/06-AGENTIC-CHAT.md Phase 3, US-2).
   *
   * @param id Chat id whose title to set.
   * @param title Already-sanitized title text (see `./title.ts`'s `sanitizeTitle()`).
   */
  async setTitleIfUnset(id: string, title: string): Promise<void> {
    await this.database
      .prepare(`UPDATE chats SET title = ? WHERE id = ? AND title IS NULL`)
      .bind(title, id)
      .run();
  }

  /**
   * Change a chat's governed model route, but only while the chat has no completed turns yet
   * (docs/06-AGENTIC-CHAT.md Phase 4, US-3's "selectable only when a chat has no turns yet"
   * affordance) -- reusing the same `title IS NULL` signal Phase 3's auto-titling already
   * establishes as "this chat's first turn has not completed" (`setTitleIfUnset()`'s own guard),
   * rather than introducing a second, separate "has this chat started" column. Scoped to the
   * owner in the same query as {@link findOwned}, for the same defense-in-depth reason.
   *
   * @param id Chat id whose route to change.
   * @param ownerEmail Verified Cloudflare Access identity making the request.
   * @param route The new, already-validated route (see `./route.ts`'s `isChatRoute()`).
   * @returns Whether a row was actually updated. `false` covers two different reasons the
   * caller must distinguish itself beforehand (via {@link findOwned}) to reply correctly: the
   * chat does not exist/is not owned by `ownerEmail`, or it exists but already has a title (its
   * first turn already completed).
   */
  async setRouteIfUnstarted(
    id: string,
    ownerEmail: string,
    route: ChatRoute,
  ): Promise<boolean> {
    const result = await this.database
      .prepare(
        `UPDATE chats SET route = ?
         WHERE id = ? AND owner_email = ? AND title IS NULL`,
      )
      .bind(route, id, ownerEmail)
      .run();
    return result.meta.changes > 0;
  }

  /**
   * Remove a chat's directory row, scoped to its owner -- defense in depth alongside the
   * route's own `ownedAgentStub()` ownership check (docs/06-AGENTIC-CHAT.md Phase 3, US-2).
   *
   * @param id Chat id to remove.
   * @param ownerEmail Verified Cloudflare Access identity making the request.
   * @returns Whether a row was actually deleted.
   */
  async remove(id: string, ownerEmail: string): Promise<boolean> {
    const result = await this.database
      .prepare(`DELETE FROM chats WHERE id = ? AND owner_email = ?`)
      .bind(id, ownerEmail)
      .run();
    return result.meta.changes > 0;
  }
}
