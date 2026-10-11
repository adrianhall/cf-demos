/**
 * @file Team administration and the shared audit trail: the Permissions module's management use
 *   cases. Each mutation follows the shared order — validate input → authorize → replay check →
 *   domain rules over one read snapshot → one atomic repository write including audit and
 *   idempotency rows.
 *
 *   ## Role changes take effect on the next request
 *
 *   Nothing caches a user's roles: every `Authorizer.require` reads `user_roles` and
 *   `role_permissions` afresh (`./permissions-service.ts`), and the SPA's capability hints are only
 *   hints. So a role change or suspension is enforced on the teammate's very next API call, with no
 *   sign-out and no token revocation.
 *
 *   ## At least one active owner always remains
 *
 *   Demoting or suspending an owner could leave an installation nobody can administer. The rule is
 *   enforced at commit time, not by a read-then-write check: the write set ends with a guard that
 *   counts active owners _after_ the change, so two owners demoting each other concurrently cannot
 *   both succeed. The read before it only produces a friendlier early error.
 */

import * as v from 'valibot';
import type { AuditEvent } from '../../../shared/api/audit.ts';
import { AuditEntityTypeSchema, AuditModuleSchema } from '../../../shared/api/audit.ts';
import {
  type InviteUserInput,
  InviteUserInputSchema,
  type RoleDefinition,
  type SetUserRolesInput,
  SetUserRolesInputSchema,
  type SetUserStatusInput,
  SetUserStatusInputSchema,
  type TeamMember,
  type UserStatus
} from '../../../shared/api/team.ts';
import { serviceError } from '../../../shared/common/errors.ts';
import { IdSchema } from '../../../shared/common/ids.ts';
import { DEFAULT_PAGE_SIZE, type Page, PageRequestSchema } from '../../../shared/common/paging.ts';
import type {
  ActorContext,
  AuditListOptions,
  MutationMeta,
  TeamListOptions
} from '../../../shared/data-service/contract.ts';
import { type Role, ROLE_LABELS, ROLES } from '../../../shared/permissions.ts';
import { SearchTermSchema, VersionSchema } from '../../../shared/validation/fields.ts';
import { decodeCursor, encodeCursor } from '../crm/crm-service.ts';
import {
  type IdempotencyRepository,
  IdempotentMutation,
  type MutationEnvelope
} from '../shared/mutations.ts';
import type { Runtime } from '../shared/runtime.ts';
import { validate, validateActor, validateId, validateIdempotencyKey } from '../shared/validate.ts';
import type { Authorizer } from './permissions-service.ts';

/**
 * A team member as stored, with the sort key the directory pages on.
 */
export interface StoredMember extends TeamMember {
  /**
   * Lower-cased display name (the keyset sort key).
   */
  readonly sortKey: string;
}

/**
 * Keyset position and size for a list.
 */
export interface KeysetCriteria {
  /**
   * Page size.
   */
  readonly limit: number;
  /**
   * Last row of the previous page: its sort key and id.
   */
  readonly after: { readonly key: string; readonly id: string } | null;
}

/**
 * Storage port for team administration and the audit trail.
 */
export interface TeamRepository extends IdempotencyRepository {
  /**
   * The role catalogue as stored.
   *
   * @returns Each role with its sorted permissions.
   */
  listRoles(): Promise<RoleDefinition[]>;
  /**
   * One page of the team directory, ordered by lower-cased display name, then id.
   *
   * @param criteria Keyset position and size.
   * @param q Lower-cased search over display name and e-mail, or `null`.
   * @returns Up to `limit + 1` members.
   */
  listMembers(criteria: KeysetCriteria, q: string | null): Promise<StoredMember[]>;
  /**
   * One member.
   *
   * @param userId User id.
   * @returns The member, or `null`.
   */
  getMember(userId: string): Promise<TeamMember | null>;
  /**
   * A member by normalised e-mail.
   *
   * @param email E-mail.
   * @returns The member, or `null`.
   */
  findMemberByEmail(email: string): Promise<TeamMember | null>;
  /**
   * Active users holding the owner role.
   *
   * @returns The count.
   */
  activeOwnerCount(): Promise<number>;
  /**
   * Atomically insert an active user with roles.
   *
   * @param write The user, roles, and envelope.
   * @returns Once committed.
   * @throws {Error} `CONFLICT` when the e-mail was taken concurrently, or `DEPENDENCY_FAILURE`.
   */
  insertMember(write: {
    id: string;
    email: string;
    displayName: string;
    roles: readonly Role[];
    grantedBy: string;
    at: string;
    envelope: MutationEnvelope;
  }): Promise<void>;
  /**
   * Atomically replace roles and/or set status if the user is still at `expectedVersion`, then
   * require at least one active owner to remain.
   *
   * @param write The change and envelope.
   * @returns Once committed.
   * @throws {Error} `VERSION_MISMATCH`, `CONFLICT` (no active owner would remain), or
   *   `DEPENDENCY_FAILURE`.
   */
  updateMember(write: {
    userId: string;
    expectedVersion: number;
    roles: readonly Role[] | null;
    status: UserStatus | null;
    grantedBy: string;
    at: string;
    envelope: MutationEnvelope;
  }): Promise<void>;
  /**
   * One page of audit events, newest first, with raw metadata.
   *
   * @param criteria Keyset position (occurred-at and id) and size.
   * @param filters Equality filters; `undefined` means unfiltered.
   * @returns Up to `limit + 1` events.
   */
  listAudit(
    criteria: KeysetCriteria,
    filters: Omit<AuditListOptions, 'limit' | 'cursor'>
  ): Promise<AuditEvent[]>;
}

/**
 * Schema for team list options crossing RPC.
 */
const TeamListOptionsSchema = v.strictObject({
  q: v.optional(SearchTermSchema),
  ...PageRequestSchema.entries
});

/**
 * Schema for audit list options crossing RPC.
 */
const AuditListOptionsSchema = v.strictObject({
  module: v.optional(AuditModuleSchema),
  entityType: v.optional(AuditEntityTypeSchema),
  entityId: v.optional(IdSchema),
  actorId: v.optional(IdSchema),
  ...PageRequestSchema.entries
});

/**
 * Put roles in catalogue order, so stored sets, audit text, and idempotency hashes do not depend on
 * the order a user ticked them.
 *
 * @param roles Roles.
 * @returns A sorted copy.
 */
export function sortRoles(roles: readonly Role[]): Role[] {
  return [...roles].sort((a, b) => ROLES.indexOf(a) - ROLES.indexOf(b));
}

/**
 * Whether a member is an active owner.
 *
 * @param member The member.
 * @returns `true` when active with the owner role.
 */
function isActiveOwner(member: TeamMember): boolean {
  return member.status === 'active' && member.roles.some((role) => role.id === 'owner');
}

/**
 * Format roles for audit metadata.
 *
 * @param roles Roles.
 * @returns Comma-separated role ids.
 */
function roleText(roles: readonly Role[]): string {
  return roles.join(',');
}

/**
 * Turn an over-fetched row set into a page.
 *
 * @param rows Up to `limit + 1` rows.
 * @param limit Page size.
 * @param keyOf The sort key of a row.
 * @returns The visible rows and a cursor when more exist.
 */
function paginate<T extends { id: string }>(
  rows: readonly T[],
  limit: number,
  keyOf: (row: T) => string
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last !== undefined ? encodeCursor(keyOf(last), last.id) : null
  };
}

/**
 * Team administration and audit application service.
 */
export class TeamService {
  /**
   * @param repository Storage port.
   * @param authorizer Permissions capability.
   * @param runtime Clock and id source.
   */
  constructor(
    private readonly repository: TeamRepository,
    private readonly authorizer: Authorizer,
    private readonly runtime: Runtime
  ) {}

  /**
   * The role catalogue.
   *
   * @param actor The caller.
   * @returns Every seeded role with its permissions, in catalogue order.
   * @throws {Error} `VALIDATION_FAILED` for a malformed actor, `FORBIDDEN` without `users.read`, or
   *   `DEPENDENCY_FAILURE`.
   */
  async listRoles(actor: ActorContext): Promise<RoleDefinition[]> {
    const caller = validateActor(actor);
    await this.authorizer.require(caller, 'users.read');
    const roles = await this.repository.listRoles();
    return sortRoles(roles.map((role) => role.id)).map((id) =>
      roles.find((role) => role.id === id)!
    );
  }

  /**
   * The team directory.
   *
   * @param actor The caller.
   * @param options Search and paging.
   * @returns One page, ordered by display name.
   * @throws {Error} `VALIDATION_FAILED` for bad options or cursor, `FORBIDDEN` without
   *   `users.read`, or `DEPENDENCY_FAILURE`.
   */
  async listTeam(actor: ActorContext, options: TeamListOptions): Promise<Page<TeamMember>> {
    const caller = validateActor(actor);
    const parsed = validate(
      TeamListOptionsSchema,
      options ?? { limit: DEFAULT_PAGE_SIZE },
      caller.requestId
    );
    const criteria: KeysetCriteria = {
      limit: parsed.limit,
      after: parsed.cursor === undefined ? null : decodeCursor(parsed.cursor, caller.requestId)
    };
    await this.authorizer.require(caller, 'users.read');
    const rows = await this.repository.listMembers(criteria, parsed.q?.toLowerCase() ?? null);
    const page = paginate(rows, criteria.limit, (row) => row.sortKey);
    return {
      items: page.items.map(({ sortKey: _sortKey, ...member }) => member),
      nextCursor: page.nextCursor
    };
  }

  /**
   * Add a teammate.
   *
   * @param actor The caller.
   * @param input E-mail, display name, and roles.
   * @param meta Idempotency metadata.
   * @returns The new member.
   * @throws {Error} `VALIDATION_FAILED` for bad input, `FORBIDDEN` without both `users.manage` and
   *   `roles.assign`, `CONFLICT` (with `fields.email`) when the e-mail is already on the team,
   *   `IDEMPOTENCY_KEY_REUSED`, or `DEPENDENCY_FAILURE`.
   */
  async inviteUser(
    actor: ActorContext,
    input: InviteUserInput,
    meta: MutationMeta
  ): Promise<TeamMember> {
    const caller = validateActor(actor);
    const parsed = validate(InviteUserInputSchema, input, caller.requestId);
    const key = validateIdempotencyKey(meta?.idempotencyKey, caller.requestId);
    const roles = sortRoles(parsed.roles);
    await this.authorizer.require(caller, 'users.manage');
    await this.authorizer.require(caller, 'roles.assign');

    const mutation = await IdempotentMutation.begin(
      'permissions.inviteUser',
      caller,
      { idempotencyKey: key },
      { ...parsed, roles },
      this.runtime
    );
    const replayed = await mutation.replay<TeamMember>(this.repository);
    if (replayed !== undefined) {
      return replayed;
    }
    if ((await this.repository.findMemberByEmail(parsed.email)) !== null) {
      throw serviceError('CONFLICT', 'That e-mail is already on the team.', {
        requestId: caller.requestId,
        fields: { email: 'That e-mail is already on the team.' }
      });
    }
    const now = this.runtime.now();
    const at = now.toISOString();
    const member: TeamMember = {
      id: this.runtime.newId(),
      email: parsed.email,
      displayName: parsed.displayName,
      status: 'active',
      roles: roles.map((id) => ({ id, label: ROLE_LABELS[id] })),
      version: 1,
      createdAt: at
    };
    await this.repository.insertMember({
      id: member.id,
      email: member.email,
      displayName: member.displayName,
      roles,
      grantedBy: caller.userId,
      at,
      envelope: mutation.envelope(
        member,
        [
          mutation.audit(
            'permissions',
            'user',
            member.id,
            'invited',
            { rolesAfter: roleText(roles), statusAfter: 'active' },
            at
          )
        ],
        now
      )
    });
    return member;
  }

  /**
   * Replace a teammate's roles.
   *
   * @param actor The caller.
   * @param userId The teammate.
   * @param input The new role set.
   * @param expectedVersion Version last read.
   * @param meta Idempotency metadata.
   * @returns The updated member.
   * @throws {Error} `VALIDATION_FAILED`, `FORBIDDEN` without `roles.assign`, `NOT_FOUND`,
   *   `VERSION_MISMATCH`, `CONFLICT` when no active owner would remain, `IDEMPOTENCY_KEY_REUSED`,
   *   or `DEPENDENCY_FAILURE`.
   */
  async setUserRoles(
    actor: ActorContext,
    userId: string,
    input: SetUserRolesInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<TeamMember> {
    const caller = validateActor(actor);
    const id = validateId(userId, caller.requestId);
    const parsed = validate(SetUserRolesInputSchema, input, caller.requestId);
    const version = validate(VersionSchema, expectedVersion, caller.requestId);
    const key = validateIdempotencyKey(meta?.idempotencyKey, caller.requestId);
    const roles = sortRoles(parsed.roles);
    await this.authorizer.require(caller, 'roles.assign');
    return this.change(
      caller,
      'permissions.setUserRoles',
      key,
      { id, roles, version },
      id,
      version,
      (current) => ({
        roles,
        status: null,
        action: 'roles-changed',
        metadata: {
          rolesBefore: roleText(current.roles.map((role) => role.id)),
          rolesAfter: roleText(roles)
        },
        next: { ...current, roles: roles.map((role) => ({ id: role, label: ROLE_LABELS[role] })) }
      })
    );
  }

  /**
   * Suspend or reactivate a teammate.
   *
   * @param actor The caller.
   * @param userId The teammate.
   * @param input The new status.
   * @param expectedVersion Version last read.
   * @param meta Idempotency metadata.
   * @returns The updated member.
   * @throws {Error} `VALIDATION_FAILED`, `FORBIDDEN` without `users.manage`, `NOT_FOUND`,
   *   `VERSION_MISMATCH`, `CONFLICT` when suspending yourself or when no active owner would remain,
   *   `IDEMPOTENCY_KEY_REUSED`, or `DEPENDENCY_FAILURE`.
   */
  async setUserStatus(
    actor: ActorContext,
    userId: string,
    input: SetUserStatusInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<TeamMember> {
    const caller = validateActor(actor);
    const id = validateId(userId, caller.requestId);
    const parsed = validate(SetUserStatusInputSchema, input, caller.requestId);
    const version = validate(VersionSchema, expectedVersion, caller.requestId);
    const key = validateIdempotencyKey(meta?.idempotencyKey, caller.requestId);
    await this.authorizer.require(caller, 'users.manage');
    if (id === caller.userId && parsed.status === 'suspended') {
      // Locking yourself out is never what an owner means to do from the team page.
      throw serviceError('CONFLICT', 'You cannot suspend your own account.', {
        requestId: caller.requestId
      });
    }
    return this.change(
      caller,
      'permissions.setUserStatus',
      key,
      { id, status: parsed.status, version },
      id,
      version,
      (current) => ({
        roles: null,
        status: parsed.status,
        action: parsed.status === 'suspended' ? 'suspended' : 'reactivated',
        metadata: { statusBefore: current.status, statusAfter: parsed.status },
        next: { ...current, status: parsed.status }
      })
    );
  }

  /**
   * The shared audit trail.
   *
   * @param actor The caller.
   * @param options Filters and paging.
   * @returns One page, newest first.
   * @throws {Error} `VALIDATION_FAILED` for bad filters or cursor, `FORBIDDEN` without
   *   `audit.read`, or `DEPENDENCY_FAILURE`.
   */
  async listAudit(actor: ActorContext, options: AuditListOptions): Promise<Page<AuditEvent>> {
    const caller = validateActor(actor);
    const parsed = validate(
      AuditListOptionsSchema,
      options ?? { limit: DEFAULT_PAGE_SIZE },
      caller.requestId
    );
    const criteria: KeysetCriteria = {
      limit: parsed.limit,
      after: parsed.cursor === undefined ? null : decodeCursor(parsed.cursor, caller.requestId)
    };
    await this.authorizer.require(caller, 'audit.read');
    const rows = await this.repository.listAudit(criteria, {
      ...(parsed.module === undefined ? {} : { module: parsed.module }),
      ...(parsed.entityType === undefined ? {} : { entityType: parsed.entityType }),
      ...(parsed.entityId === undefined ? {} : { entityId: parsed.entityId }),
      ...(parsed.actorId === undefined ? {} : { actorId: parsed.actorId })
    });
    return paginate(rows, criteria.limit, (row) => row.occurredAt);
  }

  /**
   * The shared versioned-change path for roles and status.
   *
   * @param caller The caller.
   * @param operation Idempotency operation name.
   * @param key Idempotency key.
   * @param request The canonical request, for replay hashing.
   * @param userId The teammate.
   * @param version Expected version.
   * @param plan Derive the change from the current member.
   * @returns The updated member.
   * @throws {Error} `NOT_FOUND`, `VERSION_MISMATCH`, `CONFLICT` (final owner), or
   *   `DEPENDENCY_FAILURE`.
   */
  private async change(
    caller: ActorContext,
    operation: string,
    key: string,
    request: unknown,
    userId: string,
    version: number,
    plan: (current: TeamMember) => {
      roles: Role[] | null;
      status: UserStatus | null;
      action: string;
      metadata: Record<string, string>;
      next: TeamMember;
    }
  ): Promise<TeamMember> {
    const mutation = await IdempotentMutation.begin(
      operation,
      caller,
      { idempotencyKey: key },
      request,
      this.runtime
    );
    const replayed = await mutation.replay<TeamMember>(this.repository);
    if (replayed !== undefined) {
      return replayed;
    }
    const current = await this.repository.getMember(userId);
    if (current === null) {
      throw serviceError('NOT_FOUND', 'Team member not found.', { requestId: caller.requestId });
    }
    if (current.version !== version) {
      throw serviceError(
        'VERSION_MISMATCH',
        'This teammate was changed by someone else. Reload and try again.',
        { requestId: caller.requestId }
      );
    }
    const change = plan(current);
    const next: TeamMember = { ...change.next, version: current.version + 1 };
    if (isActiveOwner(current) && !isActiveOwner(next)) {
      // A friendly early answer; the commit-time guard in the repository is the real rule.
      if ((await this.repository.activeOwnerCount()) <= 1) {
        throw serviceError('CONFLICT', 'The team must keep at least one active owner.', {
          requestId: caller.requestId
        });
      }
    }
    const now = this.runtime.now();
    const at = now.toISOString();
    await this.repository.updateMember({
      userId,
      expectedVersion: version,
      roles: change.roles,
      status: change.status,
      grantedBy: caller.userId,
      at,
      envelope: mutation.envelope(
        next,
        [mutation.audit('permissions', 'user', userId, change.action, change.metadata, at)],
        now
      )
    });
    return next;
  }
}
