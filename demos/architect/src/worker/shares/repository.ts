import type { CreatedShare, ShareStatus } from "./types";

/** Number of random bytes in a raw share token (256 bits). */
const TOKEN_BYTES = 32;

/**
 * Generate a cryptographically random, URL-safe share token. Mirrors
 * `demos/url-shortener`'s `LinkRepository.generateCode()` encoding, at a much longer length
 * appropriate for an unguessable capability token rather than a short human-typed code.
 *
 * @returns An unpadded base64url string (43 characters for {@link TOKEN_BYTES} bytes).
 */
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * Hash a share token with SHA-256, hex-encoded. The digest -- never the raw token -- is what
 * this repository ever persists, in both D1 (`diagram_shares.token_digest`) and as the `SHARES`
 * KV key (docs/09-ARCHITECT.md's Decisions #3). Mirrors `demos/media-drop`'s
 * `createMediaKey()` digest computation.
 *
 * @param value Raw token to hash.
 * @returns Lowercase hex-encoded SHA-256 digest.
 */
async function digestHex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * D1 + KV persistence boundary for read-only diagram sharing (docs/09-ARCHITECT.md's Data Model
 * and Decisions #3). D1's `diagram_shares` table is the owner-facing record of a diagram's
 * current and past share links (used by `getStatus()`/`revokeActive()`/`revokeAllForDiagram()`);
 * the `SHARES` KV namespace is the fast, anonymous token-to-diagram pointer the public share
 * viewer reads on every request (`resolve()`). Both are keyed by the same SHA-256 token digest
 * -- the raw token is never written to either store.
 *
 * At most one *active* (unrevoked) share exists per diagram at a time: `rotate()` always revokes
 * a diagram's prior active share, if any, before minting a new one, so the owner never has to
 * reason about multiple simultaneously valid links for the same diagram.
 */
export class ShareRepository {
  /**
   * @param database D1 capability used to prepare the repository's statements.
   * @param kv Workers KV namespace (`env.SHARES`) used for anonymous token resolution.
   */
  constructor(
    private readonly database: Pick<D1Database, "prepare">,
    private readonly kv: Pick<KVNamespace, "get" | "put" | "delete">,
  ) {}

  /**
   * Report whether a diagram currently has an active share link, without ever exposing a token
   * -- the server itself cannot recover one once minted (see {@link ShareStatus}'s JSDoc).
   *
   * @param diagramId Diagram id, already confirmed owned by the caller.
   * @returns The diagram's current share status.
   */
  async getStatus(diagramId: string): Promise<ShareStatus> {
    const row = await this.database
      .prepare(
        `SELECT created_at FROM diagram_shares WHERE diagram_id = ? AND revoked_at IS NULL LIMIT 1`,
      )
      .bind(diagramId)
      .first<{ created_at: string }>();
    return row === null
      ? { active: false, createdAt: null }
      : { active: true, createdAt: row.created_at };
  }

  /**
   * Mint a new share link for a diagram, revoking any previously active one for the same
   * diagram in the same operation (see the class-level JSDoc). This is the *only* moment the raw
   * token is ever available anywhere in this system -- callers must hand it to the owner
   * immediately and never expect to retrieve it again.
   *
   * @param diagramId Diagram id, already confirmed owned by the caller.
   * @returns The newly minted raw token and its creation timestamp.
   */
  async rotate(diagramId: string): Promise<CreatedShare> {
    await this.revokeActive(diagramId);

    const token = randomToken();
    const tokenDigest = await digestHex(token);
    const createdAt = new Date().toISOString();

    await this.database
      .prepare(
        `INSERT INTO diagram_shares (token_digest, diagram_id, created_at, revoked_at)
         VALUES (?, ?, ?, NULL)`,
      )
      .bind(tokenDigest, diagramId, createdAt)
      .run();
    await this.kv.put(tokenDigest, diagramId);

    return { createdAt, token };
  }

  /**
   * Revoke a diagram's currently active share link, if any -- deleting its `SHARES` KV entry so
   * an in-flight anonymous viewer stops resolving immediately, and recording `revoked_at` in D1
   * rather than deleting the row (an audit trail of past links, per the class-level JSDoc).
   *
   * @param diagramId Diagram id, already confirmed owned by the caller.
   * @returns Whether an active share was actually revoked.
   */
  async revokeActive(diagramId: string): Promise<boolean> {
    const row = await this.database
      .prepare(
        `SELECT token_digest FROM diagram_shares WHERE diagram_id = ? AND revoked_at IS NULL LIMIT 1`,
      )
      .bind(diagramId)
      .first<{ token_digest: string }>();
    if (row === null) {
      return false;
    }

    const revokedAt = new Date().toISOString();
    await this.database
      .prepare(
        `UPDATE diagram_shares SET revoked_at = ? WHERE token_digest = ?`,
      )
      .bind(revokedAt, row.token_digest)
      .run();
    await this.kv.delete(row.token_digest);
    return true;
  }

  /**
   * Revoke every active share link for a diagram. Called when a diagram itself is deleted
   * (`../routes/diagrams.ts`'s owner-delete route, and Phase 4's admin moderation delete) so a
   * previously shared link for a now-gone diagram never keeps resolving.
   *
   * @param diagramId Diagram id being deleted. No ownership check of its own -- callers must
   * only invoke this after confirming the diagram delete itself already succeeded.
   */
  async revokeAllForDiagram(diagramId: string): Promise<void> {
    const { results } = await this.database
      .prepare(
        `SELECT token_digest FROM diagram_shares WHERE diagram_id = ? AND revoked_at IS NULL`,
      )
      .bind(diagramId)
      .all<{ token_digest: string }>();

    for (const { token_digest: tokenDigest } of results) {
      await this.kv.delete(tokenDigest);
    }

    if (results.length > 0) {
      await this.database
        .prepare(
          `UPDATE diagram_shares SET revoked_at = ? WHERE diagram_id = ? AND revoked_at IS NULL`,
        )
        .bind(new Date().toISOString(), diagramId)
        .run();
    }
  }

  /**
   * Resolve a raw share token to the diagram id it currently points to, for the anonymous share
   * viewer (`../routes/shares.ts`). Checks the `SHARES` KV namespace first (the fast path every
   * real request takes); falls back to D1 -- and backfills KV -- only when a KV read misses,
   * which can happen briefly after a write due to Workers KV's eventual consistency across
   * colos (mirroring CF-Architect's own KV-first-then-D1-fallback design).
   *
   * @param token Raw token presented by an anonymous caller (already format-validated by
   * `./validation.ts`'s `validateShareToken()`).
   * @returns The diagram id the token currently, validly resolves to, or `null` if the token is
   * unknown or was revoked.
   */
  async resolve(token: string): Promise<string | null> {
    const tokenDigest = await digestHex(token);

    const cached = await this.kv.get(tokenDigest);
    if (cached !== null) {
      return cached;
    }

    const row = await this.database
      .prepare(
        `SELECT diagram_id FROM diagram_shares WHERE token_digest = ? AND revoked_at IS NULL LIMIT 1`,
      )
      .bind(tokenDigest)
      .first<{ diagram_id: string }>();
    if (row === null) {
      return null;
    }

    await this.kv.put(tokenDigest, row.diagram_id);
    return row.diagram_id;
  }
}
