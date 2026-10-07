/**
 * @file The sharing domain's data shapes. Pure types with no binding, fetch or transport
 *   dependency, so the HTTP API today and the MCP tool layer in a later phase describe one sharing
 *   model rather than two near-identical ones. One rule shapes every type here: the raw token
 *   appears in exactly one of them. See {@link CreatedShare}.
 */

import type { PublicDiagram } from './diagram.ts';

/**
 * A diagram's current share state, as its owner sees it.
 *
 * Deliberately carries no token and no URL. Only a SHA-256 digest of a token is ever persisted
 * (`./share-token.ts`), so once a link has been minted the server genuinely cannot reproduce it —
 * this type's shape is that fact made visible rather than a cautious omission. An owner who has
 * lost their link mints a new one, which revokes the old.
 */
export interface ShareStatus {
  /**
   * Whether an unrevoked share link currently exists for this diagram.
   */
  active: boolean;
  /**
   * ISO-8601 creation timestamp of the active share, or `null` when none is active.
   */
  createdAt: string | null;
}

/**
 * A newly minted share link.
 *
 * This is the **only** type in the application that carries a raw token, and the response built
 * from it is the only moment it is ever available: it is never stored, never logged, and never
 * returned by any other operation. A caller that discards it cannot ask for it again.
 */
export interface CreatedShare {
  /**
   * The raw share token. Hand it to the owner immediately; nothing can recover it afterwards.
   */
  token: string;
  /**
   * ISO-8601 creation timestamp.
   */
  createdAt: string;
}

/**
 * An active share's stored record, without the token it was minted from.
 *
 * Used by the application tier to answer "is a link active, and since when" and to find the digest
 * a revocation has to remove from the disposable lookup.
 */
export interface ShareRecord {
  /**
   * SHA-256 hex digest of the token — the stored identity of the share, and the key in both D1 and
   * the KV lookup.
   */
  tokenDigest: string;
  /**
   * ISO-8601 creation timestamp.
   */
  createdAt: string;
}

/**
 * The read-only projection an anonymous share viewer receives.
 *
 * An alias of {@link PublicDiagram} rather than a second declaration of the same four fields, so the
 * owner-blind projection is defined once for every surface that returns it: this one and the
 * administrative moderation preview. The name is kept because sharing is where the rule is
 * strictest — a public link must never disclose whose diagram it points at — and because the
 * client's own share module names the same shape.
 *
 * The graph is read at request time rather than captured when the link was created: sharing points
 * at the live diagram, so an edit the owner makes afterwards is immediately visible through the
 * same link and there is no snapshot to keep in step.
 */
export type SharedDiagram = PublicDiagram;
