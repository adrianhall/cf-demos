/** A short link persisted in Workers KV. */
export interface ShortLink {
  /** Immutable URL-safe identifier used in `/l/:code`. */
  code: string;
  /** Validated absolute HTTP(S) destination. */
  destination: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp for the most recent destination update. */
  updatedAt: string;
}

/** Value duplicated in KV metadata to make administrative listing efficient. */
export interface LinkMetadata {
  /** Destination used by the redirect. */
  destination: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp for the most recent destination update. */
  updatedAt: string;
}

/** JSON body accepted when creating or updating a short link. */
export interface LinkInput {
  /** Destination URL requested by the administrator. */
  destination: string;
}
