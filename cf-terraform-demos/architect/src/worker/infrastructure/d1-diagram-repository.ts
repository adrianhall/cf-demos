import type { DiagramRepository } from '../application/ports/diagram-repository.ts';
import type { CreateDiagramInput, Diagram, UpdateDiagramInput } from '../domain/diagram.ts';
import { DEFAULT_DIAGRAM_TITLE } from '../domain/diagram.ts';

/**
 * One row of the `diagrams` table, in D1's snake-cased column names.
 *
 * Declared here rather than anywhere above this file: the column naming is a storage detail, and
 * letting it leak upward would make a schema rename a change to the application tier.
 */
interface DiagramRow {
  id: string;
  owner_email: string;
  title: string;
  description: string | null;
  graph_data: string;
  created_at: string;
  updated_at: string;
}

/**
 * Columns every read selects, in one place so a new column cannot be added to one query and
 * forgotten in another.
 */
const DIAGRAM_COLUMNS = 'id, owner_email, title, description, graph_data, created_at, updated_at';

/**
 * Converts a stored row into the domain shape.
 *
 * @param row Row as returned by D1.
 * @returns The diagram in the application tier's vocabulary.
 */
function toDiagram(row: DiagramRow): Diagram {
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
 * D1 adapter implementing {@link DiagramRepository}.
 *
 * D1 rather than KV because the dashboard's only query — "every diagram owned by this identity,
 * most recently updated first" — is a filter and a sort across a shared table, which is what a
 * relational store answers directly and a key-value store cannot answer without listing every key.
 * The deliberate consequence is accepted elsewhere in the demo: a saved diagram must be visible to
 * the very next read, so read replication is off and D1 is the one authoritative copy.
 *
 * Like the port it implements, this adapter takes no authorization decisions. `find` returns a row
 * by id whoever owns it, and `remove` deletes by id alone; the ownership comparison belongs to
 * `../application/diagram-service.ts`. A query that silently scoped by owner would look safer and
 * be worse, because it would put the rule somewhere a second transport could bypass.
 */
export class D1DiagramRepository implements DiagramRepository {
  /**
   * @param database D1 binding, narrowed to the one capability this adapter uses so a unit test can
   *   supply a small fake rather than a complete `D1Database`.
   */
  constructor(private readonly database: Pick<D1Database, 'prepare'>) {}

  /**
   * Inserts a diagram.
   *
   * The id and both timestamps are generated here rather than accepted from the caller: a
   * client-chosen id could collide with, or deliberately target, an existing row, and a
   * client-chosen `createdAt` would let a diagram claim to predate the account.
   *
   * @param ownerEmail Verified Cloudflare Access identity that will own the diagram.
   * @param input Validated metadata.
   * @param graphData Canonical graph JSON to store verbatim.
   * @returns The persisted diagram.
   * @throws {Error} When D1 rejects the statement.
   */
  async create(ownerEmail: string, input: CreateDiagramInput, graphData: string): Promise<Diagram> {
    const now = new Date().toISOString();
    const diagram: Diagram = {
      createdAt: now,
      description: input.description ?? null,
      graphData,
      id: crypto.randomUUID(),
      ownerEmail,
      title: input.title ?? DEFAULT_DIAGRAM_TITLE,
      updatedAt: now
    };

    await this.database
      .prepare(
        `INSERT INTO diagrams (id, owner_email, title, description, graph_data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        diagram.id,
        diagram.ownerEmail,
        diagram.title,
        diagram.description,
        diagram.graphData,
        diagram.createdAt,
        diagram.updatedAt
      )
      .run();

    return diagram;
  }

  /**
   * Reads one diagram by id, including its owner.
   *
   * @param id Diagram id.
   * @returns The diagram, or `null` when no row has that id.
   * @throws {Error} When D1 rejects the statement.
   */
  async find(id: string): Promise<Diagram | null> {
    const row = await this.database
      .prepare(`SELECT ${DIAGRAM_COLUMNS} FROM diagrams WHERE id = ? LIMIT 1`)
      .bind(id)
      .first<DiagramRow>();

    return row === null ? null : toDiagram(row);
  }

  /**
   * Lists one owner's diagrams, most recently updated first.
   *
   * The `owner_email` filter is indexed (`migrations/0001_create_diagrams_and_users.sql`), so this
   * reads one identity's rows rather than scanning the shared table.
   *
   * @param ownerEmail Owner whose rows to select.
   * @returns That owner's diagrams, newest activity first.
   * @throws {Error} When D1 rejects the statement.
   */
  async listByOwner(ownerEmail: string): Promise<Diagram[]> {
    const { results } = await this.database
      .prepare(
        `SELECT ${DIAGRAM_COLUMNS} FROM diagrams WHERE owner_email = ? ORDER BY updated_at DESC`
      )
      .bind(ownerEmail)
      .all<DiagramRow>();

    return results.map(toDiagram);
  }

  /**
   * Replaces a diagram's title and/or description.
   *
   * `COALESCE` applies the "omitted leaves it unchanged" rule inside the statement, which keeps the
   * update to a single round trip. The description cannot use it — `null` there means "clear it",
   * which `COALESCE` would read as "leave it alone" — so the two fields are bound differently and a
   * sentinel marks whether the caller supplied one at all.
   *
   * @param id Diagram id.
   * @param input Validated fields to write.
   * @returns The updated diagram, or `null` when no row has that id.
   * @throws {Error} When D1 rejects the statement.
   */
  async updateMetadata(id: string, input: UpdateDiagramInput): Promise<Diagram | null> {
    const updatedAt = new Date().toISOString();
    const describes = Reflect.has(input, 'description');

    const row = await this.database
      .prepare(
        `UPDATE diagrams
            SET title = COALESCE(?2, title),
                description = CASE WHEN ?3 THEN ?4 ELSE description END,
                updated_at = ?5
          WHERE id = ?1
      RETURNING ${DIAGRAM_COLUMNS}`
      )
      .bind(id, input.title ?? null, describes ? 1 : 0, input.description ?? null, updatedAt)
      .first<DiagramRow>();

    return row === null ? null : toDiagram(row);
  }

  /**
   * Replaces a diagram's entire graph.
   *
   * @param id Diagram id.
   * @param graphData Canonical, already-validated graph JSON to store verbatim.
   * @returns The new `updatedAt` timestamp, or `null` when no row has that id.
   * @throws {Error} When D1 rejects the statement.
   */
  async replaceGraph(id: string, graphData: string): Promise<string | null> {
    const updatedAt = new Date().toISOString();
    const result = await this.database
      .prepare('UPDATE diagrams SET graph_data = ?, updated_at = ? WHERE id = ?')
      .bind(graphData, updatedAt, id)
      .run();

    return result.meta.changes > 0 ? updatedAt : null;
  }

  /**
   * Deletes a diagram.
   *
   * @param id Diagram id.
   * @returns `true` when a row was deleted, and `false` when none had that id.
   * @throws {Error} When D1 rejects the statement.
   */
  async remove(id: string): Promise<boolean> {
    const result = await this.database.prepare('DELETE FROM diagrams WHERE id = ?').bind(id).run();

    return result.meta.changes > 0;
  }
}
