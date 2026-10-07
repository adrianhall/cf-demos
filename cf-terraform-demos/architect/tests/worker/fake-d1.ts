/**
 * @file A recording D1 test double for the adapter unit tests in the Node-based project. The
 *   adapter's job is to emit correct SQL and bind values as parameters, so these tests assert on
 *   the statements it prepares rather than on rows coming back from a database. The SQL's
 *   _validity_ is proven elsewhere and deliberately so: the Workers-runtime suite runs the same
 *   adapter against a real migrated D1 database, so a syntactically invalid statement fails there
 *   instead of passing here against a double that never parses it.
 */

/**
 * One statement prepared through the double, in the order the adapter issued it.
 */
export interface RecordedStatement {
  /**
   * SQL text passed to `prepare()`.
   */
  sql: string;
  /**
   * Values passed to the subsequent `bind()`, or an empty array when `bind()` was not called.
   */
  parameters: unknown[];
}

/**
 * Results the double returns, consumed in the order the adapter asks for them.
 */
export interface FakeD1Script {
  /**
   * Rows returned by each `all()` call. Defaults to no rows.
   */
  allRows?: Record<string, unknown>[];
  /**
   * Rows returned by successive `first()` calls, consumed in order.
   *
   * Exhaustion yields `null` on purpose: a test that scripts no rows is describing a diagram that
   * does not exist, which is the case every ownership refusal rests on.
   */
  firstRows?: (Record<string, unknown> | null)[];
  /**
   * `meta.changes` returned by each `run()` call. Defaults to `0`, which simulates a write that
   * matched nothing.
   */
  changes?: number;
}

/**
 * A fake D1 database together with the statements issued against it.
 */
export interface FakeD1 {
  /**
   * The object to pass to an adapter's constructor.
   */
  database: Pick<D1Database, 'prepare'>;
  /**
   * Statements recorded so far, in issue order.
   */
  statements: RecordedStatement[];
}

/**
 * Builds the D1 metadata block shared by `all()` and `run()` results.
 *
 * Only `changes` carries meaning for these tests — the adapter reads it to decide whether a write
 * matched a row — but the complete shape is needed to satisfy D1's result types without a cast.
 *
 * @param changes Number of rows the simulated statement affected.
 * @returns A complete D1 `meta` object.
 */
function metaFor(changes: number): D1Meta {
  return {
    changed_db: changes > 0,
    changes,
    duration: 0,
    last_row_id: 0,
    rows_read: 0,
    rows_written: changes,
    size_after: 0
  };
}

/**
 * Creates a recording D1 double returning scripted results.
 *
 * @param script Results the double should return. Omitted fields fall back to "no rows" and zero
 *   changes, which is the right simulation for an identity that owns nothing.
 * @returns The double and the array of statements it records, which the caller inspects after
 *   exercising the adapter.
 */
export function createFakeD1(script: FakeD1Script = {}): FakeD1 {
  const statements: RecordedStatement[] = [];
  const firstRows = [...(script.firstRows ?? [])];
  let current: RecordedStatement | undefined;

  const prepared = {
    /**
     * Records the bound parameters against the most recently prepared statement.
     *
     * @param parameters Values bound to the statement's placeholders.
     * @returns The same prepared-statement double, so calls chain as they do in real D1.
     */
    bind(...parameters: unknown[]) {
      if (current !== undefined) {
        current.parameters = parameters;
      }
      return prepared;
    },

    /**
     * Returns the scripted rows for a list query.
     *
     * @returns A successful D1 result carrying `script.allRows`.
     */
    async all() {
      return { meta: metaFor(0), results: script.allRows ?? [], success: true as const };
    },

    /**
     * Returns the next scripted single row, or `null` once the script is exhausted.
     *
     * @returns The next scripted row, or `null`.
     */
    async first<T>() {
      return (firstRows.length > 0 ? firstRows.shift() : null) as T | null;
    },

    /**
     * Returns a scripted write result.
     *
     * @returns A successful D1 result whose `meta.changes` is `script.changes`.
     */
    async run() {
      return { meta: metaFor(script.changes ?? 0), results: [], success: true as const };
    },

    /**
     * Unused by these adapters; present so the double satisfies D1's prepared-statement shape.
     *
     * @returns An empty raw result.
     */
    async raw(): Promise<[string[]]> {
      return [[]];
    }
  };

  return {
    database: {
      /**
       * Records a statement and hands back the shared prepared-statement double.
       *
       * @param sql SQL text the adapter prepared.
       * @returns The prepared-statement double.
       */
      prepare(sql: string) {
        current = { parameters: [], sql };
        statements.push(current);
        return prepared as unknown as D1PreparedStatement;
      }
    },
    statements
  };
}
