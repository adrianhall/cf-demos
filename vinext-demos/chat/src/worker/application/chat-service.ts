import { notFound } from '@adrianhall/cloudflare-toolkit/errors';
import type { Channel, ChannelRepository, ChatRoomPort } from '../domain/channel';
import { validateChannelPathName, validateCreateChannelInput } from '../domain/channel-validation';

/**
 * Business logic for the shared chat workspace — the tier between the HTTP API and the two stores
 * that back it.
 *
 * This service is the only place that knows the workspace is split across two kinds of storage: a
 * relational directory of channel names, and one coordination object per channel holding that
 * channel's live conversation. Routes see a single use case; the service decides which store each
 * step belongs to and, crucially, in what order the two must be touched.
 *
 * It depends on the {@link ChannelRepository} and {@link ChatRoomPort} _ports_, not on D1 or
 * Durable Objects, so every rule below can be unit-tested in plain Node with two small fakes.
 */
export class ChatService {
  /**
   * @param channels Directory port recording which channels exist.
   * @param rooms Coordination port owning each channel's conversation and connected participants.
   */
  constructor(
    private readonly channels: ChannelRepository,
    private readonly rooms: ChatRoomPort
  ) {}

  /**
   * List every channel in the workspace.
   *
   * Unlike the sibling `todo` demo there is no per-identity filter here, and that is the point:
   * this is a shared workspace, so every authenticated participant sees the same directory.
   *
   * @returns Every channel, name-ordered.
   * @throws {Error} When the directory cannot be read.
   */
  async listChannels(): Promise<Channel[]> {
    return this.channels.list();
  }

  /**
   * Create a channel.
   *
   * No room is created here, and none is needed: a room comes into existence the first time
   * somebody joins it. Pre-creating one would mean a channel could exist in two half-states — a
   * directory row without a room, or a room without a row — and the demo would have to reconcile
   * them. Letting the name alone be the channel keeps the two stores consistent by construction.
   *
   * @param body Unvalidated JSON body from the request.
   * @param createdBy Verified Cloudflare Access identity creating the channel.
   * @returns The newly created channel.
   * @throws {ProblemDetailsError} When the body is not a valid create-channel payload (`400` or
   *   `422`), or a channel with that name already exists (`409`).
   * @throws {Error} When the directory cannot be written.
   */
  async createChannel(body: unknown, createdBy: string): Promise<Channel> {
    return this.channels.create(validateCreateChannelInput(body), createdBy);
  }

  /**
   * Join a channel, returning the WebSocket upgrade response for the caller.
   *
   * The directory is checked first so joining a channel nobody created answers `404` rather than
   * silently conjuring an empty room. Durable Objects are addressed purely by name, so without this
   * check any string would be a valid — and permanently invisible — channel.
   *
   * The participant identity is passed to the room rather than derived there, and the request is
   * passed alongside it only because a WebSocket upgrade must be completed against the original
   * request. The room never reads an identity from that request itself: the adapter overwrites the
   * identity header with this verified value first.
   *
   * @param channel Unvalidated channel name from the request path.
   * @param request The caller's upgrade request, needed to complete the protocol switch.
   * @param participant Verified Cloudflare Access identity joining the channel.
   * @returns The `101 Switching Protocols` response to return to the browser.
   * @throws {ProblemDetailsError} `notFound()` (404) when the name is malformed or no such channel
   *   exists — the same answer for both, so the endpoint does not report which names are
   *   syntactically valid.
   * @throws {Error} When the directory cannot be read or the room cannot accept the connection.
   */
  async joinChannel(channel: string, request: Request, participant: string): Promise<Response> {
    const name = validateChannelPathName(channel);
    if ((await this.channels.find(name)) === null) {
      throw notFound({ detail: 'Channel not found.' });
    }
    return this.rooms.join(name, request, participant);
  }

  /**
   * Remove a channel and everything said in it.
   *
   * The order of the two steps is the interesting part, and it is deliberately room-first:
   *
   * 1. Destroy the room, which disconnects every participant and erases the stored conversation.
   * 2. Delete the directory row.
   *
   * Reversing it would open a window in which the channel is gone from every sidebar while its room
   * is still live — participants already connected would keep talking in a channel nobody can find
   * or join. Failing between the two steps is far less harmful in this order: the channel remains
   * listed but empty, and removing it again completes the job. The alternative failure mode, an
   * orphaned room holding messages with no directory entry, would be unreachable and unremovable
   * through the API.
   *
   * @param channel Unvalidated channel name from the request path.
   * @returns A promise fulfilled once the conversation is erased and the channel is delisted.
   * @throws {ProblemDetailsError} `notFound()` (404) when the name is malformed or no such channel
   *   exists.
   * @throws {Error} When the room cannot be destroyed or the directory cannot be written.
   */
  async removeChannel(channel: string): Promise<void> {
    const name = validateChannelPathName(channel);
    if ((await this.channels.find(name)) === null) {
      throw notFound({ detail: 'Channel not found.' });
    }
    await this.rooms.destroy(name);
    await this.channels.remove(name);
  }
}
