import { DurableObject } from 'cloudflare:workers';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import { CHANNEL_REMOVED_CLOSE_CODE, type ServerFrame } from '../../chat-protocol';
import type { ChatMessage } from '../domain/channel';
import { validatePostMessageInput } from '../domain/channel-validation';
import { IDENTITY_HEADER } from './room-protocol';

/**
 * How many messages a room keeps. Old messages are discarded on every write, so a room's storage is
 * bounded no matter how long a channel lives.
 *
 * A fixed window is right for a demo and would be wrong for a real product, which is exactly why it
 * is worth being explicit about: the trade-off is that history is capped, not that it is cheap. A
 * production system wanting full history would keep writing here and archive older messages to R2
 * or D1 on an alarm, leaving this window as the hot path.
 */
const HISTORY_LIMIT = 100;

/**
 * Raw row as stored in the room's own SQLite database.
 *
 * The index signature is required by `SqlStorage.exec`'s type parameter, which constrains rows to
 * maps of `SqlStorageValue`.
 */
interface MessageRow extends Record<string, SqlStorageValue> {
  /**
   * Row identifier assigned by SQLite.
   */
  id: number;
  /**
   * Verified identity that wrote the message.
   */
  author: string;
  /**
   * Message text as stored.
   */
  body: string;
  /**
   * ISO-8601 timestamp recorded when the message was persisted.
   */
  created_at: string;
}

/**
 * What the room pins to each accepted connection.
 *
 * Stored with `serializeAttachment` rather than in an instance field, because an instance field
 * would not survive hibernation: the room is evicted from memory while its sockets stay open, and
 * is reconstructed when the next message arrives. An in-memory map of socket to identity would be
 * empty at exactly the moment the identity is needed.
 */
interface SocketAttachment {
  /**
   * Verified Cloudflare Access identity of the participant on this connection. This is the single
   * source of truth for message authorship.
   */
  participant: string;
}

/**
 * Convert a stored row into the domain representation.
 *
 * @param row Row returned by a query against the room's `messages` table.
 * @returns The equivalent domain message.
 */
function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    author: row.author,
    body: row.body,
    createdAt: row.created_at
  };
}

/**
 * Send one frame to a socket, skipping any socket that is no longer open.
 *
 * The state check matters during a broadcast: a participant can disconnect between the runtime
 * listing the sockets and the room reaching theirs, and sending to a closed socket throws. One
 * departing participant must not abort delivery to everybody after them in the list.
 *
 * @param socket Connection to send on.
 * @param frame Frame to serialize and send.
 */
function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}

/**
 * One chat channel's live conversation: the coordination point every participant in that channel
 * connects to.
 *
 * There is exactly one instance per channel name, addressed with
 * `env.CHAT_ROOM.getByName(channel)`. Isolation between channels is therefore structural rather
 * than enforced: a different name is a different object, with its own storage and its own sockets,
 * so there is no cross-channel query to get wrong and no shared state to leak. Compare the sibling
 * `todo` demo, where every user's rows share one table and isolation depends on getting a `WHERE`
 * clause right in every single statement.
 *
 * A Durable Object is the correct tool here — rather than D1, or KV — because a chat channel is a
 * single-writer coordination problem:
 *
 * - **Ordering.** Every message for a channel is handled by one object, so the order it assigns is
 *   the order every participant observes. A store with multiple writers could not promise that
 *   without a coordination layer on top.
 * - **Live fan-out.** The object holds the open WebSockets, so a message can be delivered to
 *   connected participants immediately. Neither D1 nor KV has any notion of a connected reader, so
 *   a message would only arrive when a client polled for it.
 * - **Consistency with the write.** The message is durable before anybody sees it, without a
 *   transaction spanning two systems.
 *
 * ## Hibernation
 *
 * Connections are accepted with `ctx.acceptWebSocket()` rather than `socket.accept()`, which puts
 * them under the WebSocket Hibernation API. An idle channel's sockets stay connected at the edge
 * while the object itself is evicted from memory, so an empty overnight channel costs nothing. When
 * a message finally arrives, the runtime reconstructs the object — re-running the constructor — and
 * delivers the message to {@link ChatRoom.webSocketMessage}. Everything the room needs after that
 * reconstruction must therefore live in storage or in a socket attachment; see
 * {@link SocketAttachment}.
 *
 * ## Why this class is in the infrastructure tier
 *
 * It backs the {@link ChatRoomPort} contract (`src/worker/domain/channel.ts`), reached through the
 * `DurableChatRooms` adapter, and it is the adapter for a specific Cloudflare product — so it
 * belongs beside the D1 repository rather than in the application layer. It calls into the domain
 * for validation (`validatePostMessageInput`) exactly as the HTTP path does, so a message arriving
 * over a socket is held to identical rules.
 */
export class ChatRoom extends DurableObject<Env> {
  /**
   * Ensure the room's schema exists before it handles anything.
   *
   * The work is wrapped in `blockConcurrencyWhile` so no event can be delivered against a room
   * whose table has not been created yet. The constructor runs on every reconstruction after
   * hibernation, not only on first use, which is why the statement is idempotent.
   *
   * @param ctx Durable Object state supplying storage and the connected sockets.
   * @param env Worker bindings available to this object.
   */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void this.ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
    });
  }

  /**
   * Accept a participant's connection and replay the channel's recent history.
   *
   * This is a `fetch` handler rather than an RPC method, unlike {@link ChatRoom.destroy}, and that
   * is forced by the protocol rather than chosen. The response carries a live `WebSocket`, which
   * cannot be serialized across an RPC boundary, and the Hibernation API completes the protocol
   * switch against the incoming request itself. The upgrade therefore has to arrive as a request.
   *
   * The consequence is that the participant's identity arrives in a header, which this method
   * trusts without checking. That is safe for two reasons, both established outside this class: a
   * Durable Object has no route of its own, so the only way here is through a Worker that
   * authenticates first; and `withVerifiedIdentity` (see `./room-protocol.ts`) strips any
   * client-supplied copy of the header before setting the verified one.
   *
   * The identity is pinned to the connection here, once. Every later message reads it back from the
   * attachment, so a participant cannot post as somebody else even controlling every byte of every
   * frame they send.
   *
   * @param request Upgrade request forwarded by the Worker, carrying the verified identity in
   *   {@link IDENTITY_HEADER}.
   * @returns A `101 Switching Protocols` response whose `webSocket` is the client end of the new
   *   connection, or a `400` when the request is not a valid, identified upgrade. The `400` is
   *   unreachable through the Worker, which validates both conditions first; it exists so a direct
   *   call during development fails clearly instead of creating an unattributed connection.
   */
  async fetch(request: Request): Promise<Response> {
    const participant = request.headers.get(IDENTITY_HEADER);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' || participant === null) {
      return new Response('Expected an identified WebSocket upgrade.', { status: 400 });
    }

    const [client, server] = Object.values(new WebSocketPair());

    server.serializeAttachment({ participant } satisfies SocketAttachment);
    // Hibernatable: the runtime, not this object, holds the connection while the room is idle.
    this.ctx.acceptWebSocket(server);

    // History first, then presence. A participant should see what was already said before being
    // told how many people are here, otherwise the count momentarily describes a room whose
    // contents they cannot see yet.
    send(server, { type: 'history', messages: this.recentMessages() });
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Erase the channel's conversation and disconnect everybody in it.
   *
   * Called through {@link ChatRoomPort.destroy} when a channel is removed. Participants are
   * notified and closed _before_ storage is erased, so nobody is still holding an open socket to a
   * room whose history has already gone.
   *
   * `deleteAll()` drops the `messages` table itself rather than just its rows, and the object is
   * not necessarily evicted afterwards, so the schema is recreated immediately. Without that, a
   * channel later recreated under the same name would address this same object and hit a missing
   * table on its first write — a bug that would only appear when eviction happened not to occur,
   * which is the worst kind.
   *
   * @returns A promise fulfilled once every participant is disconnected and all messages are
   * gone.
   */
  async destroy(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      send(socket, { type: 'channel_removed' });
      socket.close(CHANNEL_REMOVED_CLOSE_CODE, 'Channel removed.');
    }
    await this.ctx.storage.deleteAll();
    this.initializeSchema();
  }

  /**
   * Persist one participant's message, then broadcast it.
   *
   * The order is load-bearing: persist first, broadcast second. Broadcasting first would let a
   * participant see a message that a subsequent reconnection would not replay, because the write
   * that would have made it real never happened. Persisting first can at worst lose the broadcast —
   * and the message is still in storage, so the next history replay includes it.
   *
   * The author is read from the socket attachment, never from the frame. That is the entire
   * authorship guarantee of this demo, and it holds by construction: the frame has no author field,
   * the domain rejects any payload that adds one, and this method never looks at the payload for
   * identity.
   *
   * @param socket Connection the message arrived on, carrying the sender's pinned identity.
   * @param message Raw frame from the participant; a string for text frames, an `ArrayBuffer` for
   *   binary ones.
   * @returns A promise fulfilled once the message is persisted and broadcast, or once the sender
   *   has been told why it was rejected.
   */
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment === null) {
      // Unreachable through `join`, which always attaches before accepting. Closing rather than
      // defaulting to an anonymous author is the safe response: a message with no provable author
      // must not enter the history.
      socket.close(1011, 'Connection is missing its identity.');
      return;
    }

    let body: string;
    try {
      body = validatePostMessageInput(decodeFrame(message)).body;
    } catch (cause) {
      // A rejected message is reported to its sender and to nobody else: it is never persisted
      // and never broadcast. The connection stays open, because one bad message is not a reason
      // to disconnect a participant.
      send(socket, { type: 'error', detail: rejectionDetail(cause) });
      return;
    }

    const persisted = this.persist(attachment.participant, body);
    this.broadcast({ type: 'message', message: persisted });

    // The author is deliberately absent from this log record: it is a verified identity, and so
    // personal data, and the message body is user content. The channel and identifier are enough
    // to correlate a delivery problem without retaining either.
    console.log(
      JSON.stringify({
        event: 'message_posted',
        messageId: persisted.id,
        participants: this.ctx.getWebSockets().length
      })
    );
  }

  /**
   * Update everybody's participant count after a connection closes.
   *
   * @param _socket Connection that closed; unused, because the count is derived from the runtime's
   *   own list rather than tracked incrementally.
   * @param _code Close code reported by the runtime.
   * @param _reason Close reason reported by the runtime.
   */
  webSocketClose(_socket: WebSocket, _code: number, _reason: string): void {
    this.broadcastPresence();
  }

  /**
   * Update everybody's participant count after a connection fails.
   *
   * Handled identically to a clean close: from the room's point of view a participant who errored
   * out and one who left are both simply gone, and the remaining participants should see the same
   * corrected count either way.
   *
   * @param _socket Connection that failed.
   * @param _error Error the runtime reported.
   */
  webSocketError(_socket: WebSocket, _error: unknown): void {
    this.broadcastPresence();
  }

  /**
   * Create the room's message table if it does not already exist.
   *
   * Written inline rather than through the repository-root `migrations/` directory, because those
   * migrations belong to D1 and this is a different database: every Durable Object instance has its
   * own private SQLite store, created on demand when a channel is first used. There is nothing to
   * migrate ahead of time and nowhere central to migrate it.
   */
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

  /**
   * Insert a message and trim the history window.
   *
   * `RETURNING` gives back the identifier and stored values in the same statement, so the broadcast
   * carries exactly what was written rather than a client-side reconstruction of it.
   *
   * @param author Verified identity taken from the sender's socket attachment.
   * @param body Validated message text.
   * @returns The persisted message.
   */
  private persist(author: string, body: string): ChatMessage {
    const row = this.ctx.storage.sql
      .exec<MessageRow>(
        'INSERT INTO messages (author, body, created_at) VALUES (?, ?, ?) '
          + 'RETURNING id, author, body, created_at',
        author,
        body,
        new Date().toISOString()
      )
      .one();

    this.ctx.storage.sql.exec(
      'DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT ?)',
      HISTORY_LIMIT
    );

    return toMessage(row);
  }

  /**
   * Read the history window in chronological order.
   *
   * The query takes the _newest_ rows (`ORDER BY id DESC LIMIT`) and the result is then reversed,
   * rather than ordering ascending and taking the last rows. Ordering descending lets SQLite stop
   * as soon as it has the window; ordering ascending would require walking the whole table first.
   *
   * @returns Up to {@link HISTORY_LIMIT} messages, oldest first.
   */
  private recentMessages(): ChatMessage[] {
    return this.ctx.storage.sql
      .exec<MessageRow>(
        'SELECT id, author, body, created_at FROM messages ORDER BY id DESC LIMIT ?',
        HISTORY_LIMIT
      )
      .toArray()
      .reverse()
      .map(toMessage);
  }

  /**
   * Send one frame to every connected participant.
   *
   * The socket list comes from `ctx.getWebSockets()` rather than from an instance field, because an
   * instance field would be empty after the room hibernated and was reconstructed. The runtime owns
   * the connections; the room only borrows the list when it needs it.
   *
   * @param frame Frame to send to everybody in the channel.
   */
  private broadcast(frame: ServerFrame): void {
    for (const socket of this.ctx.getWebSockets()) {
      send(socket, frame);
    }
  }

  /**
   * Tell every participant how many people are currently connected.
   */
  private broadcastPresence(): void {
    this.broadcast({ type: 'presence', participants: this.ctx.getWebSockets().length });
  }
}

/**
 * Decode a raw WebSocket frame into a JSON value.
 *
 * Binary frames are rejected outright rather than decoded as UTF-8. The client only ever sends text
 * (see `src/client/stores/room.ts`), so a binary frame means something other than this application
 * is talking to the room, and guessing at its encoding would be a way to accept input nobody
 * designed.
 *
 * @param message Raw frame delivered by the runtime.
 * @returns The parsed JSON value, still untrusted and not yet validated.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the frame is binary or is not valid JSON.
 *   A `ProblemDetailsError` rather than a plain `Error` so the rejection reported over the socket
 *   carries the same user-safe `detail` the HTTP API would have returned.
 */
function decodeFrame(message: string | ArrayBuffer): unknown {
  if (typeof message !== 'string') {
    throw badRequestFrame('Messages must be sent as text frames.');
  }
  try {
    return JSON.parse(message);
  } catch {
    throw badRequestFrame('Messages must contain valid JSON.');
  }
}

/**
 * Build the `400`-shaped error used for a malformed frame.
 *
 * @param detail User-safe explanation to report to the sender.
 * @returns A `ProblemDetailsError` carrying that detail.
 */
function badRequestFrame(detail: string): ProblemDetailsError {
  return new ProblemDetailsError({ status: 400, detail });
}

/**
 * Extract a user-safe rejection message from a thrown validation failure.
 *
 * Only the `detail` of a recognised problem is used. Anything else collapses to a generic message
 * rather than serializing an arbitrary error, so an unexpected internal failure cannot leak its
 * text to a connected client the way an unhandled rejection over HTTP would be caught by
 * `problemDetailsErrorHandler`.
 *
 * @param cause Value thrown while decoding or validating a frame.
 * @returns The problem's `detail`, or a generic message when there is none to show.
 */
function rejectionDetail(cause: unknown): string {
  if (cause instanceof ProblemDetailsError) {
    return cause.problemDetails.detail ?? 'Message rejected.';
  }
  return 'Message rejected.';
}
