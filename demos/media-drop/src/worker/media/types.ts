/** Publication state for a media object. */
export type MediaStatus = "draft" | "published";

/** Metadata for an R2 object, stored separately in D1. */
export interface MediaItem {
  /** Immutable UUID assigned before the object's R2 key is created. */
  id: string;
  /** Verified Access email that owns the object. */
  owner: string;
  /** Human-readable title supplied by the creator. */
  title: string;
  /** Validated MIME type stored as R2 HTTP metadata. */
  contentType: string;
  /** Number of bytes stored in R2. */
  sizeBytes: number;
  /** Opaque R2 object key; never exposed as a direct bucket URL. */
  r2Key: string;
  /** Whether the object is private to its owner or publicly visible. */
  status: MediaStatus;
  /** ISO-8601 timestamp for object creation. */
  createdAt: string;
  /** ISO-8601 timestamp for the most recent metadata change. */
  updatedAt: string;
  /** ISO-8601 timestamp when publication occurred, when published. */
  publishedAt: string | null;
}

/** Public representation that deliberately excludes ownership and R2 key details. */
export type PublicMediaItem = Omit<MediaItem, "owner" | "r2Key">;

/** Validated request metadata needed to accept a streamed upload. */
export interface UploadInput {
  /** Normalized media title. */
  title: string;
  /** Allowed media MIME type. */
  contentType: string;
  /** Declared byte length used to preserve streaming into R2. */
  contentLength: number;
  /** Unbuffered request stream passed directly to R2. */
  body: ReadableStream;
}
