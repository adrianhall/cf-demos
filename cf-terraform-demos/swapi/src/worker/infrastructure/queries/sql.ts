/**
 * @file SQL construction helpers for batched D1 relation queries.
 *
 *   ## Why this builds SQL text at all
 *
 *   A batched load needs one placeholder per identifier (`id IN (?, ?, ?)`), and the number of
 *   identifiers is only known at request time. The statement text therefore cannot be a fixed
 *   string. What _is_ fixed is everything that identifies a table or column: every such fragment
 *   passed to these helpers comes from a module-level constant in `./tables.ts` or from a caller in
 *   `./statements.ts`, never from request data. The only request-derived values are the bound
 *   parameters, which D1 keeps separate from the statement. No caller-supplied text ever reaches a
 *   statement, so there is no injection surface here — but because that property is a convention
 *   rather than something the type system can prove, every helper below documents it explicitly.
 */

/**
 * Maximum number of parameters D1 will bind to a single statement.
 */
export const D1_MAX_BOUND_PARAMETERS = 100;

/**
 * Largest batch of parent identifiers a relation loader may request at once.
 *
 * Ten below D1's hard limit, which leaves room for the optional `first` parameter a limited
 * relation query appends after the identifiers. DataLoader splits anything larger into several
 * batches automatically, so this caps the size of one statement rather than the size of a query.
 */
export const RELATION_BATCH_SIZE = 90;

/**
 * Build the placeholder list for a fixed number of bound parameters.
 *
 * @param count Number of parameters to generate placeholders for.
 * @returns Comma-separated `?` placeholders, ready to interpolate into an `IN (...)` clause.
 * @throws {RangeError} When `count` is below 1 or above {@link D1_MAX_BOUND_PARAMETERS}. Failing
 *   here is much better than letting D1 reject the statement at execution time: the error names the
 *   real constraint, and an empty batch indicates a caller bug (a loader should never be asked for
 *   zero keys) rather than a query that should return nothing.
 */
export function placeholders(count: number): string {
  if (count < 1 || count > D1_MAX_BOUND_PARAMETERS) {
    throw new RangeError(
      `A D1 batch must bind between 1 and ${D1_MAX_BOUND_PARAMETERS} parameters; received ${count}.`
    );
  }

  return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * Column and ordering fragments describing one side of a relation. Every field is source-controlled
 * text, never request data.
 */
interface RelationShape {
  /**
   * Fully qualified column projection for the child entity, for example `film.id, film.title`.
   */
  columns: string;
  /**
   * Child entity's table name.
   */
  entity: string;
  /**
   * `ORDER BY` fragment applied within each parent's group, qualified by the entity table.
   */
  orderBy: string;
}

/**
 * Wrap a relation query so that each parent's children are independently limited.
 *
 * `LIMIT` cannot express this: it truncates the whole result set, so `LIMIT 5` over ten parents
 * would return five rows in total, very likely all belonging to the first parent. `ROW_NUMBER()`
 * partitioned by the parent key numbers each parent's children separately, and filtering on that
 * number yields "the first five children _of each_ parent" in one statement.
 *
 * The outer query re-projects the columns unqualified because the inner query is a derived table:
 * `film.title` is only addressable where the `film` table is in scope, and outside the subquery the
 * column is simply `title`.
 *
 * @param inner Complete inner query, already selecting `parent_id`, the child columns, and a
 *   `row_number` column.
 * @param shape Column and ordering fragments used to derive the outer projection and sort.
 * @returns A statement returning at most `?` children per parent, with the limit bound last.
 */
function limitPerParent(inner: string, shape: RelationShape): string {
  const outerColumns = shape.columns.replaceAll(`${shape.entity}.`, '');
  const outerOrderBy = shape.orderBy.replaceAll(`${shape.entity}.`, '');
  return (
    `SELECT parent_id, ${outerColumns} FROM (${inner}) WHERE row_number <= ? `
    + `ORDER BY parent_id, ${outerOrderBy}`
  );
}

/**
 * Fragments describing a many-to-many relation resolved through a join table.
 */
export interface JoinRelationShape extends RelationShape {
  /**
   * Join table connecting parent and child, for example `film_person`.
   */
  join: string;
  /**
   * Join-table column referencing the child entity, for example `person_id`.
   */
  joinEntityColumn: string;
  /**
   * Join-table column referencing the parent entity, for example `film_id`.
   */
  joinParentColumn: string;
}

/**
 * Build a batched query for a many-to-many relation, such as a film's characters.
 *
 * The parent key is projected as `parent_id` so the loader can regroup the flat result into
 * per-parent lists — see `Related` in `../../domain/related.ts` for why that tag is necessary.
 *
 * @param shape Source-controlled table, column, join, and ordering fragments.
 * @param parentCount Number of parent identifiers that will be bound.
 * @param limit Optional per-parent child limit; when present, one further parameter is bound after
 *   the identifiers.
 * @returns SQL selecting `parent_id` plus the child projection, ordered by parent and then by the
 *   requested sort.
 * @throws {RangeError} When `parentCount` exceeds what D1 can bind.
 */
export function joinRelationQuery(
  shape: JoinRelationShape,
  parentCount: number,
  limit?: number
): string {
  const from =
    `FROM ${shape.entity} INNER JOIN ${shape.join} `
    + `ON ${shape.join}.${shape.joinEntityColumn} = ${shape.entity}.id `
    + `WHERE ${shape.join}.${shape.joinParentColumn} IN (${placeholders(parentCount)})`;
  const parentKey = `${shape.join}.${shape.joinParentColumn}`;

  if (limit === undefined) {
    return (
      `SELECT ${parentKey} AS parent_id, ${shape.columns} ${from} `
      + `ORDER BY ${parentKey}, ${shape.orderBy}`
    );
  }

  return limitPerParent(
    `SELECT ${parentKey} AS parent_id, ${shape.columns}, `
      + `ROW_NUMBER() OVER (PARTITION BY ${parentKey} ORDER BY ${shape.orderBy}) AS row_number `
      + from,
    shape
  );
}

/**
 * Fragments describing a one-to-many relation resolved by a foreign key on the child row.
 */
export interface ForeignKeyRelationShape extends RelationShape {
  /**
   * Column on the child entity holding the parent's identifier, for example `homeworld_id`.
   */
  parentColumn: string;
}

/**
 * Build a batched query for a one-to-many relation, such as a planet's residents.
 *
 * No join table is involved: the parent identifier is already a column on the child row, so it is
 * projected directly as `parent_id`.
 *
 * @param shape Source-controlled table, column, foreign-key, and ordering fragments.
 * @param parentCount Number of parent identifiers that will be bound.
 * @param limit Optional per-parent child limit; when present, one further parameter is bound after
 *   the identifiers.
 * @returns SQL selecting `parent_id` plus the child projection, ordered by parent and then by the
 *   requested sort.
 * @throws {RangeError} When `parentCount` exceeds what D1 can bind.
 */
export function foreignKeyRelationQuery(
  shape: ForeignKeyRelationShape,
  parentCount: number,
  limit?: number
): string {
  const parentKey = `${shape.entity}.${shape.parentColumn}`;
  const from = `FROM ${shape.entity} WHERE ${parentKey} IN (${placeholders(parentCount)})`;

  if (limit === undefined) {
    return (
      `SELECT ${parentKey} AS parent_id, ${shape.columns} ${from} `
      + `ORDER BY ${parentKey}, ${shape.orderBy}`
    );
  }

  return limitPerParent(
    `SELECT ${parentKey} AS parent_id, ${shape.columns}, `
      + `ROW_NUMBER() OVER (PARTITION BY ${parentKey} ORDER BY ${shape.orderBy}) AS row_number `
      + from,
    shape
  );
}
