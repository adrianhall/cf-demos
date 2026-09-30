/**
 * An entry in the shared channel directory.
 *
 * A channel is only a _name_ plus provenance. The conversation it holds lives in a Durable Object
 * addressed by that name (see {@link ChatRoomPort}), never in this record — which is the storage
 * split this demo exists to teach.
 */
export interface Channel {
  /**
   * Normalized channel name. Immutable, because it is also the Durable Object's name: renaming a
   * channel would silently address a different, empty object rather than move the conversation.
   */
  name: string;
  /**
   * Verified Cloudflare Access identity that created the channel.
   */
  createdBy: string;
  /**
   * ISO-8601 timestamp recorded when the channel was created.
   */
  createdAt: string;
}

/**
 * Validated input required to create a channel.
 */
export interface CreateChannelInput {
  /**
   * Normalized channel name.
   */
  name: string;
}

/**
 * One message in a channel's history, as persisted by the room and sent over the wire.
 */
export interface ChatMessage {
  /**
   * Monotonically increasing identifier assigned by the room's own storage when the message is
   * persisted. Ordering by this value reproduces the exact order the room accepted messages in,
   * which a wall-clock timestamp could not guarantee.
   */
  id: number;
  /**
   * Verified Cloudflare Access identity that wrote the message. Always taken from the sender's
   * authenticated session, never from the frame they sent.
   */
  author: string;
  /**
   * Validated message text.
   */
  body: string;
  /**
   * ISO-8601 timestamp recorded when the message was persisted.
   */
  createdAt: string;
}

/**
 * Validated input required to post a message.
 */
export interface PostMessageInput {
  /**
   * Normalized message text.
   */
  body: string;
}

/**
 * Persistence port for the shared channel directory, owned by the application layer rather than by
 * HTTP routes or a storage product.
 *
 * The directory answers only "which channels exist"; it never holds a message. That separation is
 * deliberate — see {@link ChatRoomPort} for the other half and `README.md` for why each half uses
 * the storage it does.
 */
export interface ChannelRepository {
  /**
   * List every channel in the directory.
   *
   * @returns All channels in a stable, name-ordered sequence, so every participant's sidebar shows
   *   the same list in the same order.
   * @throws {Error} When the underlying storage rejects the read.
   */
  list(): Promise<Channel[]>;

  /**
   * Read one channel by name.
   *
   * @param name Validated channel name.
   * @returns The channel, or `null` when the directory has no entry with that name. `null` rather
   *   than a thrown error, because a missing channel is an ordinary outcome the application layer
   *   maps to its own response.
   * @throws {Error} When the underlying storage rejects the read.
   */
  find(name: string): Promise<Channel | null>;

  /**
   * Create a channel, failing if the name is taken.
   *
   * @param input Validated creation input.
   * @param createdBy Verified Cloudflare Access identity creating the channel.
   * @returns The persisted channel.
   * @throws {ProblemDetailsError} `conflict()` (409) when a channel with that name already exists.
   * @throws {Error} When the underlying storage rejects the write.
   */
  create(input: CreateChannelInput, createdBy: string): Promise<Channel>;

  /**
   * Remove a channel from the directory.
   *
   * @param name Validated channel name.
   * @returns `true` when a row was removed, `false` when the directory had no such channel. The
   *   boolean lets the application layer distinguish a removal from a no-op without a second read.
   * @throws {Error} When the underlying storage rejects the deletion.
   */
  remove(name: string): Promise<boolean>;
}

/**
 * Coordination port for a single channel's live conversation.
 *
 * This is the seam that keeps the application layer independent of Durable Objects. `ChatService`
 * depends on this interface; only `src/worker/index.ts` knows that the implementation behind it is
 * a `DurableObjectNamespace`. A unit test can therefore exercise every use case without a Workers
 * runtime, and the coordination technology could change without touching business logic.
 */
export interface ChatRoomPort {
  /**
   * Join a channel's room with an authenticated WebSocket upgrade.
   *
   * The caller's `Request` is part of the contract, which is unusual for a port and is a deliberate
   * concession to how WebSocket upgrades work: the upgrade has to be completed against the original
   * request, so it cannot be reduced to plain data the way every other operation here is. The
   * implementation is responsible for ensuring nothing the client sent on that request can
   * influence the identity the room records.
   *
   * @param channel Validated channel name identifying the room.
   * @param request The participant's own upgrade request, forwarded so the room can complete the
   *   protocol switch against it.
   * @param participant Verified Cloudflare Access identity to pin to the new connection. The room
   *   uses this — and only this — as the author of every message the connection later sends.
   * @returns A `101 Switching Protocols` response whose `webSocket` is the client end of the
   *   connection, ready to be returned straight to the browser.
   * @throws {Error} When the room cannot accept the connection.
   */
  join(channel: string, request: Request, participant: string): Promise<Response>;

  /**
   * Erase a channel's entire conversation and disconnect everyone in it.
   *
   * @param channel Validated channel name identifying the room.
   * @returns A promise fulfilled once every participant has been notified and disconnected and all
   *   stored messages are gone.
   * @throws {Error} When the room cannot be destroyed.
   */
  destroy(channel: string): Promise<void>;
}
