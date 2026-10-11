/**
 * @file Data Worker composition root: the one place concrete adapters meet use cases. One
 *   composition is built per RPC invocation. Nothing is cached at module scope, so no state can
 *   leak between requests in a reused isolate.
 */

import { configuration } from '../configuration.ts';
import { serviceError } from '../shared/common/errors.ts';
import type { DataHealth, DataService } from '../shared/data-service/contract.ts';
import { crmModule } from './application/crm/crm-module.ts';
import { CrmService } from './application/crm/crm-service.ts';
import { SalesService } from './application/crm/sales-service.ts';
import { NotesService } from './application/notes/notes-service.ts';
import { PermissionsService } from './application/permissions/permissions-service.ts';
import { TeamService } from './application/permissions/team-service.ts';
import { ProjectsService } from './application/projects/projects-service.ts';
import { type Runtime, systemRuntime } from './application/shared/runtime.ts';
import { D1Adapter, type D1Port, sql } from './infrastructure/d1/d1-port.ts';
import { D1CrmRepository } from './infrastructure/repositories/crm-repository.ts';
import { D1NotesRepository } from './infrastructure/repositories/notes-repository.ts';
import { D1PermissionsRepository } from './infrastructure/repositories/permissions-repository.ts';
import { D1ProjectsRepository } from './infrastructure/repositories/projects-repository.ts';
import { D1SalesRepository } from './infrastructure/repositories/sales-repository.ts';
import { D1TeamRepository } from './infrastructure/repositories/team-repository.ts';

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
  return composeWithPort(new D1Adapter(bindings.DATA_DB), bindings.ADMIN_EMAIL, runtime);
}

/**
 * Compose the Data Worker's services over any {@link D1Port}.
 *
 * Production passes the D1 adapter; the test fake passes an in-memory SQLite port, so both run the
 * same repositories and use cases.
 *
 * @param db The D1 port.
 * @param adminEmail Bootstrap owner e-mail.
 * @param runtime Clock and id source.
 * @returns The grouped service.
 */
export function composeWithPort(db: D1Port, adminEmail: string, runtime: Runtime): DataService {
  const permissions = new PermissionsService(new D1PermissionsRepository(db), adminEmail, runtime);
  const salesRepository = new D1SalesRepository(db);
  const projectsRepository = new D1ProjectsRepository(db);
  const crm = crmModule(
    new CrmService(
      new D1CrmRepository(db),
      permissions,
      runtime,
      salesRepository,
      projectsRepository
    ),
    new SalesService(salesRepository, permissions, runtime, {
      timezone: configuration.timezone,
      currencyCode: configuration.currencyCode
    })
  );
  const projects = new ProjectsService(projectsRepository, permissions, runtime, {
    timezone: configuration.timezone
  });
  const notes = new NotesService(new D1NotesRepository(db), permissions, runtime);
  const team = new TeamService(new D1TeamRepository(db), permissions, runtime);
  return {
    health: () => health(db),
    resolveActor: (email, requestId) => permissions.resolveActor(email, requestId),
    resolveUser: (userId) => permissions.resolveUser(userId),
    authorize: (request) => permissions.authorize(request),
    crm,
    projects,
    notes,
    permissions: {
      getSession: (actor) => permissions.getSession(actor),
      listRoles: (actor) => team.listRoles(actor),
      listTeam: (actor, options) => team.listTeam(actor, options),
      inviteUser: (actor, input, meta) => team.inviteUser(actor, input, meta),
      setUserRoles: (actor, userId, input, version, meta) =>
        team.setUserRoles(actor, userId, input, version, meta),
      setUserStatus: (actor, userId, input, version, meta) =>
        team.setUserStatus(actor, userId, input, version, meta),
      listAudit: (actor, options) => team.listAudit(actor, options)
    }
  };
}
