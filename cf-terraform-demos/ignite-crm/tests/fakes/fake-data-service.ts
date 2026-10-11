/**
 * @file In-memory fake of the Data Worker for Application Worker, client, and use-case tests. It is
 *   the **production** composition — real application services _and_ real D1 repositories — over an
 *   in-memory SQLite {@link SqliteD1Port} that applies the committed migrations. Only the database
 *   engine is substituted, so authorization, validation, idempotency, versioning, SQL, and guard
 *   behaviour are the production behaviour by construction. It passes the same contract suite
 *   (`tests/contract/data-service-contract.ts`) as the real `DataEntrypoint` over D1.
 */

import type { Runtime } from '../../src/data-worker/application/shared/runtime.ts';
import { composeWithPort } from '../../src/data-worker/composition.ts';
import type { DataService } from '../../src/shared/data-service/contract.ts';
import type { Role } from '../../src/shared/permissions.ts';
import { type CommitHook, SqliteD1Port } from './sqlite-d1-port.ts';

/**
 * A stored audit event, as tests inspect it.
 */
export interface StoredAudit {
  /**
   * Entity type.
   */
  readonly entityType: string;
  /**
   * Entity id.
   */
  readonly entityId: string;
  /**
   * Action.
   */
  readonly action: string;
  /**
   * Acting user.
   */
  readonly actorId: string;
}

/**
 * Test access to the fake's database: seeding, inspection, and fault injection.
 */
export class FakeStore {
  /**
   * @param port The SQLite port the service runs on.
   */
  constructor(readonly port: SqliteD1Port) {}

  /**
   * When set, every storage call fails as D1 would during an outage.
   *
   * @returns Whether storage is failing.
   */
  get failing(): boolean {
    return this.port.failing;
  }

  /**
   * Turn the simulated outage on or off.
   *
   * @param value Whether storage fails.
   */
  set failing(value: boolean) {
    this.port.failing = value;
  }

  /**
   * Add a user with one role.
   *
   * @param email E-mail.
   * @param role Role.
   * @param status Status.
   * @returns The user id.
   */
  addUser(email: string, role: Role, status: 'active' | 'suspended' = 'active'): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.port.db
      .prepare(
        `INSERT INTO users (id, email, display_name, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`
      )
      .run(id, email, email.split('@')[0] ?? email, status, now, now);
    this.port.db
      .prepare('INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)')
      .run(id, role, now);
    return id;
  }

  /**
   * A user's id by e-mail.
   *
   * @param email E-mail.
   * @returns The id.
   * @throws {Error} When no such user exists.
   */
  userId(email: string): string {
    const row = this.port.db.prepare('SELECT id FROM users WHERE email = ?').get(email) as
      | { id: string }
      | undefined;
    if (row === undefined) {
      throw new Error(`No user ${email}`);
    }
    return row.id;
  }

  /**
   * Replace a user's roles (simulates an owner changing them mid-session).
   *
   * @param userId User id.
   * @param roles New roles.
   */
  setRoles(userId: string, roles: readonly Role[]): void {
    this.port.db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId);
    for (const role of roles) {
      this.port.db
        .prepare('INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)')
        .run(userId, role, new Date().toISOString());
    }
  }

  /**
   * Count rows in a table, optionally filtered.
   *
   * @param table Table name (test-controlled constant).
   * @param where Optional SQL predicate (test-controlled constant).
   * @param params Bound values for the predicate.
   * @returns The count.
   */
  count(table: string, where = '1 = 1', ...params: (string | number | null)[]): number {
    return (
      this.port.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...params) as {
        n: number;
      }
    ).n;
  }

  /**
   * Run a statement directly (seeding or simulating a concurrent writer).
   *
   * @param text SQL text.
   * @param params Bound values.
   */
  exec(text: string, ...params: (string | number | null)[]): void {
    this.port.db.prepare(text).run(...params);
  }

  /**
   * Every audit event, oldest first.
   *
   * @returns The events.
   */
  get audit(): StoredAudit[] {
    return (
      this.port.db
        .prepare(
          `SELECT entity_type, entity_id, action, actor_id FROM audit_events
            ORDER BY occurred_at, rowid`
        )
        .all() as {
        entity_type: string;
        entity_id: string;
        action: string;
        actor_id: string;
      }[]
    ).map((row) => ({
      entityType: row.entity_type,
      entityId: row.entity_id,
      action: row.action,
      actorId: row.actor_id
    }));
  }

  /**
   * Run `hook` just before the next write set commits — the moment a concurrent writer would slip
   * in between this request's reads and its commit.
   *
   * @param hook The hook.
   */
  beforeNextCommit(hook: CommitHook): void {
    this.port.beforeNextCommit(hook);
  }

  /**
   * Make the next write set fail at statement `index` (see {@link SqliteD1Port.failNextWriteAt}).
   *
   * @param index 0-based statement index.
   */
  failNextWriteAt(index: number): void {
    this.port.failNextWriteAt(index);
  }

  /**
   * Statements in the most recent write set.
   *
   * @returns The count.
   */
  get lastWriteSetSize(): number {
    return this.port.lastWriteSetSize;
  }

  /**
   * Run `hook` just after the next write set commits.
   *
   * @param hook The hook.
   */
  afterNextCommit(hook: CommitHook): void {
    this.port.afterNextCommit(hook);
  }
}

/**
 * A deterministic runtime for tests.
 *
 * @param start Initial instant.
 * @returns A runtime whose clock advances 1 ms per read, plus a setter.
 */
export function testRuntime(
  start = new Date('2026-10-01T09:00:00.000Z')
): Runtime & { set(date: Date): void } {
  let now = start.getTime();
  return {
    now: () => new Date(now++),
    newId: () => crypto.randomUUID(),
    set: (date) => {
      now = date.getTime();
    }
  };
}

/**
 * Build a fake Data Worker.
 *
 * @param options Bootstrap owner e-mail and runtime.
 * @returns The service and its store.
 */
export function createFakeDataService(options: { adminEmail?: string; runtime?: Runtime } = {}): {
  service: DataService;
  store: FakeStore;
} {
  const port = new SqliteD1Port();
  return {
    store: new FakeStore(port),
    service: composeWithPort(
      port,
      options.adminEmail ?? 'owner@example.com',
      options.runtime ?? testRuntime()
    )
  };
}
