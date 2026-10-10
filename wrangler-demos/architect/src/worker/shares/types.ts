/**
 * Status of a diagram's read-only share link, returned to its owner by `GET
 * /api/diagrams/:id/share` (docs/09-ARCHITECT.md's Phase 3, Decisions #3). Never carries the raw
 * token: once a share is active, the server itself no longer knows it -- only a SHA-256 digest
 * is ever persisted (`./repository.ts`) -- so a reloading owner can see *that* a link is active
 * and revoke it, but can never recover the link itself. `POST /api/diagrams/:id/share`'s
 * response is the one and only place the raw token is ever available.
 */
export interface ShareStatus {
  /** Whether an unrevoked share link currently exists for this diagram. */
  active: boolean;
  /** ISO-8601 creation timestamp of the active share, or `null` when none is active. */
  createdAt: string | null;
}

/**
 * Result of minting (or rotating) a diagram's share link (`POST /api/diagrams/:id/share`).
 * `token` is the raw, unhashed value -- see {@link ShareStatus}'s JSDoc for why this response is
 * the only place it is ever exposed.
 */
export interface CreatedShare {
  /** Raw share token. Never persisted; only its SHA-256 digest is (`./repository.ts`). */
  token: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/**
 * Read-only fields of a diagram exposed to an anonymous share viewer (`GET /api/share/:token`).
 * Deliberately excludes `ownerEmail` and every other diagram field: a public share must never
 * leak who owns the diagram it points to (docs/09-ARCHITECT.md's non-negotiable tests).
 */
export interface SharedDiagram {
  /** Diagram id, used by the client to key the read-only `@xyflow/react` canvas. */
  id: string;
  /** Diagram title. */
  title: string;
  /** Diagram description, or `null`. */
  description: string | null;
  /** Live JSON-serialised React Flow state: `{ nodes, edges, viewport }`. */
  graphData: string;
}
