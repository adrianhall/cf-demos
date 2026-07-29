/** Publication state returned by the Media Drop API. */
export type MediaStatus = "draft" | "published";

/** Metadata used to render a media object without exposing its R2 key. */
export interface MediaItem {
  /** Immutable media identifier. */
  id: string;
  /** Creator-provided display title. */
  title: string;
  /** MIME type used to select an appropriate preview element. */
  contentType: string;
  /** Stored object size in bytes. */
  sizeBytes: number;
  /** Whether the item is private or public. */
  status: MediaStatus;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** ISO-8601 time of the latest metadata update. */
  updatedAt: string;
  /** ISO-8601 publication time, if the item is public. */
  publishedAt: string | null;
}

/** File types accepted by the Media Drop upload API. */
export const allowedMediaTypes = new Set([
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
]);

/** Largest file accepted by both the client and Worker upload guards. */
export const maxMediaSizeBytes = 100 * 1024 * 1024;

/** Format a byte count for compact human-readable metadata. */
export function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format an API timestamp in the viewer's local timezone. */
export function formatDate(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

/**
 * Returns a new array with the item matching `id` replaced by `replacement`,
 * leaving every other item unchanged.
 * @param items the source media list
 * @param id the identifier of the item to replace
 * @param replacement the fresh item returned by the API
 * @returns a new array reflecting the replacement
 */
export function replaceMedia(
  items: MediaItem[],
  id: string,
  replacement: MediaItem,
): MediaItem[] {
  return items.map((item) => (item.id === id ? replacement : item));
}
