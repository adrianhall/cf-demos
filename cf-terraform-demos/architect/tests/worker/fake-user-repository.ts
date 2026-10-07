import type { UserRepository } from '../../src/worker/application/ports/user-repository.ts';
import type {
  AdminUserDirectoryEntry,
  DirectoryPage,
  DirectoryRows
} from '../../src/worker/domain/user.ts';
import type { FakeDiagramRepository } from './fake-diagram-repository.ts';

/**
 * @file An in-memory {@link UserRepository} for the administrative service suite. Like the real D1
 *   adapter it computes each row's diagram count at read time from the diagram store rather than
 *   holding a counter, so a test can delete a diagram and watch the count follow — which is the
 *   property a denormalised counter would quietly break.
 */

/**
 * In-memory {@link UserRepository}, authorization-neutral exactly like the port it implements.
 *
 * It answers the directory read for anybody who asks, so the refusals the administrative suite
 * asserts can only be coming from the middleware and the service above it.
 */
export class FakeUserRepository implements UserRepository {
  /**
   * Stored directory rows, keyed by email, in insertion order.
   */
  readonly rows = new Map<string, Omit<AdminUserDirectoryEntry, 'diagramCount'>>();

  /**
   * @param diagrams Diagram store the per-row counts are computed from. Optional, because a test
   *   about pagination alone does not need one; every count is then zero.
   */
  constructor(private readonly diagrams?: FakeDiagramRepository) {}

  /**
   * @param email Verified identity email.
   * @param seenAt ISO-8601 timestamp to record.
   * @returns A promise fulfilled once the row is inserted or refreshed.
   */
  async recordSeen(email: string, seenAt: string): Promise<void> {
    const existing = this.rows.get(email);
    this.rows.set(email, {
      displayName: null,
      email,
      // Never overwritten after insert, exactly as the adapter's upsert leaves it: it is the one
      // value in the directory that would be destroyed rather than merely stale.
      firstSeenAt: existing?.firstSeenAt ?? seenAt,
      lastSeenAt: seenAt
    });
  }

  /**
   * @param page Validated pagination window.
   * @returns The requested rows, most recently active first, and the directory's total size.
   */
  async listWithDiagramCounts(page: DirectoryPage): Promise<DirectoryRows> {
    const ordered = [...this.rows.values()].sort(
      (left, right) =>
        right.lastSeenAt.localeCompare(left.lastSeenAt) || left.email.localeCompare(right.email)
    );

    const users = ordered.slice(page.offset, page.offset + page.limit).map((row) => ({
      ...row,
      diagramCount: [...(this.diagrams?.rows.values() ?? [])].filter(
        (diagram) => diagram.ownerEmail === row.email
      ).length
    }));

    return { total: ordered.length, users };
  }
}
