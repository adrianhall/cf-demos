import type { ShareRepository } from '../application/ports/share-repository.ts';
import type { ShareRecord, SharedDiagram } from '../domain/share.ts';

/**
 * One row of the `diagram_shares` table, in D1's snake-cased column names.
 */
interface ShareRow {
  token_digest: string;
  created_at: string;
}

/**
 * The columns the public share projection selects from `diagrams`.
 *
 * `owner_email` is absent by construction. A public link must never disclose whose diagram it
 * points at, and not reading the column at all is a stronger guarantee than reading the row and
 * remembering to drop a field before serialising it.
 */
const SHARED_DIAGRAM_COLUMNS = 'id, title, description, graph_data';

/**
 * Adapter implementing {@link ShareRepository} over D1 and Workers KV.
 *
 * The two stores have deliberately unequal standing, and the split is the point of this file:
 *
 * - **D1 is authoritative.** It holds the share lifecycle — when a link was created, whether it was
 *   revoked and when — because that is a relational question ("the unrevoked row for this diagram")
 *   and because a lost share record would be a correctness failure, not a slow request.
 * - **KV is disposable.** It answers one question, `digest → diagram id`, for an anonymous request
 *   that arrives with no identity and needs no relational query. Losing the whole namespace costs a
 *   slower first lookup per link and nothing else, because every read falls back to D1.
 *
 * Both are keyed by the same SHA-256 digest, and neither ever receives a raw token: the port above
 * this file speaks only in digests, so there is no path by which a token could reach storage.
 *
 * KV is eventually consistent across locations, which is why {@link D1KvShareRepository.resolve}
 * treats a miss as "ask D1" rather than "revoked". Without that fallback, a link opened moments
 * after it was minted could fail in the very session the owner is watching.
 */
export class D1KvShareRepository implements ShareRepository {
  /**
   * @param database D1 binding, narrowed to the one capability this adapter uses so a unit test can
   *   supply a small fake rather than a complete `D1Database`.
   * @param kv Workers KV binding (`SHARES`), narrowed the same way.
   */
  constructor(
    private readonly database: Pick<D1Database, 'prepare'>,
    private readonly kv: Pick<KVNamespace, 'get' | 'put' | 'delete'>
  ) {}

  /**
   * Reads a diagram's active, unrevoked share.
   *
   * @param diagramId Diagram id.
   * @returns The active share's digest and creation timestamp, or `null` when none is active.
   * @throws {Error} When D1 rejects the statement.
   */
  async findActive(diagramId: string): Promise<ShareRecord | null> {
    const row = await this.database
      .prepare(
        `SELECT token_digest, created_at
           FROM diagram_shares
          WHERE diagram_id = ? AND revoked_at IS NULL
          LIMIT 1`
      )
      .bind(diagramId)
      .first<ShareRow>();

    return row === null ? null : { createdAt: row.created_at, tokenDigest: row.token_digest };
  }

  /**
   * Records a new active share and makes it resolvable.
   *
   * D1 is written first. If the KV write then fails, the share still exists and resolves through
   * the fallback path; the reverse order would leave a resolvable lookup entry for a share D1 has
   * no record of — one the owner could neither see nor revoke.
   *
   * @param diagramId Diagram the share points at.
   * @param tokenDigest SHA-256 hex digest of the minted token.
   * @param createdAt ISO-8601 creation timestamp.
   * @returns A promise fulfilled once the share is recorded and resolvable.
   * @throws {Error} When D1 or KV rejects the write.
   */
  async create(diagramId: string, tokenDigest: string, createdAt: string): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO diagram_shares (token_digest, diagram_id, created_at, revoked_at)
         VALUES (?, ?, ?, NULL)`
      )
      .bind(tokenDigest, diagramId, createdAt)
      .run();

    await this.kv.put(tokenDigest, diagramId);
  }

  /**
   * Revokes a diagram's active share.
   *
   * The KV entry is deleted as well as the row being marked, because KV is what an anonymous
   * request reads first: leaving the entry would keep a revoked link working until the entry
   * happened to be evicted. The row itself is updated rather than deleted, so `revoked_at` is a
   * record that the link once existed.
   *
   * @param diagramId Diagram whose share should be revoked.
   * @param revokedAt ISO-8601 revocation timestamp.
   * @returns `true` when an active share was revoked, and `false` when there was none.
   * @throws {Error} When D1 or KV rejects the write.
   */
  async revokeActive(diagramId: string, revokedAt: string): Promise<boolean> {
    const active = await this.findActive(diagramId);
    if (active === null) {
      return false;
    }

    await this.database
      .prepare('UPDATE diagram_shares SET revoked_at = ? WHERE token_digest = ?')
      .bind(revokedAt, active.tokenDigest)
      .run();
    await this.kv.delete(active.tokenDigest);

    return true;
  }

  /**
   * Revokes every active share for a diagram.
   *
   * Does not go through {@link D1KvShareRepository.revokeActive}: a cascade must not rest on the "at
   * most one active share" rule holding. If two rows were ever active, a diagram delete still has
   * to stop both resolving.
   *
   * @param diagramId Diagram being deleted.
   * @param revokedAt ISO-8601 revocation timestamp.
   * @returns The number of shares revoked.
   * @throws {Error} When D1 or KV rejects the write.
   */
  async revokeAllForDiagram(diagramId: string, revokedAt: string): Promise<number> {
    const { results } = await this.database
      .prepare(
        'SELECT token_digest FROM diagram_shares WHERE diagram_id = ? AND revoked_at IS NULL'
      )
      .bind(diagramId)
      .all<Pick<ShareRow, 'token_digest'>>();

    if (results.length === 0) {
      return 0;
    }

    for (const { token_digest: tokenDigest } of results) {
      await this.kv.delete(tokenDigest);
    }

    await this.database
      .prepare(
        'UPDATE diagram_shares SET revoked_at = ? WHERE diagram_id = ? AND revoked_at IS NULL'
      )
      .bind(revokedAt, diagramId)
      .run();

    return results.length;
  }

  /**
   * Resolves a token digest to the diagram its active share points at.
   *
   * KV supplies the fast digest → diagram-id lookup, but it does **not** decide whether the link is
   * still active. Workers KV is eventually consistent across locations: after a revocation, a
   * remote location may briefly keep returning the value it saw before the delete. Trusting that
   * hit outright would let a revoked bearer credential keep working, which is the exact moment
   * revocation is supposed to end. Every hit is therefore confirmed against D1's unrevoked row; D1
   * remains authoritative for the lifecycle rather than merely being a backup for cache misses.
   *
   * On a miss, D1 also covers the opposite propagation window — a link opened moments after it was
   * minted, before the new KV key has arrived at the reading location — and backfills the lookup.
   *
   * @param tokenDigest SHA-256 hex digest presented by an anonymous caller.
   * @returns The diagram id, or `null` when no active share has that digest.
   * @throws {Error} When D1 or KV rejects the read.
   */
  async resolve(tokenDigest: string): Promise<string | null> {
    const cached = await this.kv.get(tokenDigest);

    const row = await this.database
      .prepare(
        `SELECT diagram_id
           FROM diagram_shares
          WHERE token_digest = ? AND revoked_at IS NULL
          LIMIT 1`
      )
      .bind(tokenDigest)
      .first<{ diagram_id: string }>();

    if (row === null) {
      // Best-effort cleanup of a stale hit. The D1 decision above is already the refusal, so a KV
      // outage must not turn that secure answer into a `500` or make the stale value authoritative.
      if (cached !== null) {
        await this.kv.delete(tokenDigest).catch(() => undefined);
      }
      return null;
    }

    if (cached !== row.diagram_id) {
      // Covers both a miss and the defensive case of a corrupted/stale value pointing at another
      // diagram. D1's value wins, and the lookup is repaired for the next request.
      await this.kv.put(tokenDigest, row.diagram_id);
    }
    return row.diagram_id;
  }

  /**
   * Reads the public, read-only projection of a diagram.
   *
   * @param diagramId Diagram id, already resolved from a valid share.
   * @returns The public projection, or `null` when the diagram no longer exists.
   * @throws {Error} When D1 rejects the statement.
   */
  async findSharedDiagram(diagramId: string): Promise<SharedDiagram | null> {
    const row = await this.database
      .prepare(`SELECT ${SHARED_DIAGRAM_COLUMNS} FROM diagrams WHERE id = ? LIMIT 1`)
      .bind(diagramId)
      .first<{
        id: string;
        title: string;
        description: string | null;
        graph_data: string;
      }>();

    return row === null
      ? null
      : {
          description: row.description,
          graphData: row.graph_data,
          id: row.id,
          title: row.title
        };
  }
}
