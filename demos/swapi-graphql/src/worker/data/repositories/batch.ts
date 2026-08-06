/** Shared D1 execution helpers for request-scoped Pothos DataLoaders. */
import type { AppBindings } from "../../bindings";

/** An entity row associated with the parent that requested it. */
export type Related<T> = T & { parentId: string };

/**
 * Returns the parent grouping key projected by a relationship query.
 *
 * @param entity - Entity returned from a relationship loader.
 * @returns The parent id used by Pothos to rebuild each child list.
 * @throws Error When a relationship query fails to project its parent key.
 */
export function relatedParentId(entity: unknown): string {
  if (
    typeof entity !== "object" ||
    entity === null ||
    !("parentId" in entity) ||
    typeof entity.parentId !== "string"
  ) {
    throw new Error("Relationship query did not return parent_id");
  }

  return entity.parentId;
}

/**
 * Executes an entity batch query and maps its explicit result projection.
 *
 * @param env - Worker bindings for this request.
 * @param sql - Source-controlled SQL text.
 * @param ids - Parent or entity ids used as D1 parameters.
 * @param map - Maps a checked D1 result shape to its domain representation.
 * @returns Mapped entities.
 */
export async function loadBatch<Row, Entity>(
  env: AppBindings,
  sql: string,
  ids: readonly string[],
  map: (row: Row) => Entity,
): Promise<Entity[]> {
  const result = await env.DB.prepare(sql)
    .bind(...ids)
    .all<Row>();
  return result.results.map(map);
}

/**
 * Executes a parent-keyed relationship batch query and preserves its grouping key.
 *
 * @param env - Worker bindings for this request.
 * @param sql - Source-controlled SQL text.
 * @param ids - Parent ids used as D1 parameters.
 * @param first - Optional per-parent limit appended after parent ids.
 * @param map - Maps a checked D1 result shape to its domain representation.
 * @returns Related domain entities carrying their parent id for Pothos grouping.
 */
export async function loadRelatedBatch<Row, Entity>(
  env: AppBindings,
  sql: string,
  ids: readonly string[],
  first: number | undefined,
  map: (row: Row) => Entity,
): Promise<Related<Entity>[]> {
  const statement = env.DB.prepare(sql).bind(
    ...ids,
    ...(first === undefined ? [] : [first]),
  );
  const result = await statement.all<Row & { parent_id: string }>();
  return result.results.map((row) => ({
    ...map(row),
    parentId: row.parent_id,
  }));
}
