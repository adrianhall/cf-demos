import type { CollaboratorRepository } from '../../src/worker/application/ports/collaborator-repository.ts';
import type { Collaborator, SharedWithMeDiagram } from '../../src/worker/domain/collaborator.ts';
import type { FakeDiagramRepository } from './fake-diagram-repository.ts';

/**
 * @file An in-memory {@link CollaboratorRepository}, shared by every suite that exercises the
 *   collaboration rules. Like `./fake-diagram-repository.ts` it is deliberately as
 *   authorization-neutral as the real adapter: it grants and revokes for anybody who asks. That is
 *   what makes the service suite meaningful — if the owner-or-self rule were missing, this fake
 *   would happily let one collaborator evict another.
 */

/**
 * Builds the map key for one grant.
 *
 * A composite string key standing in for the table's composite primary key, which is what makes
 * {@link FakeCollaboratorRepository.add} idempotent here for the same structural reason the
 * adapter's `ON CONFLICT` clause makes it idempotent in D1.
 *
 * @param diagramId Diagram the grant applies to.
 * @param collaboratorEmail Identity the grant names.
 * @returns The key identifying that pair.
 */
function grantKey(diagramId: string, collaboratorEmail: string): string {
  return `${diagramId}\u0000${collaboratorEmail}`;
}

/**
 * In-memory {@link CollaboratorRepository}, taking no authorization decisions of its own.
 */
export class FakeCollaboratorRepository implements CollaboratorRepository {
  /**
   * Stored grants, keyed by diagram and collaborator.
   */
  readonly rows = new Map<string, Collaborator>();

  /**
   * @param diagrams Diagram store `listSharedWith` resolves grants against. Optional, because a
   *   suite that only exercises the grant rules needs no diagrams; the shared list is then empty,
   *   exactly as it would be against a database whose diagrams had all been deleted.
   */
  constructor(private readonly diagrams?: FakeDiagramRepository) {}

  /**
   * @param diagramId Diagram the grant applies to.
   * @param collaboratorEmail Identity being granted edit access.
   * @param addedBy Owner's email, recorded as the audit trail.
   * @param addedAt ISO-8601 timestamp to record on a new row.
   * @returns The stored grant — the pre-existing row untouched when one is already present, which
   *   is the behaviour the real adapter's `DO UPDATE SET added_by = added_by` produces.
   */
  async add(
    diagramId: string,
    collaboratorEmail: string,
    addedBy: string,
    addedAt: string
  ): Promise<Collaborator> {
    const key = grantKey(diagramId, collaboratorEmail);
    const existing = this.rows.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const collaborator: Collaborator = {
      addedAt,
      addedBy,
      collaboratorEmail,
      diagramId,
      displayName: null
    };
    this.rows.set(key, collaborator);
    return collaborator;
  }

  /**
   * @param diagramId Diagram the grant applies to.
   * @param collaboratorEmail Identity whose access is being removed.
   * @returns Whether a grant was deleted.
   */
  async remove(diagramId: string, collaboratorEmail: string): Promise<boolean> {
    return this.rows.delete(grantKey(diagramId, collaboratorEmail));
  }

  /**
   * @param diagramId Diagram whose collaborators to read.
   * @returns That diagram's grants, oldest first.
   */
  async listForDiagram(diagramId: string): Promise<Collaborator[]> {
    return [...this.rows.values()]
      .filter((row) => row.diagramId === diagramId)
      .sort(
        (left, right) =>
          left.addedAt.localeCompare(right.addedAt)
          || left.collaboratorEmail.localeCompare(right.collaboratorEmail)
      );
  }

  /**
   * @param collaboratorEmail Identity whose grants to resolve into diagrams.
   * @returns The diagrams that identity may edit, newest activity first. A grant naming a diagram
   *   that no longer exists yields nothing, matching the real adapter's inner join.
   */
  async listSharedWith(collaboratorEmail: string): Promise<SharedWithMeDiagram[]> {
    const shared = [...this.rows.values()]
      .filter((row) => row.collaboratorEmail === collaboratorEmail)
      .map((row) => this.diagrams?.rows.get(row.diagramId))
      .filter((diagram) => diagram !== undefined);

    return shared.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /**
   * @param diagramId Diagram to check.
   * @param email Identity to check.
   * @returns Whether a grant exists for that pair.
   */
  async isCollaborator(diagramId: string, email: string): Promise<boolean> {
    return this.rows.has(grantKey(diagramId, email));
  }
}
