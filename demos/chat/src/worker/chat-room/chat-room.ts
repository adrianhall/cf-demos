import { DurableObject } from "cloudflare:workers";
import { validateMessageInput } from "./validation";
import type {
  ChatMessage,
  ChatSocketAttachment,
  SendMessageInput,
} from "./types";

const HISTORY_LIMIT = 100;

/**
 * WebSocket close code sent by {@link ChatRoom.destroy} so a client can distinguish an
 * intentional channel removal from a transient connection drop and avoid reconnecting to a
 * channel that no longer exists.
 */
export const CHANNEL_REMOVED_CLOSE_CODE = 4_001;

/** Raw snake-cased message row returned by the Durable Object SQLite store. */
interface MessageRow {
  [column: string]: SqlStorageValue;
  id: number;
  author: string;
  body: string;
  created_at: string;
}

/** Convert a stored SQLite message into the wire representation. */
function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    author: row.author,
    body: row.body,
    createdAt: row.created_at,
  };
}

/** Send a typed room event only to a currently open socket. */
function send(socket: WebSocket, event: object): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

/**
 * `ChatRoom` is the coordination atom for a single chat channel — one Durable Object instance
 * per channel name, addressed by the Worker via `env.CHAT_ROOM.getByName(channel)`.
 *
 * Its SQLite store is the authoritative recent history. Socket attachments hold the identity
 * and channel metadata needed after the object hibernates; participant counts are derived from
 * `ctx.getWebSockets()` rather than retained in memory.
 */
export class ChatRoom extends DurableObject<Env> {
  /** Create the durable message table before this object handles any event. */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
    });
  }

  /**
   * Accept a Worker-authenticated hibernatable WebSocket and replay authoritative history.
   *
   * @param request Upgrade request carrying trusted internal identity headers from the Worker.
   * @returns WebSocket upgrade response, or an error for invalid direct calls.
   */
  fetch(request: Request): Response {
    const email = request.headers.get("X-Chat-Identity");
    const channel = request.headers.get("X-Chat-Channel");
    if (
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
      email === null ||
      channel === null
    ) {
      return new Response("Expected an authenticated WebSocket upgrade.", {
        status: 400,
      });
    }

    const [client, server] = Object.values(new WebSocketPair());
    server.serializeAttachment({
      email,
      channel,
    } satisfies ChatSocketAttachment);
    this.ctx.acceptWebSocket(server);
    send(server, { type: "history", messages: this.recentMessages() });
    this.broadcastPresence();
    console.log(
      JSON.stringify({
        event: "channel_joined",
        channel,
        participants: this.ctx.getWebSockets().length,
      }),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Persist one validated client message before broadcasting it to the room.
   *
   * @param socket Connected socket whose serialized attachment provides the verified author.
   * @param message Incoming text or binary WebSocket frame.
   * @returns Promise resolved after a valid persisted message has been broadcast.
   */
  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    let input: SendMessageInput;
    try {
      input = validateMessageInput(message);
    } catch {
      send(socket, { type: "error", detail: "Message was rejected." });
      return;
    }

    const attachment =
      socket.deserializeAttachment() as ChatSocketAttachment | null;
    if (attachment === null) {
      socket.close(1011, "Missing chat identity.");
      return;
    }

    const createdAt = new Date().toISOString();
    const row = this.ctx.storage.sql
      .exec<MessageRow>(
        "INSERT INTO messages (author, body, created_at) VALUES (?, ?, ?) RETURNING id, author, body, created_at",
        attachment.email,
        input.body,
        createdAt,
      )
      .one();
    this.ctx.storage.sql.exec(
      "DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT ?)",
      HISTORY_LIMIT,
    );

    const chatMessage = toMessage(row);
    this.broadcast({ type: "message", message: chatMessage });
    console.log(
      JSON.stringify({
        event: "message_posted",
        channel: attachment.channel,
        messageId: chatMessage.id,
        participants: this.ctx.getWebSockets().length,
      }),
    );
  }

  /**
   * Notify and disconnect every participant, then erase all state before directory removal.
   *
   * `ctx.storage.deleteAll()` drops the `messages` table itself, not merely its rows, and this
   * instance is not necessarily evicted afterward. Recreating the schema immediately — rather
   * than relying on eviction to re-run the constructor — guarantees a channel later recreated
   * with the same name starts from an empty, freshly initialized store on its very next
   * request, with no dependency on eviction timing.
   *
   * @returns Promise resolved after all channel state has been deleted and reinitialized.
   */
  async destroy(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      send(socket, { type: "channel_removed" });
      socket.close(CHANNEL_REMOVED_CLOSE_CODE, "Channel removed.");
    }
    await this.ctx.storage.deleteAll();
    this.initializeSchema();
  }

  /** Broadcast a participant-count change after a socket closes. */
  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    const attachment =
      socket.deserializeAttachment() as ChatSocketAttachment | null;
    this.broadcastPresence();
    console.log(
      JSON.stringify({
        event: "channel_left",
        channel: attachment?.channel,
        code,
        reason,
        participants: this.ctx.getWebSockets().length,
      }),
    );
  }

  /** Broadcast a participant-count change when a socket terminates with an error. */
  webSocketError(socket: WebSocket, _error: unknown): void {
    const attachment =
      socket.deserializeAttachment() as ChatSocketAttachment | null;
    this.broadcastPresence();
    console.log(
      JSON.stringify({
        event: "channel_left",
        channel: attachment?.channel,
        participants: this.ctx.getWebSockets().length,
      }),
    );
  }

  /** Create the durable `messages` table if it does not already exist. */
  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  }

  /** @returns The bounded recent message history in chronological order. */
  private recentMessages(): ChatMessage[] {
    return this.ctx.storage.sql
      .exec<MessageRow>(
        "SELECT id, author, body, created_at FROM messages ORDER BY id DESC LIMIT ?",
        HISTORY_LIMIT,
      )
      .toArray()
      .reverse()
      .map(toMessage);
  }

  /** Broadcast one event to every currently connected participant. */
  private broadcast(event: object): void {
    for (const socket of this.ctx.getWebSockets()) {
      send(socket, event);
    }
  }

  /** Broadcast the current participant count without retaining process-local connection state. */
  private broadcastPresence(): void {
    this.broadcast({
      type: "presence",
      participants: this.ctx.getWebSockets().length,
    });
  }
}
