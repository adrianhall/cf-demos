/**
 * @file Presentation of the fixed roles and permissions: an icon per role and a plain-language
 *   description per permission, shared by the app bar's account menu and the account page. The
 *   server's role matrix (`src/shared/permissions.ts`) stays the only source of what a role grants;
 *   this module only describes it.
 */

import {
  mdiAccountTie,
  mdiBriefcaseAccount,
  mdiCrown,
  mdiEyeOutline,
  mdiHammerWrench
} from '@mdi/js';
import { type Permission, type Role, ROLES } from '../../shared/permissions.ts';

/**
 * An icon (MDI SVG path) for each role.
 */
export const ROLE_ICONS: Readonly<Record<Role, string>> = {
  'owner': mdiCrown,
  'manager': mdiAccountTie,
  'sales': mdiBriefcaseAccount,
  'delivery': mdiHammerWrench,
  'read-only': mdiEyeOutline
};

/**
 * What each permission lets the signed-in user do, in their terms.
 */
export const PERMISSION_DESCRIPTIONS: Readonly<Record<Permission, string>> = {
  'users.read': 'See the team directory',
  'users.manage': 'Add teammates and suspend or reactivate accounts',
  'roles.assign': 'Change teammates’ roles',
  'audit.read': 'Read the audit trail',
  'crm.read': 'See contacts, companies, and deals',
  'crm.write': 'Create and edit contacts, companies, deals, and activities',
  'crm.delete': 'Delete customer records',
  'crm.assign': 'Assign deals to other people',
  'deal.convert': 'Convert won deals into delivery projects',
  'project.read': 'See projects and tasks',
  'project.write': 'Create, edit, and move tasks',
  'project.manage': 'Archive projects and change project leads',
  'note.read': 'Read notes',
  'note.write': 'Write notes',
  'note.manage': 'Edit other people’s notes',
  'report.read': 'View reports'
};

/**
 * The most privileged of a user's roles, which picks the account icon.
 *
 * @param roles The user's role ids.
 * @returns The first role in {@link ROLES} order that the user holds, or `read-only` if none.
 */
export function primaryRole(roles: readonly Role[]): Role {
  return ROLES.find((role) => roles.includes(role)) ?? 'read-only';
}
