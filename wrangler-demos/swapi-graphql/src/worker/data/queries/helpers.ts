/** Builds safe, static-shape SQL for batched D1 relationship loaders. */

/** D1 permits at most this many bound parameters in one statement. */
export const D1_MAX_BOUND_PARAMETERS = 100;

/**
 * Leaves room for the optional per-parent `first` parameter under D1's hard
 * bound-parameter limit.
 */
export const RELATION_LOADER_MAX_BATCH_SIZE = 90;

/**
 * Returns placeholders for a fixed number of already-validated batch keys.
 *
 * @param count - Number of parent ids in the batch.
 * @returns Comma-delimited SQL placeholders.
 * @throws RangeError When the caller would exceed D1's parameter limit.
 */
export function placeholders(count: number): string {
  if (count < 1 || count > D1_MAX_BOUND_PARAMETERS) {
    throw new RangeError(
      `D1 loader batch size must be between 1 and ${D1_MAX_BOUND_PARAMETERS}`,
    );
  }

  return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * Builds a parent-keyed relationship query with an optional per-parent cap.
 *
 * @param options - Entity, join, and ordering fragments controlled entirely by source code.
 * @param parentCount - Number of parent ids to bind.
 * @param first - Optional maximum number of children to return for each parent.
 * @returns SQL that returns `parent_id` plus the entity projection.
 */
export function relationQuery(
  options: {
    columns: string;
    entity: string;
    join: string;
    joinEntityColumn: string;
    joinParentColumn: string;
    orderBy: string;
  },
  parentCount: number,
  first?: number,
): string {
  const query = `SELECT ${options.join}.${options.joinParentColumn} AS parent_id, ${options.columns} FROM ${options.entity} INNER JOIN ${options.join} ON ${options.join}.${options.joinEntityColumn} = ${options.entity}.id WHERE ${options.join}.${options.joinParentColumn} IN (${placeholders(parentCount)})`;
  const orderedQuery = `${query} ORDER BY ${options.join}.${options.joinParentColumn}, ${options.orderBy}`;

  if (first === undefined) {
    return orderedQuery;
  }

  const outerColumns = options.columns.replaceAll(`${options.entity}.`, "");
  const outerOrderBy = options.orderBy.replaceAll(`${options.entity}.`, "");
  return `SELECT parent_id, ${outerColumns} FROM (SELECT ${options.join}.${options.joinParentColumn} AS parent_id, ${options.columns}, ROW_NUMBER() OVER (PARTITION BY ${options.join}.${options.joinParentColumn} ORDER BY ${options.orderBy}) AS row_number FROM ${options.entity} INNER JOIN ${options.join} ON ${options.join}.${options.joinEntityColumn} = ${options.entity}.id WHERE ${options.join}.${options.joinParentColumn} IN (${placeholders(parentCount)})) WHERE row_number <= ? ORDER BY parent_id, ${outerOrderBy}`;
}

/**
 * Builds a batched foreign-key query for a direct one-to-many relationship.
 *
 * @param options - Entity fragments controlled entirely by source code.
 * @param parentCount - Number of parent ids to bind.
 * @param first - Optional maximum number of children to return for each parent.
 * @returns SQL that returns `parent_id` plus the entity projection.
 */
export function foreignKeyQuery(
  options: {
    columns: string;
    entity: string;
    parentColumn: string;
    orderBy: string;
  },
  parentCount: number,
  first?: number,
): string {
  const query = `SELECT ${options.entity}.${options.parentColumn} AS parent_id, ${options.columns} FROM ${options.entity} WHERE ${options.entity}.${options.parentColumn} IN (${placeholders(parentCount)})`;
  const orderedQuery = `${query} ORDER BY ${options.entity}.${options.parentColumn}, ${options.orderBy}`;

  if (first === undefined) {
    return orderedQuery;
  }

  const outerColumns = options.columns.replaceAll(`${options.entity}.`, "");
  const outerOrderBy = options.orderBy.replaceAll(`${options.entity}.`, "");
  return `SELECT parent_id, ${outerColumns} FROM (SELECT ${options.entity}.${options.parentColumn} AS parent_id, ${options.columns}, ROW_NUMBER() OVER (PARTITION BY ${options.entity}.${options.parentColumn} ORDER BY ${options.orderBy}) AS row_number FROM ${options.entity} WHERE ${options.entity}.${options.parentColumn} IN (${placeholders(parentCount)})) WHERE row_number <= ? ORDER BY parent_id, ${outerOrderBy}`;
}
