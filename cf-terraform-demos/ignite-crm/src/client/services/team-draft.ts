/**
 * @file The team-member form's draft and its conversion into API requests.
 */

import type { InviteUserInput, SetUserRolesInput } from '../../shared/api/team.ts';
import type { Role } from '../../shared/permissions.ts';

/**
 * The team-member form's draft.
 */
export interface TeamMemberFormValue {
  /**
   * Access e-mail (invite only).
   */
  email: string;
  /**
   * Display name (invite only).
   */
  displayName: string;
  /**
   * Chosen roles.
   */
  roles: Role[];
}

/**
 * Build an invite request.
 *
 * @param value The draft.
 * @returns The request; the server trims and lower-cases the e-mail.
 */
export function toInviteInput(value: TeamMemberFormValue): InviteUserInput {
  return { email: value.email, displayName: value.displayName, roles: [...value.roles] };
}

/**
 * Build a role-replacement request.
 *
 * @param value The draft.
 * @returns The request.
 */
export function toRolesInput(value: TeamMemberFormValue): SetUserRolesInput {
  return { roles: [...value.roles] };
}
