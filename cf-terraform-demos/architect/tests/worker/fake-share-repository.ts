import type { ShareRepository } from '../../src/worker/application/ports/share-repository.ts';
import type { ShareRecord } from '../../src/worker/domain/share.ts';

/**
 * One stored share, as this fake keeps it.
 *
 * Mirrors the real `diagram_shares` row deliberately, including the absence of any token field: a
 * fake that could hold a raw token would let a service bug store one and still pass the suite.
 */
export interface FakeShareRow {
  /**
   * Diagram the share points at.
   */
  diagramId: string;
  /**
   * ISO-8601 creation timestamp.
   */
  createdAt: string;
  /**
   * ISO-8601 revocation timestamp, or `null` while the share is active.
   */
  revokedAt: string | null;
}

/**
 * In-memory {@link ShareRepository} standing in for D1 plus the KV lookup.
 *
 * Like the real adapter it keeps two structures — {@link FakeShareRepository.rows} for the lifecycle
 * and {@link FakeShareRepository.lookup} for resolution — so a test can assert that a revocation
 * removes the resolvable entry rather than only marking the row. Both are keyed by digest, and
 * neither has anywhere to put a raw token, which is what makes the "no plaintext anywhere"
 * assertions in the service suite meaningful.
 *
 * Authorization-neutral, exactly like the port it implements: it answers for any diagram id it is
 * given, so the ownership refusals the service suite asserts can only be coming from the service.
 *
 * Reading the shared diagram itself is not here, because it is not a share concern: the share
 * service asks the diagram service for the owner-blind projection, so the service suite injects one
 * diagram store and both paths read the same rows.
 */
export class FakeShareRepository implements ShareRepository {
  /**
   * Share lifecycle rows, keyed by token digest.
   */
  readonly rows = new Map<string, FakeShareRow>();

  /**
   * Resolvable digest → diagram id entries, standing in for the KV namespace.
   */
  readonly lookup = new Map<string, string>();

  /**
   * @param diagramId Diagram id.
   * @returns The active share, or `null`.
   */
  async findActive(diagramId: string): Promise<ShareRecord | null> {
    for (const [tokenDigest, row] of this.rows) {
      if (row.diagramId === diagramId && row.revokedAt === null) {
        return { createdAt: row.createdAt, tokenDigest };
      }
    }
    return null;
  }

  /**
   * @param diagramId Diagram the share points at.
   * @param tokenDigest Digest of the minted token.
   * @param createdAt ISO-8601 creation timestamp.
   * @returns A promise fulfilled once the share is stored.
   */
  async create(diagramId: string, tokenDigest: string, createdAt: string): Promise<void> {
    this.rows.set(tokenDigest, { createdAt, diagramId, revokedAt: null });
    this.lookup.set(tokenDigest, diagramId);
  }

  /**
   * @param diagramId Diagram whose share should be revoked.
   * @param revokedAt ISO-8601 revocation timestamp.
   * @returns Whether an active share was revoked.
   */
  async revokeActive(diagramId: string, revokedAt: string): Promise<boolean> {
    const active = await this.findActive(diagramId);
    if (active === null) {
      return false;
    }

    const row = this.rows.get(active.tokenDigest);
    if (row) {
      this.rows.set(active.tokenDigest, { ...row, revokedAt });
    }
    this.lookup.delete(active.tokenDigest);
    return true;
  }

  /**
   * @param diagramId Diagram being deleted.
   * @param revokedAt ISO-8601 revocation timestamp.
   * @returns How many shares were revoked.
   */
  async revokeAllForDiagram(diagramId: string, revokedAt: string): Promise<number> {
    let revoked = 0;
    for (const [tokenDigest, row] of this.rows) {
      if (row.diagramId === diagramId && row.revokedAt === null) {
        this.rows.set(tokenDigest, { ...row, revokedAt });
        this.lookup.delete(tokenDigest);
        revoked += 1;
      }
    }
    return revoked;
  }

  /**
   * @param tokenDigest Digest presented by an anonymous caller.
   * @returns The diagram id, or `null`.
   */
  async resolve(tokenDigest: string): Promise<string | null> {
    return this.lookup.get(tokenDigest) ?? null;
  }
}
