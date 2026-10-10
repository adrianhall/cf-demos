import { badRequest } from "@adrianhall/cloudflare-toolkit/errors";
import type { Channel } from "./types";

/** Raw snake-cased channel row returned by D1. */
interface ChannelRow {
  name: string;
  created_by: string;
  created_at: string;
}

/** Convert D1's storage shape into the API representation. */
function toChannel(row: ChannelRow): Channel {
  return {
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/**
 * D1 persistence boundary for the shared channel directory. Message data deliberately remains
 * in the per-channel Durable Object rather than this relational catalog.
 */
export class ChannelRepository {
  /** @param database D1 capability used to query and update the directory. */
  constructor(private readonly database: Pick<D1Database, "prepare">) {}

  /** @returns All channels ordered by their stable names. */
  async list(): Promise<Channel[]> {
    const result = await this.database
      .prepare(
        "SELECT name, created_by, created_at FROM channels ORDER BY name",
      )
      .all<ChannelRow>();
    return result.results.map(toChannel);
  }

  /**
   * Insert a channel once for all participants.
   *
   * @param name Validated normalized channel name.
   * @param createdBy Verified Access identity creating the channel.
   * @returns Persisted channel.
   * @throws {ProblemDetailsError} When a channel with the name already exists.
   */
  async create(name: string, createdBy: string): Promise<Channel> {
    const channel: Channel = {
      name,
      createdBy,
      createdAt: new Date().toISOString(),
    };
    const result = await this.database
      .prepare(
        "INSERT OR IGNORE INTO channels (name, created_by, created_at) VALUES (?, ?, ?)",
      )
      .bind(channel.name, channel.createdBy, channel.createdAt)
      .run();
    if (result.meta.changes !== 1) {
      throw badRequest({ detail: "A channel with this name already exists." });
    }
    return channel;
  }

  /**
   * Delete one existing directory entry.
   *
   * @param name Validated normalized channel name.
   * @returns Whether the directory contained and removed the channel.
   */
  async remove(name: string): Promise<boolean> {
    const result = await this.database
      .prepare("DELETE FROM channels WHERE name = ?")
      .bind(name)
      .run();
    return result.meta.changes === 1;
  }

  /**
   * Check whether a validated name is currently routable to its Durable Object.
   *
   * @param name Validated normalized channel name.
   * @returns Whether the directory contains the channel.
   */
  async exists(name: string): Promise<boolean> {
    const row = await this.database
      .prepare("SELECT 1 AS found FROM channels WHERE name = ? LIMIT 1")
      .bind(name)
      .first<{ found: number }>();
    return row !== null;
  }
}
