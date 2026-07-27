import { notFound } from "@adrianhall/cloudflare-toolkit/errors";
import type { MediaItem, MediaStatus, PublicMediaItem } from "./types";

/** Snake-cased row returned by D1 for a media record. */
interface MediaRow {
  id: string;
  owner: string;
  title: string;
  content_type: string;
  size_bytes: number;
  r2_key: string;
  status: MediaStatus;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

/** Convert D1's persistent naming to the API representation. */
function toMediaItem(row: MediaRow): MediaItem {
  return {
    id: row.id,
    owner: row.owner,
    title: row.title,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    r2Key: row.r2_key,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

/** Strip internal ownership and object-key fields from public responses. */
export function toPublicMediaItem(item: MediaItem): PublicMediaItem {
  const { owner: _owner, r2Key: _r2Key, ...publicItem } = item;
  return publicItem;
}

/** D1 persistence boundary for media metadata; object bytes always remain in R2. */
export class MediaRepository {
  /** @param database D1 binding used to persist metadata records. */
  constructor(private readonly database: Pick<D1Database, "prepare">) {}

  /** @returns Published media newest first, with private fields removed. */
  async listPublished(): Promise<PublicMediaItem[]> {
    const result = await this.database
      .prepare(
        "SELECT id, owner, title, content_type, size_bytes, r2_key, status, created_at, updated_at, published_at FROM media WHERE status = 'published' ORDER BY created_at DESC",
      )
      .all<MediaRow>();
    return result.results.map(toMediaItem).map(toPublicMediaItem);
  }

  /** @throws {ProblemDetailsError} When the media is absent or not published. */
  async getPublished(id: string): Promise<MediaItem> {
    const row = await this.database
      .prepare(
        "SELECT id, owner, title, content_type, size_bytes, r2_key, status, created_at, updated_at, published_at FROM media WHERE id = ? AND status = 'published' LIMIT 1",
      )
      .bind(id)
      .first<MediaRow>();
    return this.requireRow(row);
  }

  /** @returns All media owned by the verified user, newest first. */
  async listForOwner(owner: string): Promise<MediaItem[]> {
    const result = await this.database
      .prepare(
        "SELECT id, owner, title, content_type, size_bytes, r2_key, status, created_at, updated_at, published_at FROM media WHERE owner = ? ORDER BY created_at DESC",
      )
      .bind(owner)
      .all<MediaRow>();
    return result.results.map(toMediaItem);
  }

  /** @throws {ProblemDetailsError} When the media is absent or belongs to another user. */
  async getForOwner(owner: string, id: string): Promise<MediaItem> {
    const row = await this.database
      .prepare(
        "SELECT id, owner, title, content_type, size_bytes, r2_key, status, created_at, updated_at, published_at FROM media WHERE id = ? AND owner = ? LIMIT 1",
      )
      .bind(id, owner)
      .first<MediaRow>();
    return this.requireRow(row);
  }

  /** Persist draft metadata only after its R2 object has been successfully stored. */
  async createDraft(item: MediaItem): Promise<void> {
    await this.database
      .prepare(
        "INSERT INTO media (id, owner, title, content_type, size_bytes, r2_key, status, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        item.id,
        item.owner,
        item.title,
        item.contentType,
        item.sizeBytes,
        item.r2Key,
        item.status,
        item.createdAt,
        item.updatedAt,
        item.publishedAt,
      )
      .run();
  }

  /** @throws {ProblemDetailsError} When the item is not a draft owned by this user. */
  async publish(owner: string, id: string): Promise<MediaItem> {
    const item = await this.getForOwner(owner, id);
    if (item.status === "published") {
      return item;
    }
    const timestamp = new Date().toISOString();
    await this.database
      .prepare(
        "UPDATE media SET status = 'published', published_at = ?, updated_at = ? WHERE id = ? AND owner = ?",
      )
      .bind(timestamp, timestamp, id, owner)
      .run();
    return {
      ...item,
      status: "published",
      publishedAt: timestamp,
      updatedAt: timestamp,
    };
  }

  /** Remove metadata after the caller has removed its R2 object. */
  async deleteForOwner(owner: string, id: string): Promise<void> {
    await this.database
      .prepare("DELETE FROM media WHERE id = ? AND owner = ?")
      .bind(id, owner)
      .run();
  }

  /** Narrow D1's nullable lookup result and hide absent/foreign records behind one 404. */
  private requireRow(row: MediaRow | null): MediaItem {
    if (row === null) {
      throw notFound({ detail: "Media not found." });
    }
    return toMediaItem(row);
  }
}
