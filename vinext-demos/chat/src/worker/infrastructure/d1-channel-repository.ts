import { problemDetails } from '@adrianhall/cloudflare-toolkit/problem-details';
import type { Channel, ChannelRepository, CreateChannelInput } from '../domain/channel';

/**
 * Columns selected for every channel read. Kept as one constant so the projection, the
 * {@link ChannelRow} type, and {@link toChannel} cannot drift apart as the schema evolves.
 */
const CHANNEL_COLUMNS = 'name, created_by, created_at';

/**
 * Raw snake_cased row as stored in D1.
 */
interface ChannelRow {
  /**
   * Normalized channel name; the table's primary key.
   */
  name: string;
  /**
   * Verified identity that created the channel.
   */
  created_by: string;
  /**
   * ISO-8601 creation timestamp.
   */
  created_at: string;
}

/**
 * Convert a stored row into the camelCased domain representation.
 *
 * @param row Row returned by a D1 query using {@link CHANNEL_COLUMNS}.
 * @returns The equivalent domain channel.
 */
function toChannel(row: ChannelRow): Channel {
  return {
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

/**
 * D1 implementation of the {@link ChannelRepository} port.
 *
 * D1 is the right store for the _directory_ because that is a small, relational catalogue that
 * every participant reads and that needs one specific guarantee: uniqueness of a channel name,
 * enforced by the database rather than by application code. A `PRIMARY KEY` gives that for free and
 * makes a race between two participants creating `deploys` at the same moment resolve correctly
 * without a lock — one insert wins, the other is rejected by the constraint.
 *
 * It is emphatically _not_ where messages live. Message traffic is a stream of ordered appends with
 * live fan-out to connected readers, which is a coordination problem rather than a query problem;
 * that half belongs to the Durable Object in `./chat-room.ts`. Read replication is disabled in
 * `infra/chat.tf` for the same reason the sibling `todo` demo disables it: a participant creates a
 * channel and immediately joins it, so the directory must be read-your-writes consistent.
 */
export class D1ChannelRepository implements ChannelRepository {
  /**
   * @param database D1 database bound to this Worker (`env.DB`). Narrowed to the capabilities
   *   actually used so a unit test can supply a small fake rather than a whole `D1Database`.
   */
  constructor(private readonly database: Pick<D1Database, 'prepare'>) {}

  /**
   * List every channel, ordered by name.
   *
   * Name order rather than creation order is a deliberate UI-facing choice made in the query: it
   * means every participant's sidebar is identical and stable, so a channel does not move when
   * somebody else creates one.
   *
   * @returns All channels, name-ordered. An empty array when none exist, which is not an error.
   * @throws {Error} When D1 rejects the query.
   */
  async list(): Promise<Channel[]> {
    const result = await this.database
      .prepare(`SELECT ${CHANNEL_COLUMNS} FROM channels ORDER BY name`)
      .all<ChannelRow>();
    return result.results.map(toChannel);
  }

  /**
   * Read one channel by name.
   *
   * @param name Validated channel name.
   * @returns The channel, or `null` when no row has that name.
   * @throws {Error} When D1 rejects the query.
   */
  async find(name: string): Promise<Channel | null> {
    const row = await this.database
      .prepare(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE name = ? LIMIT 1`)
      .bind(name)
      .first<ChannelRow>();
    return row === null ? null : toChannel(row);
  }

  /**
   * Insert a channel, letting the primary key decide who wins a race.
   *
   * `INSERT OR IGNORE` plus a `meta.changes` check is used rather than a prior `SELECT`: a read
   * followed by a write would leave a window in which two concurrent creations both see the name as
   * free and both proceed, and only one of them could actually be right. Here the database's own
   * uniqueness constraint is the arbiter, so the loser is reported a conflict instead of silently
   * overwriting the winner's `created_by`.
   *
   * @param input Validated creation input.
   * @param createdBy Verified Cloudflare Access identity creating the channel.
   * @returns The persisted channel.
   * @throws {ProblemDetailsError} `409 Conflict` when a channel with that name already exists.
   *   `409` rather than `422`: the payload was perfectly valid, it simply lost a race or duplicated
   *   an existing name, and the client's correct response is to pick another name rather than to
   *   fix its request.
   * @throws {Error} When D1 rejects the insert.
   */
  async create(input: CreateChannelInput, createdBy: string): Promise<Channel> {
    const channel: Channel = {
      name: input.name,
      createdBy,
      createdAt: new Date().toISOString()
    };
    const result = await this.database
      .prepare('INSERT OR IGNORE INTO channels (name, created_by, created_at) VALUES (?, ?, ?)')
      .bind(channel.name, channel.createdBy, channel.createdAt)
      .run();
    if (result.meta.changes !== 1) {
      throw problemDetails({
        status: 409,
        detail: `A channel named "${channel.name}" already exists.`
      });
    }
    return channel;
  }

  /**
   * Delete one channel from the directory.
   *
   * @param name Validated channel name.
   * @returns `true` when a row was deleted, `false` when there was nothing to delete.
   * @throws {Error} When D1 rejects the deletion.
   */
  async remove(name: string): Promise<boolean> {
    const result = await this.database
      .prepare('DELETE FROM channels WHERE name = ?')
      .bind(name)
      .run();
    return result.meta.changes === 1;
  }
}
