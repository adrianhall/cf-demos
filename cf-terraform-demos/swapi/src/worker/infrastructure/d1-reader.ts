import type { Related } from '../domain/related';

/**
 * The subset of `D1Database` this tier uses.
 *
 * Narrowed to `prepare` so a unit test can supply a small fake instead of constructing a whole
 * `D1Database`, and so it is obvious from the type alone that this application only ever reads:
 * there is no `batch` and no `exec` here, which are the entry points a write would need. When the
 * planned data editor adds mutations, widening this type will be a visible, reviewable change
 * rather than an invisible one.
 */
export type D1Reader = Pick<D1Database, 'prepare'>;

/**
 * A relation query's row: the child entity's columns plus the projected parent key.
 *
 * @typeParam Row Child entity's row shape.
 */
type RelatedRow<Row> = Row & {
  /**
   * Parent identifier projected by the relation query, always aliased to `parent_id`.
   */
  parent_id: string;
};

/**
 * Run a batched entity query and map its rows to domain entities.
 *
 * @typeParam Row Row shape the statement returns.
 * @typeParam Entity Domain entity the rows map to.
 * @param database D1 database to read from.
 * @param sql Source-controlled statement text from `./queries/statements.ts`.
 * @param ids Identifiers to bind, in the order the statement's placeholders expect.
 * @param map Row-to-entity mapper from `./queries/tables.ts`.
 * @returns The mapped entities. Identifiers with no matching row are simply absent, which is what
 *   lets one dangling reference in a batch resolve to a null GraphQL field without failing the
 *   other entities that shared the statement.
 * @throws {Error} When D1 rejects the statement, for example because the schema is missing. The
 *   error propagates unchanged: GraphQL Yoga converts it into an `errors` entry, and the deployed
 *   Worker masks its message (see `src/worker/routes/graphql.ts`).
 */
// `Row` appears once in the signature, but removing it would cost a type assertion rather than save
// one. D1's `all()` is generic over the row shape, and `Row` is what connects the mapper's parameter
// type to that call: `all<Row>()` types the result set, so `results.map(map)` is checked. Untyped,
// `all()` yields `Record<string, unknown>` rows and the mapper could only be applied through a cast
// — which this repository's conventions treat as a design smell. The parameter is inferred from
// `map`, so no caller ever supplies it explicitly.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
export async function queryEntities<Row, Entity>(
  database: D1Reader,
  sql: string,
  ids: readonly string[],
  map: (row: Row) => Entity
): Promise<Entity[]> {
  const result = await database
    .prepare(sql)
    .bind(...ids)
    .all<Row>();
  return result.results.map(map);
}

/**
 * Run a batched relation query and preserve each row's parent key.
 *
 * The optional limit is bound _after_ the parent identifiers because that is the order the
 * statement builders emit placeholders in: the `IN (...)` clause comes first, and the `row_number
 * <= ?` comparison that implements the per-parent limit is appended last.
 *
 * @typeParam Row Child entity's row shape.
 * @typeParam Entity Child domain entity.
 * @param database D1 database to read from.
 * @param sql Source-controlled relation statement text.
 * @param parentIds Parent identifiers to bind.
 * @param limit Optional validated per-parent limit, bound last when present.
 * @param map Row-to-entity mapper for the child entity.
 * @returns Child entities, each tagged with the parent it belongs to so the caller can regroup a
 *   flat result set into per-parent lists.
 * @throws {Error} When D1 rejects the statement.
 */
// Same reasoning as `queryEntities` above, and with an extra job here: `all<RelatedRow<Row>>()` is
// what types `row.parent_id` as a string, so the parent key this function reads is checked rather
// than assumed.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
export async function queryRelated<Row, Entity>(
  database: D1Reader,
  sql: string,
  parentIds: readonly string[],
  limit: number | undefined,
  map: (row: Row) => Entity
): Promise<Related<Entity>[]> {
  const result = await database
    .prepare(sql)
    .bind(...parentIds, ...(limit === undefined ? [] : [limit]))
    .all<RelatedRow<Row>>();

  return result.results.map((row) => ({ ...map(row), parentId: row.parent_id }));
}
