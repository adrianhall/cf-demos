/**
 * @file The fixed RBAC vocabulary: seeded roles and the permissions each grants. This module is
 *   runtime-neutral because three tiers need the same names: the Data Worker authorizes with them,
 *   the Application Worker forwards them as capability hints, and the SPA uses those hints to hide
 *   controls. The authoritative role→permission matrix lives in the database
 *   (`migrations/data/0001_*.sql`); {@link SEED_ROLE_PERMISSIONS} mirrors it so tests can assert
 *   the two never drift.
 */

import * as v from 'valibot';

/**
 * Every permission, in `resource.action` form.
 */
export const PERMISSIONS = [
  'users.read',
  'users.manage',
  'roles.assign',
  'audit.read',
  'crm.read',
  'crm.write',
  'crm.delete',
  'crm.assign',
  'deal.convert',
  'project.read',
  'project.write',
  'project.manage',
  'note.read',
  'note.write',
  'note.manage',
  'report.read'
] as const;

/**
 * A permission name.
 */
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Schema for a permission name.
 */
export const PermissionSchema = v.picklist(PERMISSIONS);

/**
 * The seeded role identifiers.
 */
export const ROLES = ['owner', 'manager', 'sales', 'delivery', 'read-only'] as const;

/**
 * A seeded role identifier.
 */
export type Role = (typeof ROLES)[number];

/**
 * Schema for a role identifier.
 */
export const RoleSchema = v.picklist(ROLES);

/**
 * Display names for each role.
 */
export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  'owner': 'Owner',
  'manager': 'Manager',
  'sales': 'Sales representative',
  'delivery': 'Delivery contributor',
  'read-only': 'Read-only'
};

/**
 * Permissions read by everyone, including read-only users.
 */
const READ_ALL: readonly Permission[] = ['crm.read', 'project.read', 'note.read', 'report.read'];

/**
 * The seeded role→permission matrix (see `microservice-experiment/01a-permissions-spec.md` §3.2),
 * plus `crm.assign` (added by `migrations/data/0002_sales.sql`): assigning a deal to someone other
 * than yourself is the manager/owner "reassign coverage" story, not an ordinary sales write. Also
 * `users.read` (added by `migrations/data/0005_team.sql`): owners and managers may read the team
 * directory, because a manager reassigns coverage and reviews the audit trail by person; only
 * owners change membership, roles, or status.
 */
export const SEED_ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  'owner': [...PERMISSIONS],
  'manager': [
    'users.read',
    'audit.read',
    ...READ_ALL,
    'crm.write',
    'crm.delete',
    'crm.assign',
    'deal.convert',
    'project.write',
    'project.manage',
    'note.write',
    'note.manage'
  ],
  'sales': [...READ_ALL, 'crm.write', 'deal.convert', 'note.write'],
  'delivery': [...READ_ALL, 'project.write', 'note.write'],
  'read-only': [...READ_ALL]
};
