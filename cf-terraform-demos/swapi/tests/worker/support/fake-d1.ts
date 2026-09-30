/**
 * @file A recording D1 test double for the repository unit tests. The repositories' job is to pick
 *   the right statement and bind the right parameters, so these tests assert on exactly that: the
 *   SQL text issued and the values bound. A double is used rather than a real D1 binding because
 *   these are Node-environment unit tests. Whether the SQL is _valid_ is proven separately, in
 *   `tests/integration/`, which runs the same repositories against a real migrated D1 database
 *   inside the Workers runtime — so nothing here has to assume it.
 */

/**
 * One statement prepared through the fake, in the order it was issued.
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
 * A fake D1 database plus the statements the code under test issued against it.
 */
export interface FakeD1 {
  /**
   * The object to pass to a repository's constructor.
   */
  database: Pick<D1Database, 'prepare'>;
  /**
   * Statements recorded so far, in issue order.
   */
  statements: RecordedStatement[];
}

/**
 * Create a recording D1 double that returns scripted rows.
 *
 * Every `all()` call returns the same scripted rows. That is sufficient because each test exercises
 * one repository method, and it keeps the double small enough to be obviously correct.
 *
 * @param rows Rows every `all()` call should return. Defaults to none, which is the right
 *   simulation for a query matching nothing.
 * @returns The fake database and the array it records statements into, which the caller inspects
 *   after exercising a repository.
 */
export function createFakeD1(rows: Record<string, unknown>[] = []): FakeD1 {
  const statements: RecordedStatement[] = [];
  let current: RecordedStatement | undefined;

  const prepared = {
    /**
     * Record the bound parameters against the most recently prepared statement.
     *
     * @param parameters Values bound to the statement's placeholders.
     * @returns The same prepared-statement fake, so calls chain as they do in real D1.
     */
    bind(...parameters: unknown[]) {
      if (current !== undefined) {
        current.parameters = parameters;
      }
      return prepared;
    },

    /**
     * Return the scripted rows.
     *
     * @returns A successful D1 result carrying the scripted rows.
     */
    async all() {
      return {
        meta: {
          changed_db: false,
          changes: 0,
          duration: 0,
          last_row_id: 0,
          rows_read: rows.length,
          rows_written: 0,
          size_after: 0
        },
        results: rows,
        success: true as const
      };
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
