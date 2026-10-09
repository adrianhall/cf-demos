import type { CollaboratorRepository } from '../application/ports/collaborator-repository.ts';
import type { Collaborator, SharedWithMeDiagram } from '../domain/collaborator.ts';

/**
 * One row of the `diagram_collaborators` table, in D1's snake-cased column names.
 *
 * Declared here rather than anywhere above this file, matching `./d1-diagram-repository.ts`: the
 * column naming is a storage detail, and letting it leak upward would make a schema rename a change
 * to the application tier.
 */
interface CollaboratorRow {
  diagram_id: string;
  collaborator_email: string;
  display_name?: string | null;
  added_by: string;
  added_at: string;
}

/**
 * One joined diagram row as the "shared with me" read returns it.
 *
 * The same columns `./d1-diagram-repository.ts` selects, aliased from the `diagrams` table so the
 * join's result converts through the same shape an owner-scoped read produces.
 */
interface SharedDiagramRow {
  id: string;
  owner_email: string;
  title: string;
  description: string | null;
  graph_data: string;
  created_at: string;
  updated_at: string;
}

/**
 * Columns every collaborator read selects, in one place so a new column cannot be added to one
 * query and forgotten in another.
 */
const COLLABORATOR_COLUMNS = 'diagram_id, collaborator_email, added_by, added_at';

/**
 * Columns the collaborator list selects.
 *
 * Extends the stored grant with `users.display_name`. That value is always `NULL` today because
 * Access supplies no name claim, but joining it keeps the documented API shape stable for a
 * deployment that later records one. The add upsert still uses {@link COLLABORATOR_COLUMNS}, since
 * it writes no user row and cannot return a joined column.
 */
const LIST_COLLABORATOR_COLUMNS =
  'c.diagram_id, c.collaborator_email, u.display_name, c.added_by, c.added_at';

/**
 * Converts a stored grant row into the domain shape.
 *
 * @param row Row as returned by D1.
 * @returns The grant in the application tier's vocabulary.
 */
function toCollaborator(row: CollaboratorRow): Collaborator {
  return {
    addedAt: row.added_at,
    addedBy: row.added_by,
    collaboratorEmail: row.collaborator_email,
    diagramId: row.diagram_id,
    displayName: row.display_name ?? null
  };
}

/**
 * Converts a joined diagram row into the domain shape.
 *
 * @param row Row as returned by D1.
 * @returns The diagram in the application tier's vocabulary, owner included so the dashboard can
 *   say who shared it.
 */
function toSharedDiagram(row: SharedDiagramRow): SharedWithMeDiagram {
  return {
    createdAt: row.created_at,
    description: row.description,
    graphData: row.graph_data,
    id: row.id,
    ownerEmail: row.owner_email,
    title: row.title,
    updatedAt: row.updated_at
  };
}

/**
 * D1 adapter implementing {@link CollaboratorRepository}.
 *
 * D1 rather than KV for the reason the rest of this demo's authoritative data is in D1, and one
 * more specific to this table. Two of the four queries here are relational: "which diagrams has
 * this identity been added to" is a join from a grant to the diagram it names, and the idempotent
 * insert relies on a composite primary key to resolve a conflict in a single statement. A key-value
 * store can express neither — the join would be N reads after a key listing, and the upsert would
 * become a read-then-write that races itself.
 *
 * Like the port it implements, this adapter takes no authorization decisions. `remove` deletes the
 * named grant whoever asked, and `listForDiagram` returns every row for a diagram without knowing
 * who is reading. The owner-or-self rule belongs to `../application/collaborator-service.ts`; a
 * query that quietly scoped by actor would look safer and be worse, because it would put the rule
 * somewhere a second transport could bypass.
 */
export class D1CollaboratorRepository implements CollaboratorRepository {
  /**
   * @param database D1 binding, narrowed to the one capability this adapter uses so a unit test can
   *   supply a small fake rather than a complete `D1Database`.
   */
  constructor(private readonly database: Pick<D1Database, 'prepare'>) {}

  /**
   * Records a grant, or returns the one that already existed.
   *
   * One statement rather than a read followed by a conditional insert. The composite primary key
   * makes the conflict resolvable in place, and `DO UPDATE` — rather than `DO NOTHING` — is what
   * lets `RETURNING` produce a row in both branches: `DO NOTHING` returns nothing on conflict,
   * which would force exactly the second round trip this avoids.
   *
   * The update assigns `added_by` to **its own current value**, which looks like a no-op and is the
   * point. It makes the conflicting row eligible to be returned without changing it, so a re-add
   * leaves the original grant's author and timestamp intact — the audit trail records when access
   * was actually given, not when somebody last clicked the button.
   *
   * @param diagramId Diagram the grant applies to.
   * @param collaboratorEmail Identity being granted edit access.
   * @param addedBy Owner's email, recorded as the audit trail.
   * @param addedAt ISO-8601 timestamp to record on a new row.
   * @returns The stored grant, new or pre-existing.
   * @throws {Error} When D1 rejects the statement, or when it reports no row at all — which cannot
   *   happen for an upsert that either inserts or updates, so it is a storage fault rather than an
   *   outcome, and must not be reported to a caller as "the grant did not stick".
   */
  async add(
    diagramId: string,
    collaboratorEmail: string,
    addedBy: string,
    addedAt: string
  ): Promise<Collaborator> {
    const row = await this.database
      .prepare(
        `INSERT INTO diagram_collaborators (diagram_id, collaborator_email, added_by, added_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(diagram_id, collaborator_email) DO UPDATE SET added_by = added_by
      RETURNING ${COLLABORATOR_COLUMNS}`
      )
      .bind(diagramId, collaboratorEmail, addedBy, addedAt)
      .first<CollaboratorRow>();

    if (row === null) {
      throw new Error('Collaborator upsert returned no row.');
    }
    return toCollaborator(row);
  }

  /**
   * Deletes one grant.
   *
   * @param diagramId Diagram the grant applies to.
   * @param collaboratorEmail Identity whose access is being removed.
   * @returns `true` when a row was deleted, and `false` when none matched.
   * @throws {Error} When D1 rejects the statement.
   */
  async remove(diagramId: string, collaboratorEmail: string): Promise<boolean> {
    const result = await this.database
      .prepare('DELETE FROM diagram_collaborators WHERE diagram_id = ? AND collaborator_email = ?')
      .bind(diagramId, collaboratorEmail)
      .run();

    return result.meta.changes > 0;
  }

  /**
   * Lists one diagram's grants, oldest first.
   *
   * Joined to `users` for `display_name`, which is always `NULL` today because Access supplies no
   * name claim. Returning it anyway keeps the documented collaborator shape stable for a deployment
   * that later records one, and the inner join is safe because the application refuses to create a
   * grant unless that directory row already exists.
   *
   * The `diagram_id` filter rides the composite primary key's leading column
   * (`migrations/0003_create_diagram_collaborators.sql`), so this reads one diagram's rows rather
   * than scanning the shared table.
   *
   * @param diagramId Diagram whose collaborators to read.
   * @returns That diagram's grants, oldest first.
   * @throws {Error} When D1 rejects the statement.
   */
  async listForDiagram(diagramId: string): Promise<Collaborator[]> {
    const { results } = await this.database
      .prepare(
        `SELECT ${LIST_COLLABORATOR_COLUMNS}
           FROM diagram_collaborators c
           JOIN users u ON u.email = c.collaborator_email
          WHERE c.diagram_id = ?
       ORDER BY c.added_at ASC, c.collaborator_email ASC`
      )
      .bind(diagramId)
      .all<CollaboratorRow>();

    return results.map(toCollaborator);
  }

  /**
   * Lists the diagrams one identity collaborates on, most recently updated first.
   *
   * An inner join rather than two queries: the grant rows alone carry only ids, and the dashboard
   * needs each diagram's title, graph and owner to draw a card. The join direction matters for cost
   * — it starts from `diagram_collaborators` filtered by `collaborator_email`, which is what
   * `diagram_collaborators_email_idx` exists for, and then looks each diagram up by primary key.
   *
   * The inner join also absorbs a case nothing else has to handle. This schema has no foreign keys
   * (see the migration for why), so a grant can outlive the diagram it names if a delete ever
   * failed halfway; such a row simply produces no result here rather than a card pointing at
   * nothing.
   *
   * @param collaboratorEmail Identity whose grants to resolve.
   * @returns The diagrams that identity may edit, newest activity first.
   * @throws {Error} When D1 rejects the statement.
   */
  async listSharedWith(collaboratorEmail: string): Promise<SharedWithMeDiagram[]> {
    const { results } = await this.database
      .prepare(
        `SELECT d.id AS id,
                d.owner_email AS owner_email,
                d.title AS title,
                d.description AS description,
                d.graph_data AS graph_data,
                d.created_at AS created_at,
                d.updated_at AS updated_at
           FROM diagram_collaborators c
           JOIN diagrams d ON d.id = c.diagram_id
          WHERE c.collaborator_email = ?
       ORDER BY d.updated_at DESC`
      )
      .bind(collaboratorEmail)
      .all<SharedDiagramRow>();

    return results.map(toSharedDiagram);
  }

  /**
   * Reports whether a grant row exists for one diagram and identity.
   *
   * Selects a literal rather than the row's columns: the question is existence, and reading a
   * diagram's `graph_data`-sized neighbours to answer it would be wasted bytes on the hottest
   * authorization path in the application — every read, graph save and live upgrade by a non-owner
   * passes through here.
   *
   * @param diagramId Diagram to check.
   * @param email Identity to check.
   * @returns `true` when a grant exists for that pair.
   * @throws {Error} When D1 rejects the statement.
   */
  async isCollaborator(diagramId: string, email: string): Promise<boolean> {
    const row = await this.database
      .prepare(
        `SELECT 1 AS present FROM diagram_collaborators
          WHERE diagram_id = ? AND collaborator_email = ? LIMIT 1`
      )
      .bind(diagramId, email)
      .first<{ present: number }>();

    return row !== null;
  }
}
