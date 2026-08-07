import type { GraphDocument } from "../../graph/types";

/**
 * Owner-visible publication status for one diagram, as returned by `GET /api/diagrams/:id/share`.
 *
 * Never includes the raw token or its digest — the raw token is returned only once, from
 * `POST /api/diagrams/:id/share`'s response, exactly like `../invitations/repository.ts`'s
 * `create()`.
 */
export interface ShareStatus {
  /** Whether this diagram currently has an active (non-revoked) published snapshot. */
  published: boolean;
  /** The published revision, present only when {@link published} is `true`. */
  revision?: number;
  /** ISO-8601 timestamp of the first publish, present only when {@link published} is `true`. */
  createdAt?: string;
  /**
   * ISO-8601 timestamp of the most recent publish/republish, present only when
   * {@link published} is `true`.
   */
  updatedAt?: string;
}

/**
 * The immutable content written to R2 at publish time and read back by both the owner-side
 * status/preview paths and the anonymous `POST /shared/resolve` endpoint.
 *
 * Deliberately contains nothing beyond what an anonymous viewer may see: a title, the published
 * revision number, and the renderer-independent graph document itself (`../../graph/types.ts`) —
 * never diagram ownership, membership, or any live `DiagramRoom` field.
 */
export interface PublishedSnapshot {
  /** The diagram's title at publish time. */
  title: string;
  /** The `DiagramRoom` revision this snapshot was taken from. */
  revision: number;
  /** The published graph document. */
  document: GraphDocument;
}

/** Result of {@link import("./repository").ShareRepository.publish}. */
export interface PublishResult {
  /**
   * The raw share token, present only on a diagram's *first* publish (a fresh token was just
   * generated). `null` on every subsequent republish/update — the existing token's SHA-256
   * digest is reused, but the raw value was never persisted, so it cannot be returned again; see
   * `./repository.ts`'s `publish()` for the full rationale, mirroring
   * `../invitations/repository.ts`'s "shown once" pattern.
   */
  token: string | null;
  /** The newly published revision. */
  revision: number;
}
