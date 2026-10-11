/**
 * @file Data Worker composition root: the one place concrete adapters meet use cases. One
 *   composition is built per RPC invocation. Nothing is cached at module scope, so no state can
 *   leak between requests in a reused isolate.
 */

import { serviceError } from '../shared/common/errors.ts';
import type { DataHealth, DataService } from '../shared/data-service/contract.ts';
import { CrmService } from './application/crm/crm-service.ts';
import { PermissionsService } from './application/permissions/permissions-service.ts';
import { type Runtime, systemRuntime } from './application/shared/runtime.ts';
import { D1Adapter, type D1Port, sql } from './infrastructure/d1/d1-port.ts';
import { D1CrmRepository } from './infrastructure/repositories/crm-repository.ts';
import { D1PermissionsRepository } from './infrastructure/repositories/permissions-repository.ts';

/**
 * Bindings the composition root needs.
 */
export interface DataBindings {
  /**
   * The Data Worker's D1 database.
   */
  readonly DATA_DB: D1Database;
  /**
   * Bootstrap owner e-mail.
   */
  readonly ADMIN_EMAIL: string;
  /**
   * Deployment environment; absent in local development.
   */
  readonly ENVIRONMENT?: string;
}

/**
 * Report health by reading the most recent applied migration.
 *
 * @param db The D1 port.
 * @returns Health.
 * @throws {Error} A `DEPENDENCY_FAILURE` service error when the database is unreachable or
 *   unmigrated.
 */
async function health(db: D1Port): Promise<DataHealth> {
  // The local-only seed (migrations/seed/9001_*) shares the bookkeeping table in development; it is
  // not part of the schema, so it is excluded from the reported schema version.
  const row = await db.readOne<{ name: string }>(
    sql(
      "SELECT name FROM d1_migrations WHERE name NOT LIKE '9___\\_%' ESCAPE '\\' ORDER BY id DESC LIMIT 1"
    )
  );
  if (row === null) {
    throw serviceError('DEPENDENCY_FAILURE', 'The database has not been migrated.');
  }
  return { status: 'ok', migration: row.name };
}

/**
 * Compose the Data Worker's services.
 *
 * @param bindings Worker bindings.
 * @param runtime Clock and id source (overridable in tests).
 * @returns The grouped service.
 */
export function compose(bindings: DataBindings, runtime: Runtime = systemRuntime): DataService {
  const db = new D1Adapter(bindings.DATA_DB);
  const permissions = new PermissionsService(
    new D1PermissionsRepository(db),
    bindings.ADMIN_EMAIL,
    runtime
  );
  const crm = new CrmService(new D1CrmRepository(db), permissions, runtime);
  return {
    health: () => health(db),
    resolveActor: (email, requestId) => permissions.resolveActor(email, requestId),
    resolveUser: (userId) => permissions.resolveUser(userId),
    authorize: (request) => permissions.authorize(request),
    crm,
    permissions
  };
}
