import type { ShareRecord, SharedDiagram } from '../../domain/share.ts';

/**
 * Persistence port for read-only diagram sharing.
 *
 * Like {@link DiagramRepository}, every method here is **authorization-neutral**. The port takes
 * and returns digests and diagram ids; it never compares an owner, because ownership is an
 * application decision that has to be identical for the HTTP API, the MCP tool layer in a later
 * phase, and anything else that reaches these use cases. {@link ShareService} owns it.
 *
 * The port speaks in **digests**, never in raw tokens, and that is the whole of its security
 * contract. A method taking a raw token would make the storage tier a place a token could be
 * logged, retried or accidentally persisted; hashing above this line means nothing below it has
 * ever seen one. The one apparent exception is {@link ShareRepository.resolve}, which takes a
 * digest too — the caller hashes first.
 *
 * Which store backs which method is deliberately invisible here. The adapter
 * (`../../infrastructure/d1-kv-share-repository.ts`) keeps D1 authoritative for the share lifecycle
 * and uses KV only as a disposable lookup, and nothing above this line knows that.
 */
export interface ShareRepository {
  /**
   * Reads a diagram's active, unrevoked share, if it has one.
   *
   * @param diagramId Diagram id.
   * @returns The active share's digest and creation timestamp, or `null` when none is active.
   * @throws {Error} When the underlying store rejects the read.
   */
  findActive(diagramId: string): Promise<ShareRecord | null>;

  /**
   * Records a new active share for a diagram.
   *
   * The caller is responsible for revoking any previous share first; this method records one row
   * and makes it resolvable. Splitting the two keeps "at most one active share per diagram" an
   * application rule stated in one place rather than an invariant re-derived in storage.
   *
   * @param diagramId Diagram the share points at.
   * @param tokenDigest SHA-256 hex digest of the minted token. The raw token is never passed here.
   * @param createdAt ISO-8601 creation timestamp to record.
   * @returns A promise fulfilled once the share is recorded and resolvable.
   * @throws {Error} When the underlying store rejects the write.
   */
  create(diagramId: string, tokenDigest: string, createdAt: string): Promise<void>;

  /**
   * Revokes a diagram's active share, if it has one.
   *
   * @param diagramId Diagram whose share should be revoked.
   * @param revokedAt ISO-8601 revocation timestamp to record.
   * @returns `true` when an active share was revoked, and `false` when there was none.
   * @throws {Error} When the underlying store rejects the write.
   */
  revokeActive(diagramId: string, revokedAt: string): Promise<boolean>;

  /**
   * Revokes every active share for a diagram, whatever the number.
   *
   * Called when the diagram itself is deleted. Separate from {@link ShareRepository.revokeActive}
   * because a cascade must not depend on the "at most one active" rule holding: if a past defect
   * ever left two rows active, a delete still has to stop both resolving.
   *
   * @param diagramId Diagram being deleted.
   * @param revokedAt ISO-8601 revocation timestamp to record.
   * @returns The number of shares revoked.
   * @throws {Error} When the underlying store rejects the write.
   */
  revokeAllForDiagram(diagramId: string, revokedAt: string): Promise<number>;

  /**
   * Resolves a token digest to the id of the diagram its share points at.
   *
   * @param tokenDigest SHA-256 hex digest of the token an anonymous caller presented.
   * @returns The diagram id, or `null` when no active share has that digest.
   * @throws {Error} When the underlying store rejects the read.
   */
  resolve(tokenDigest: string): Promise<string | null>;

  /**
   * Reads the public, read-only projection of a diagram.
   *
   * Separate from {@link DiagramRepository.find} rather than reusing it, because the projections
   * genuinely differ: this one must not include the owner, and selecting the columns it may return
   * is a stronger guarantee than reading the whole row and remembering to drop one field.
   *
   * @param diagramId Diagram id, already resolved from a valid share.
   * @returns The public projection, or `null` when the diagram no longer exists.
   * @throws {Error} When the underlying store rejects the read.
   */
  findSharedDiagram(diagramId: string): Promise<SharedDiagram | null>;
}
