import type { ChatRoomPort } from '../domain/channel';
import type { ChatRoom } from './chat-room';
import { withVerifiedIdentity } from './room-protocol';

/**
 * Durable Objects implementation of the {@link ChatRoomPort} port.
 *
 * This adapter exists to keep one Cloudflare-specific detail out of the application layer:
 * `getByName`. `ChatService` asks to join or destroy "the room for channel `deploys`"; this class
 * is the only place that knows that translating a channel name into a room means asking a
 * `DurableObjectNamespace` for a stub by that name.
 *
 * Addressing by name rather than by a stored identifier is what makes the two stores need no
 * reconciliation. The directory row and the room are linked by the channel's name alone, so there
 * is no room identifier to persist, no chance of a row pointing at a room that does not exist, and
 * a channel recreated under an old name always reaches a room whose history was already erased by
 * {@link ChatRoom.destroy}.
 *
 * ## Why `destroy` is RPC and `join` is not
 *
 * `destroy` is a typed RPC call, which is what every operation here would ideally be — the method
 * name and its argument are checked by the compiler, and there is no request, header, or status
 * code to get wrong.
 *
 * `join` cannot work that way. Its result carries a live `WebSocket`, which is not serializable
 * across an RPC boundary, and the Hibernation API completes the protocol switch against the
 * incoming request itself. The upgrade therefore goes over `fetch()` and the identity travels as a
 * header, with `withVerifiedIdentity` (see `./room-protocol.ts`) responsible for making sure that
 * header can only ever hold a value this Worker verified.
 */
export class DurableChatRooms implements ChatRoomPort {
  /**
   * @param namespace Durable Object namespace bound to this Worker as `CHAT_ROOM`, whose instances
   *   are {@link ChatRoom}s.
   */
  constructor(private readonly namespace: DurableObjectNamespace<ChatRoom>) {}

  /**
   * Join a channel's room with an authenticated WebSocket upgrade.
   *
   * The participant's own request is forwarded, because the Hibernation API completes the protocol
   * switch against it. `withVerifiedIdentity` rewrites its headers first, discarding any identity
   * header the client sent and replacing it with the one the Access middleware verified — which is
   * what makes the room's unconditional trust in that header sound.
   *
   * @param channel Validated channel name, used directly as the Durable Object's name.
   * @param request The participant's upgrade request.
   * @param participant Verified Cloudflare Access identity to pin to the connection.
   * @returns The `101 Switching Protocols` response produced by the room, returned unchanged so its
   *   `webSocket` reaches the browser.
   * @throws {Error} When the room cannot accept the connection.
   */
  async join(channel: string, request: Request, participant: string): Promise<Response> {
    return this.namespace.getByName(channel).fetch(withVerifiedIdentity(request, participant));
  }

  /**
   * Erase a channel's conversation and disconnect its participants.
   *
   * @param channel Validated channel name identifying the room.
   * @returns A promise fulfilled once the room has been emptied.
   * @throws {Error} When the room cannot be destroyed.
   */
  async destroy(channel: string): Promise<void> {
    await this.namespace.getByName(channel).destroy();
  }
}
