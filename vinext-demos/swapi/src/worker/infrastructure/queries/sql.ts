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
 *   That convention is load-bearing for search in particular. {@link searchCondition} emits only
 *   `?` placeholders for the term, and {@link searchPattern} produces the value to bind to them, so
 *   a user-supplied search term is never part of the statement text — it stays a parameter, and the
 *   wildcard escaping it receives is about matching the right rows, not about safety.
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
 * Character used to escape `LIKE` wildcards in a search pattern.
 *
 * A backslash is conventional, and SQLite has no default escape character — one only exists when a
 * statement says `ESCAPE '\'`, which {@link searchCondition} always emits alongside a pattern built
 * by {@link searchPattern}. The two must be used together; neither is correct alone.
 */
const LIKE_ESCAPE_CHARACTER = '\\';

/**
 * Turn a validated search term into a bound `LIKE` pattern matching it as a substring.
 *
 * The wildcards `%` and `_` are metacharacters in `LIKE`, and a search term is by definition text a
 * user typed, so it can contain both. Left alone they would silently change the query's meaning:
 * searching for `100%` would match every row beginning `100`, and `a_b` would match `axb`. That is
 * a correctness bug rather than a security one — the term is always a _bound parameter_, never
 * interpolated into the statement, so no input can alter the statement's structure — but it is the
 * kind of bug a user experiences as "search is broken" and cannot work around.
 *
 * The escape character itself is escaped first. Doing it in any other order would double-escape the
 * backslashes introduced for `%` and `_`, turning a search for `%` into a search for `\%`.
 *
 * @param term Validated, trimmed search term from `validateSearchTerm` in
 *   `../../domain/search-term.ts`.
 * @returns A pattern of the form `%term%` with wildcards neutralised, to be bound as a parameter
 *   against a condition built by {@link searchCondition}.
 */
export function searchPattern(term: string): string {
  const escaped = term
    .replaceAll(LIKE_ESCAPE_CHARACTER, `${LIKE_ESCAPE_CHARACTER}${LIKE_ESCAPE_CHARACTER}`)
    .replaceAll('%', `${LIKE_ESCAPE_CHARACTER}%`)
    .replaceAll('_', `${LIKE_ESCAPE_CHARACTER}_`);

  return `%${escaped}%`;
}

/**
 * Build the `LIKE` condition matching a search pattern against one or more columns.
 *
 * Every column contributes one `?`, so a caller binds the same pattern once per column named here.
 * Grouping them in parentheses matters: the condition is composed into a larger `WHERE` clause with
 * `AND` in the relation queries, and without the parentheses `OR` would bind more loosely than the
 * surrounding `AND` and quietly widen the result set.
 *
 * ## Case sensitivity is ASCII-only
 *
 * SQLite's `LIKE` is case-insensitive by default, which is what makes `walker` find `Luke
 * Skywalker` without any `LOWER()` calls — but only for ASCII. `Á` and `á` are distinct to this
 * operator. Every searchable name in this dataset is ASCII, so the limitation is invisible here; it
 * is recorded because it would not stay invisible in a dataset with accented names, and the fix at
 * that point is a normalised search column rather than a bigger `LIKE`.
 *
 * ## No index supports this
 *
 * A leading-wildcard pattern cannot use a B-tree index: the index is ordered by prefix, and `%foo%`
 * has no known prefix to seek to. Every search here is therefore a full scan of the table. That is
 * a deliberate acceptance rather than an oversight — the largest table holds 82 rows, so a scan is
 * measured in microseconds, and the alternatives (an FTS5 virtual table, or a trigram index) would
 * add a second copy of the data to keep in sync and a second thing for a reader of this demo to
 * understand. The decision would flip somewhere in the tens of thousands of rows; at that point
 * FTS5 is the answer, not a cleverer `LIKE`.
 *
 * @param columns Qualified column names to match against, for example `person.name`. Every entry is
 * source-controlled text from `./tables.ts` or `./statements.ts`, never request data. @returns A
 * parenthesised condition such as `(person.name LIKE ? ESCAPE '\')`. @throws {RangeError} When no
 * columns are supplied, which would otherwise produce an empty condition that silently matches
 * every row — the exact opposite of filtering.
 */
export function searchCondition(columns: readonly string[]): string {
  if (columns.length === 0) {
    throw new RangeError('A search condition needs at least one column to match against.');
  }

  const comparisons = columns
    .map((column) => `${column} LIKE ? ESCAPE '${LIKE_ESCAPE_CHARACTER}'`)
    .join(' OR ');

  return `(${comparisons})`;
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
