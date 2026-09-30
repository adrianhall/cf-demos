/**
 * @file In-memory fakes for the two ports `ChatService` depends on. Having both ports as plain
 *   interfaces is what makes these tests possible at all: the service's rules — validation,
 *   existence checks, and the order in which the directory and the room are touched — are exercised
 *   in plain Node, with no Workers runtime, no D1, and no Durable Object.
 */

import type {
  Channel,
  ChannelRepository,
  ChatRoomPort,
  CreateChannelInput
} from '../../../src/worker/domain/channel';

/**
 * One operation performed against either fake, recorded in the order it happened.
 *
 * Both fakes append to the _same_ log, which is the point: the service's teardown ordering rule
 * (destroy the room before delisting the channel) is only observable across the two ports, so
 * separate per-fake logs could not express it.
 */
export type RecordedOperation =
  | { port: 'channels'; operation: 'list' }
  | { port: 'channels'; operation: 'find'; name: string }
  | { port: 'channels'; operation: 'create'; name: string; createdBy: string }
  | { port: 'channels'; operation: 'remove'; name: string }
  | { port: 'rooms'; operation: 'join'; channel: string; participant: string }
  | { port: 'rooms'; operation: 'destroy'; channel: string };

/**
 * Both fakes plus the shared operation log they write to.
 */
export interface FakePorts {
  /**
   * In-memory channel directory.
   */
  channels: ChannelRepository;
  /**
   * In-memory room coordinator.
   */
  rooms: ChatRoomPort;
  /**
   * Every operation either port received, in order.
   */
  operations: RecordedOperation[];
  /**
   * The exact `Response` the fake room returns from `join`.
   *
   * A test asserts the service returns _this object_, by reference. That is the real contract: a
   * genuine upgrade response carries a `webSocket` property that would be lost if the service
   * rebuilt the response instead of passing it through, and reference equality is the only
   * assertion that catches such a rebuild.
   */
  upgradeResponse: Response;
}

/**
 * Build a channel record with fixed provenance, for seeding a fake directory.
 *
 * @param name Channel name.
 * @returns A channel owned by a stable test identity with a fixed timestamp, so assertions never
 *   depend on the clock.
 */
export function channelNamed(name: string): Channel {
  return { name, createdBy: 'alice@example.com', createdAt: '2026-01-01T00:00:00.000Z' };
}

/**
 * Create in-memory implementations of both ports.
 *
 * @param seeded Channels the directory starts with.
 * @returns The two fakes and the shared operation log.
 */
export function createFakePorts(seeded: Channel[] = []): FakePorts {
  const stored = new Map(seeded.map((channel) => [channel.name, channel]));
  const operations: RecordedOperation[] = [];
  // Not a literal `101`: Node's `Response` constructor rejects informational statuses, which
  // only the Workers runtime permits. The real upgrade response is covered by the
  // Workers-runtime suite; here the object only needs to be identifiable.
  const upgradeResponse = new Response(null, { status: 200 });

  const channels: ChannelRepository = {
    /**
     * List the seeded channels in name order, matching the real repository's contract.
     *
     * @returns Every stored channel, name-ordered.
     */
    async list(): Promise<Channel[]> {
      operations.push({ port: 'channels', operation: 'list' });
      return [...stored.values()].sort((left, right) => left.name.localeCompare(right.name));
    },

    /**
     * Look one channel up by name.
     *
     * @param name Channel name to find.
     * @returns The stored channel, or `null`.
     */
    async find(name: string): Promise<Channel | null> {
      operations.push({ port: 'channels', operation: 'find', name });
      return stored.get(name) ?? null;
    },

    /**
     * Store a channel.
     *
     * Deliberately does _not_ reproduce the real repository's conflict behaviour: name collision is
     * a storage-level guarantee proven in `d1-channel-repository.test.ts` and in the
     * Workers-runtime suite, and duplicating it here would make these tests assert the fake.
     *
     * @param input Validated creation input.
     * @param createdBy Identity creating the channel.
     * @returns The stored channel.
     */
    async create(input: CreateChannelInput, createdBy: string): Promise<Channel> {
      operations.push({
        port: 'channels',
        operation: 'create',
        name: input.name,
        createdBy
      });
      const channel: Channel = {
        name: input.name,
        createdBy,
        createdAt: '2026-01-01T00:00:00.000Z'
      };
      stored.set(channel.name, channel);
      return channel;
    },

    /**
     * Delete a channel.
     *
     * @param name Channel to delete.
     * @returns Whether anything was deleted.
     */
    async remove(name: string): Promise<boolean> {
      operations.push({ port: 'channels', operation: 'remove', name });
      return stored.delete(name);
    }
  };

  const rooms: ChatRoomPort = {
    /**
     * Record a join and return the shared stand-in upgrade response.
     *
     * @param channel Channel being joined.
     * @param _request The caller's upgrade request; unused, because completing a real protocol
     *   switch needs the Workers runtime and is covered by the integration suite instead.
     * @param participant Identity the service passed through.
     * @returns The same {@link FakePorts.upgradeResponse} every time, so a test can assert the
     *   service returned it unchanged rather than rebuilding it.
     */
    async join(channel: string, _request: Request, participant: string): Promise<Response> {
      operations.push({ port: 'rooms', operation: 'join', channel, participant });
      return upgradeResponse;
    },

    /**
     * Record a room teardown.
     *
     * @param channel Channel whose room is destroyed.
     * @returns A promise fulfilled immediately.
     */
    async destroy(channel: string): Promise<void> {
      operations.push({ port: 'rooms', operation: 'destroy', channel });
    }
  };

  return { channels, rooms, operations, upgradeResponse };
}
