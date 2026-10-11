/**
 * @file Team administration wire schemas: the team directory, the fixed role catalogue, and the
 *   owner-only invite, role-replacement, and status-change requests. As with the other
 *   `src/shared/api` modules, the same values cross the Data Worker RPC boundary unchanged, and
 *   request schemas are `strictObject`s so server-owned fields (`version`, `status` on invite)
 *   cannot be smuggled into a body. Roles are the fixed seeded set (specification §2); there is no
 *   custom-role editor in release one. A user may hold several roles, and permissions are the union
 *   of them.
 */

import * as v from 'valibot';
import { TimestampSchema } from '../common/dates.ts';
import { IdSchema } from '../common/ids.ts';
import { CursorSchema, MAX_PAGE_SIZE, pageSchema } from '../common/paging.ts';
import { PermissionSchema, ROLES, RoleSchema } from '../permissions.ts';
import { requiredText, SearchTermSchema } from '../validation/fields.ts';
import { RoleSummarySchema } from './session.ts';

/**
 * Account states an owner can set. A suspended user is refused on every request.
 */
export const USER_STATUSES = ['active', 'suspended'] as const;

/**
 * Schema for an account state.
 */
export const UserStatusSchema = v.picklist(USER_STATUSES, 'Status must be active or suspended.');

/**
 * An account state.
 */
export type UserStatus = v.InferOutput<typeof UserStatusSchema>;

/**
 * One seeded role and the permissions it grants.
 */
export const RoleDefinitionSchema = v.strictObject({
  /**
   * Role identifier.
   */
  id: RoleSchema,
  /**
   * Display name.
   */
  label: v.string(),
  /**
   * Permissions the role grants, sorted.
   */
  permissions: v.array(PermissionSchema)
});

/**
 * A role definition.
 */
export type RoleDefinition = v.InferOutput<typeof RoleDefinitionSchema>;

/**
 * The role catalogue, in the fixed display order of {@link ROLES}.
 */
export const RoleCatalogueSchema = v.array(RoleDefinitionSchema);

/**
 * One member of the team directory.
 */
export const TeamMemberSchema = v.strictObject({
  /**
   * User identifier.
   */
  id: IdSchema,
  /**
   * Normalised e-mail (the Access identity).
   */
  email: v.string(),
  /**
   * Display name.
   */
  displayName: v.string(),
  /**
   * Account state.
   */
  status: UserStatusSchema,
  /**
   * Roles held, in catalogue order.
   */
  roles: v.array(RoleSummarySchema),
  /**
   * Optimistic-concurrency version, shared by role and status changes.
   */
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /**
   * When the account was created (invited or first signed in).
   */
  createdAt: TimestampSchema
});

/**
 * A team member.
 */
export type TeamMember = v.InferOutput<typeof TeamMemberSchema>;

/**
 * One page of team members, ordered by display name.
 */
export const TeamPageSchema = pageSchema(TeamMemberSchema);

/**
 * Schema for a role set: one to every seeded role, no duplicates. An active user always holds at
 * least one role, so "remove every role" is expressed by suspending the account instead.
 */
export const RoleSetSchema = v.pipe(
  v.array(RoleSchema, 'Roles must be a list.'),
  v.minLength(1, 'Choose at least one role.'),
  v.maxLength(ROLES.length, `Choose at most ${ROLES.length} roles.`),
  v.check((roles) => new Set(roles).size === roles.length, 'Each role may be chosen only once.')
);

/**
 * Schema for an invitee's e-mail: trimmed, lower-cased, and a valid address.
 */
export const InviteEmailSchema = v.pipe(
  v.string('E-mail is required.'),
  v.trim(),
  v.toLowerCase(),
  v.nonEmpty('E-mail is required.'),
  v.maxLength(254, 'E-mail must be at most 254 characters.'),
  v.email('Must be a valid e-mail address.')
);

/**
 * Request body for inviting a teammate. Release one sends no e-mail: an invitation pre-creates the
 * Access identity with its roles, so the teammate's first sign-in already has them.
 */
export const InviteUserInputSchema = v.strictObject({
  /**
   * The teammate's Access e-mail.
   */
  email: InviteEmailSchema,
  /**
   * Display name shown across the CRM.
   */
  displayName: requiredText('Display name', 100),
  /**
   * Initial roles.
   */
  roles: RoleSetSchema
});

/**
 * A validated invite request.
 */
export type InviteUserInput = v.InferOutput<typeof InviteUserInputSchema>;

/**
 * Request body for replacing a teammate's roles.
 */
export const SetUserRolesInputSchema = v.strictObject({
  /**
   * The complete new role set.
   */
  roles: RoleSetSchema
});

/**
 * A validated role replacement.
 */
export type SetUserRolesInput = v.InferOutput<typeof SetUserRolesInputSchema>;

/**
 * Request body for suspending or reactivating a teammate.
 */
export const SetUserStatusInputSchema = v.strictObject({
  /**
   * The new account state.
   */
  status: UserStatusSchema
});

/**
 * A validated status change.
 */
export type SetUserStatusInput = v.InferOutput<typeof SetUserStatusInputSchema>;

/**
 * Query string for the team directory.
 */
export const TeamListQuerySchema = v.strictObject({
  /**
   * Optional search over display name and e-mail.
   */
  q: v.optional(SearchTermSchema),
  /**
   * Page size, 1–100.
   */
  limit: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^\d{1,3}$/u, 'limit must be a whole number.'),
      v.transform(Number),
      v.minValue(1, 'limit must be at least 1.'),
      v.maxValue(MAX_PAGE_SIZE, `limit must be at most ${MAX_PAGE_SIZE}.`)
    )
  ),
  /**
   * Cursor from the previous page.
   */
  cursor: v.optional(CursorSchema)
});
