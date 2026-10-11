/**
 * @file An in-memory {@link D1Port} over Node's built-in SQLite (specification §6: "unit tests use
 *   an in-memory fake port"). It applies the committed `migrations/data` stream, so the fake Data
 *   Worker runs the production repositories and SQL rather than a hand-written copy of them. A
 *   transaction mirrors D1's `batch()`: the queued write set runs inside `BEGIN`/`COMMIT` and rolls
 *   back as a unit, and failures pass through the production {@link translateD1Error}. Tests can
 *   make storage fail ({@link SqliteD1Port.failing}) or run a one-shot hook just before or after a
 *   write set commits, to simulate a concurrent writer winning a race.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type D1Port,
  type D1TransactionPort,
  sql,
  type SqlStatement,
  translateD1Error
} from '../../src/data-worker/infrastructure/d1/d1-port.ts';
import { serviceError } from '../../src/shared/common/errors.ts';

/**
 * Directory holding the committed schema migrations. Resolved from the working directory (Vitest
 * runs every project from the demo root) because under jsdom `import.meta.url` is not a `file:`
 * URL.
 */
const MIGRATIONS = path.resolve(process.cwd(), 'migrations/data') + path.sep;

/**
 * Names of the committed schema migrations, in order.
 */
export const MIGRATION_FILES: readonly string[] = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort();

/**
 * Create an in-memory database with foreign keys enforced (as D1 does) and every migration applied,
 * recorded in `d1_migrations` exactly as the migration helper records them.
 *
 * @returns The database.
 */
export function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(
    'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL)'
  );
  for (const name of MIGRATION_FILES) {
    db.exec(readFileSync(`${MIGRATIONS}${name}`, 'utf8'));
    db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, datetime('now'))").run(
      name
    );
  }
  return db;
}

/**
 * A hook run around a commit.
 */
export type CommitHook = (db: DatabaseSync) => void;

/**
 * {@link D1Port} over an in-memory SQLite database.
 */
export class SqliteD1Port implements D1Port {
  /**
   * When set, every call fails as D1 would during an outage.
   */
  failing = false;
  /**
   * One-shot hooks run before the next write set commits.
   */
  private readonly before: CommitHook[] = [];
  /**
   * One-shot hooks run after the next write set commits.
   */
  private readonly after: CommitHook[] = [];
  /**
   * One-shot fault: the 0-based statement index at which the next write set fails.
   */
  private failAt: number | null = null;
  /**
   * Number of statements in the most recent write set (committed or not).
   */
  lastWriteSetSize = 0;

  /**
   * @param db The database (defaults to a freshly migrated one).
   */
  constructor(readonly db: DatabaseSync = migratedDatabase()) {}

  /**
   * Run `hook` just before the next write set commits (for example, a concurrent writer).
   *
   * @param hook The hook.
   */
  beforeNextCommit(hook: CommitHook): void {
    this.before.push(hook);
  }

  /**
   * Run `hook` just after the next write set commits.
   *
   * @param hook The hook.
   */
  afterNextCommit(hook: CommitHook): void {
    this.after.push(hook);
  }

  /**
   * Make the next write set fail when it reaches statement `index`, as if D1 failed mid-batch. The
   * statements before it have already run inside the transaction, so this proves they roll back.
   *
   * @param index 0-based statement index.
   */
  failNextWriteAt(index: number): void {
    this.failAt = index;
  }

  /**
   * Fail when {@link failing} is set.
   *
   * @throws {Error} A `DEPENDENCY_FAILURE` service error.
   */
  private check(): void {
    if (this.failing) {
      throw serviceError('DEPENDENCY_FAILURE', 'The database is temporarily unavailable.');
    }
  }

  /**
   * @inheritdoc
   */
  read<T>(statement: SqlStatement): Promise<readonly T[]> {
    this.check();
    try {
      const rows = this.db.prepare(statement.sql).all(...statement.params);
      return Promise.resolve(rows.map((row) => ({ ...row }) as T));
    } catch (error) {
      throw translateD1Error(error);
    }
  }

  /**
   * @inheritdoc
   */
  async readOne<T>(statement: SqlStatement): Promise<T | null> {
    return (await this.read<T>(statement))[0] ?? null;
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
    if (queued.length === 0) {
      return result;
    }
    this.check();
    for (const hook of this.before.splice(0)) {
      hook(this.db);
    }
    this.lastWriteSetSize = queued.length;
    const failAt = this.failAt;
    this.failAt = null;
    this.db.exec('BEGIN');
    try {
      for (const [index, statement] of queued.entries()) {
        if (index === failAt) {
          throw new Error('D1_ERROR: injected storage failure');
        }
        this.db.prepare(statement.sql).run(...statement.params);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw translateD1Error(error);
    }
    for (const hook of this.after.splice(0)) {
      hook(this.db);
    }
    return result;
  }
}
