/**
 * @file A recording D1 test double for {@link D1ChannelRepository} unit tests. The repository's job
 *   is to emit the right SQL and interpret D1's result metadata correctly, so these tests assert on
 *   the statements it prepares and the parameters it binds. A double is used rather than the real
 *   Workers D1 binding because these are Node-environment unit tests; the Workers-runtime
 *   integration suite (`tests/integration/`) exercises the same repository against an actual
 *   migrated D1 database, so the SQL is proven valid there rather than assumed here.
 */

/**
 * One statement prepared through the fake, in the order the repository issued it.
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
 * Scripted results the fake returns, in the order the repository consumes them.
 */
export interface FakeD1Script {
  /**
   * Rows returned by the next `all()` call. Defaults to no rows.
   */
  allRows?: Record<string, unknown>[];
  /**
   * Row returned by each `first()` call, consumed in order. A `null` entry simulates a row that
   * does not exist, which is how "no such channel" paths are tested.
   */
  firstRows?: (Record<string, unknown> | null)[];
  /**
   * `meta.changes` returned by the next `run()` call. Defaults to `0`, which for this repository
   * means "the insert was ignored" or "there was nothing to delete".
   */
  changes?: number;
}

/**
 * A fake D1 database plus the statements the code under test issued against it.
 */
export interface FakeD1 {
  /**
   * The object to pass to {@link D1ChannelRepository}'s constructor.
   */
  database: Pick<D1Database, 'prepare'>;
  /**
   * Statements recorded so far, in issue order.
   */
  statements: RecordedStatement[];
}

/**
 * Build the D1 metadata block shared by `all()` and `run()` results.
 *
 * Only `changes` carries meaning for these tests — the repository reads it to detect a name
 * collision and a no-op delete — but the full shape is required to satisfy D1's result types
 * without casting.
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
 * Create a recording D1 double that returns scripted results.
 *
 * @param script Results the fake should return. Omitted fields fall back to "no rows" and zero
 *   changes, which is the correct simulation for an empty directory.
 * @returns The fake database and the array of statements it records, which the caller inspects
 *   after exercising the repository.
 */
export function createFakeD1(script: FakeD1Script = {}): FakeD1 {
  const statements: RecordedStatement[] = [];
  const firstRows = [...(script.firstRows ?? [])];
  let current: RecordedStatement | undefined;

  const prepared = {
    /**
     * Record the bound parameters against the most recently prepared statement.
     *
     * @param parameters Values bound to the statement's placeholders.
     * @returns The same prepared-statement fake, so calls can chain as they do in real D1.
     */
    bind(...parameters: unknown[]) {
      if (current !== undefined) {
        current.parameters = parameters;
      }
      return prepared;
    },

    /**
     * Return the scripted rows for a list query.
     *
     * @returns A successful D1 result carrying `script.allRows`.
     */
    async all() {
      return {
        meta: metaFor(0),
        results: script.allRows ?? [],
        success: true as const
      };
    },

    /**
     * Return the next scripted single row, or `null` once the script is exhausted.
     *
     * @returns The next scripted row, or `null`.
     */
    async first<T>() {
      return (firstRows.length > 0 ? firstRows.shift() : null) as T | null;
    },

    /**
     * Return a scripted write result.
     *
     * @returns A successful D1 result whose `meta.changes` is `script.changes`.
     */
    async run() {
      return {
        meta: metaFor(script.changes ?? 0),
        results: [],
        success: true as const
      };
    },

    /**
     * Unused by this repository; present so the double satisfies D1's prepared-statement shape.
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
       * Record a statement and hand back the shared prepared-statement fake.
       *
       * @param sql SQL text the repository prepared.
       * @returns The prepared-statement fake.
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
