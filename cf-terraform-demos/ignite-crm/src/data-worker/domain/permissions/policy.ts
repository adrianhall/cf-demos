/**
 * @file Pure authorization policy for the Permissions module. No I/O: the application service loads
 *   a user's status and permission set, and this module decides. Deny is the default; roles are
 *   additive; there is no explicit deny rule in release one.
 */

import type { AuthorizationDecision } from '../../../shared/data-service/contract.ts';
import type { Permission, Role } from '../../../shared/permissions.ts';

/**
 * The facts the policy needs about a user.
 */
export interface PolicySubject {
  /**
   * Whether the user may act at all.
   */
  readonly status: 'active' | 'suspended';
  /**
   * Roles held.
   */
  readonly roles: readonly Role[];
  /**
   * Union of the roles' permissions.
   */
  readonly permissions: readonly Permission[];
}

/**
 * Decide whether a subject holds a permission.
 *
 * @param subject The user's status, roles, and permissions; `null` when the user is unknown.
 * @param permission The permission needed.
 * @returns The decision and its reason.
 */
export function evaluate(
  subject: PolicySubject | null,
  permission: Permission
): AuthorizationDecision {
  if (subject === null || subject.status !== 'active') {
    return { allowed: false, reason: 'inactive-user' };
  }
  if (subject.roles.length === 0) {
    return { allowed: false, reason: 'no-role' };
  }
  if (!subject.permissions.includes(permission)) {
    return { allowed: false, reason: 'missing-permission' };
  }
  return { allowed: true, reason: 'allowed' };
}

/**
 * Normalise an e-mail address for identity comparison.
 *
 * @param email Raw e-mail.
 * @returns Trimmed, lower-cased e-mail.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Derive an initial display name from an e-mail address (`jane.doe@x` → `Jane Doe`).
 *
 * @param email Normalised e-mail.
 * @returns A display name of 1–100 characters.
 */
export function displayNameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  const words = local
    .split(/[._+-]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  const name = words.join(' ');
  return (name.length > 0 ? name : email).slice(0, 100);
}

/**
 * Choose the role for a newly seen identity.
 *
 * The configured administrator becomes the bootstrap owner; anyone else Access admits starts as
 * read-only until an owner changes their role (see `specs/ignite-crm/03-follow-ons.md`).
 *
 * @param email Normalised e-mail of the new identity.
 * @param adminEmail Configured bootstrap administrator e-mail.
 * @returns The role to grant.
 */
export function initialRoleFor(email: string, adminEmail: string): Role {
  return email === normalizeEmail(adminEmail) ? 'owner' : 'read-only';
}
