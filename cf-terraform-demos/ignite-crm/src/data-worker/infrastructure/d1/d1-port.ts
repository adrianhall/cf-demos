/**
 * @file The narrow D1 port (specification §6) and its adapter over a real `D1Database`.
 *
 *   ## Transactions on D1
 *
 *   D1 has no interactive transactions. The atomic primitive is `batch()`: every statement in the
 *   batch commits or none does, but a statement cannot branch on an earlier one's result. The port
 *   therefore models a transaction honestly as **read, then commit one atomic write set**:
 *
 *   1. `work(tx)` may read (`tx.read`/`tx.readOne`) to validate input and build rows. Those reads are
 *      not isolated from concurrent writers, so they are for _early, friendly_ failures only.
 *   2. `work(tx)` queues writes (`tx.write`) and **guards** (`tx.requireChanged`, `tx.requireRow`). A
 *      guard is an `INSERT` into the `tx_guard` view whose trigger raises when its precondition is
 *      false, aborting and rolling back the entire batch.
 *   3. When `work` returns, the queued statements run as one `batch()`. Every invariant that must hold
 *      _at commit time_ — "the version is still 3", "the company still exists" — is expressed as a
 *      guard, so it is checked inside the same atomic unit that writes. That is the D1 equivalent
 *      of compare-and-swap inside a transaction.
 */

import { serviceError, type ServiceErrorCode } from '../../../shared/common/errors.ts';

/**
 * A bound SQL value.
 */
export type SqlValue = string | number | null;

/**
 * One parameter-bound SQL statement. SQL text is always a constant in infrastructure code; every
 * variable part is a bound parameter.
 */
export interface SqlStatement {
  /**
   * SQL text with `?` placeholders.
   */
  readonly sql: string;
  /**
   * Values bound to the placeholders, in order.
   */
  readonly params: readonly SqlValue[];
}

/**
 * Build a statement.
 *
 * @param text SQL text with `?` placeholders.
 * @param params Bound values.
 * @returns The statement.
 */
export function sql(text: string, ...params: SqlValue[]): SqlStatement {
  return { sql: text, params };
}

/**
 * Reasons a guard can fail, each surfacing as the service error code of the same name.
 */
export type GuardReason = Extract<ServiceErrorCode, 'CONFLICT' | 'VERSION_MISMATCH' | 'NOT_FOUND'>;

/**
 * Read access shared by the port and an open transaction.
 */
export interface D1Reader {
  /**
   * Run a query and return every row.
   *
   * @param statement The query.
   * @returns The rows.
   * @throws {Error} A `DEPENDENCY_FAILURE` service error when D1 fails.
   */
  read<T>(statement: SqlStatement): Promise<readonly T[]>;
  /**
   * Run a query and return the first row.
   *
   * @param statement The query.
   * @returns The first row, or `null`.
   * @throws {Error} A `DEPENDENCY_FAILURE` service error when D1 fails.
   */
  readOne<T>(statement: SqlStatement): Promise<T | null>;
}

/**
 * An open transaction: reads plus a queued, atomic write set.
 */
export interface D1TransactionPort extends D1Reader {
  /**
   * Queue a write.
   *
   * @param statement The write.
   */
  write(statement: SqlStatement): void;
  /**
   * Queue a guard requiring that the immediately preceding queued write changed at least one row.
   *
   * @param reason Error code reported if it did not.
   */
  requireChanged(reason: GuardReason): void;
  /**
   * Queue a guard requiring that a count query returns at least 1 at commit time.
   *
   * @param countQuery A query whose single column is a count.
   * @param reason Error code reported if the count is 0.
   */
  requireRow(countQuery: SqlStatement, reason: GuardReason): void;
}

/**
 * The D1 port repositories depend on.
 */
export interface D1Port extends D1Reader {
  /**
   * Run `work`, then commit its queued writes atomically.
   *
   * @param work Builds the write set; may read first.
   * @returns What `work` returned, once the write set has committed.
   * @throws {Error} A service error with the guard's code when a guard fails, `CONFLICT` when a
   *   uniqueness constraint fails, or `DEPENDENCY_FAILURE` when D1 itself fails. Nothing is written
   *   in any of those cases.
   */
  transaction<T>(work: (tx: D1TransactionPort) => Promise<T>): Promise<T>;
}

/**
 * Prefix of the message raised by the `tx_guard` triggers.
 */
const GUARD_MARKER = 'IGNITE_TX_GUARD:';

/**
 * Every reason a guard can carry.
 */
const GUARD_REASONS: ReadonlySet<string> = new Set<GuardReason>([
  'CONFLICT',
  'VERSION_MISMATCH',
  'NOT_FOUND'
]);

/**
 * Whether parsed text is a known guard reason.
 *
 * @param value Text parsed from a D1 error message.
 * @returns `true` when it is one of {@link GUARD_REASONS}.
 */
function isGuardReason(value: string | undefined): value is GuardReason {
  return value !== undefined && GUARD_REASONS.has(value);
}

/**
 * Translate a D1 failure into a service error.
 *
 * Exported so the Workers-runtime suite can prove each translation against real D1 messages.
 *
 * @param error The error D1 raised.
 * @returns The equivalent service error.
 */
export function translateD1Error(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const guard = message.indexOf(GUARD_MARKER);
  if (guard !== -1) {
    const reason = message.slice(guard + GUARD_MARKER.length).split(/[^A-Z_]/u)[0];
    // Only reasons this port itself queues are trusted; anything else (a truncated or altered
    // message) fails closed as a retryable dependency failure rather than an arbitrary code.
    if (isGuardReason(reason)) {
      return serviceError(reason, guardMessage(reason));
    }
    return serviceError('DEPENDENCY_FAILURE', 'The database is temporarily unavailable.');
  }
  if (message.includes('UNIQUE constraint failed')) {
    return serviceError('CONFLICT', 'A record with the same unique value already exists.');
  }
  return serviceError('DEPENDENCY_FAILURE', 'The database is temporarily unavailable.');
}

/**
 * Safe message for a failed guard.
 *
 * @param reason The guard reason.
 * @returns A message suitable for a caller.
 */
function guardMessage(reason: GuardReason): string {
  const messages: Record<GuardReason, string> = {
    VERSION_MISMATCH: 'The record was changed by someone else. Reload it and try again.',
    NOT_FOUND: 'A record this change depends on no longer exists.',
    CONFLICT: 'The change conflicts with the current state of the record.'
  };
  return messages[reason];
}

/**
 * {@link D1Port} over a real D1 binding.
 */
export class D1Adapter implements D1Port {
  /**
   * @param db The D1 binding.
   */
  constructor(private readonly db: D1Database) {}

  /**
   * Prepare and bind a statement.
   *
   * @param statement The statement.
   * @returns The prepared statement.
   */
  private prepare(statement: SqlStatement): D1PreparedStatement {
    return this.db.prepare(statement.sql).bind(...statement.params);
  }

  /**
   * @inheritdoc
   */
  async read<T>(statement: SqlStatement): Promise<readonly T[]> {
    try {
      const result = await this.prepare(statement).all<T>();
      return result.results;
    } catch (error) {
      throw translateD1Error(error);
    }
  }

  /**
   * @inheritdoc
   */
  async readOne<T>(statement: SqlStatement): Promise<T | null> {
    try {
      return await this.prepare(statement).first<T>();
    } catch (error) {
      throw translateD1Error(error);
    }
  }

  /**
   * @inheritdoc
   */
  async transaction<T>(work: (tx: D1TransactionPort) => Promise<T>): Promise<T> {
    const queued: SqlStatement[] = [];
    const tx: D1TransactionPort = {
      read: (statement) => this.read(statement),
      readOne: (statement) => this.readOne(statement),
      write: (statement) => {
        queued.push(statement);
      },
      requireChanged: (reason) => {
        queued.push(sql('INSERT INTO tx_guard (changed, reason) VALUES (changes(), ?)', reason));
      },
      requireRow: (countQuery, reason) => {
        queued.push(
          sql(
            `INSERT INTO tx_guard (changed, reason) SELECT (${countQuery.sql}), ?`,
            ...countQuery.params,
            reason
          )
        );
      }
    };
    const result = await work(tx);
    if (queued.length > 0) {
      try {
        await this.db.batch(queued.map((statement) => this.prepare(statement)));
      } catch (error) {
        throw translateD1Error(error);
      }
    }
    return result;
  }
}
