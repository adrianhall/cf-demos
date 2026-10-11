/**
 * @file Permissions module use cases: actor resolution, authorization, and session projection.
 *   Every other module asks this service to authorize through {@link Authorizer}; none of them
 *   reads role tables. Any storage failure while deciding fails closed as a retryable
 *   `DEPENDENCY_FAILURE`, never as an allow.
 */

import * as v from 'valibot';
import type { Session } from '../../../shared/api/session.ts';
import { isServiceError, serviceError } from '../../../shared/common/errors.ts';
import type {
  ActorContext,
  AuthorizationDecision,
  AuthorizationRequest,
  ResolvedActor,
  ResolvedUser
} from '../../../shared/data-service/contract.ts';
import {
  type Permission,
  PermissionSchema,
  ROLE_LABELS,
  type Role
} from '../../../shared/permissions.ts';
import {
  displayNameFromEmail,
  evaluate,
  initialRoleFor,
  type PolicySubject
} from '../../domain/permissions/policy.ts';
import type { Runtime } from '../shared/runtime.ts';
import { validate, validateActor, validateId } from '../shared/validate.ts';

/**
 * A stored user with its roles and permissions.
 */
export interface UserRecord extends PolicySubject {
  /**
   * User identifier.
   */
  readonly id: string;
  /**
   * Normalised e-mail.
   */
  readonly email: string;
  /**
   * Display name.
   */
  readonly displayName: string;
}

/**
 * A user to provision on first sight.
 */
export interface NewUser {
  /**
   * User identifier.
   */
  readonly id: string;
  /**
   * Normalised e-mail.
   */
  readonly email: string;
  /**
   * Display name.
   */
  readonly displayName: string;
  /**
   * Initial role.
   */
  readonly role: Role;
  /**
   * Request identifier for the audit event.
   */
  readonly requestId: string;
  /**
   * Creation instant.
   */
  readonly createdAt: string;
  /**
   * Audit event identifier.
   */
  readonly auditId: string;
}

/**
 * Storage port for the Permissions module.
 */
export interface PermissionsRepository {
  /**
   * Find a user by normalised e-mail.
   *
   * @param email Normalised e-mail.
   * @returns The user, or `null`.
   * @throws {Error} A `DEPENDENCY_FAILURE` service error when storage fails.
   */
  findUserByEmail(email: string): Promise<UserRecord | null>;
  /**
   * Find a user by identifier.
   *
   * @param id User identifier.
   * @returns The user, or `null`.
   * @throws {Error} A `DEPENDENCY_FAILURE` service error when storage fails.
   */
  findUserById(id: string): Promise<UserRecord | null>;
  /**
   * Create a user with one role unless the e-mail already exists (concurrent first requests
   * converge on one row).
   *
   * @param user The user.
   * @returns Once the user exists.
   * @throws {Error} A `DEPENDENCY_FAILURE` service error when storage fails.
   */
  provisionUser(user: NewUser): Promise<void>;
}

/**
 * The narrow authorization capability other modules depend on.
 */
export interface Authorizer {
  /**
   * Require that the actor holds a permission.
   *
   * @param actor The caller.
   * @param permission The permission needed.
   * @returns Once authorized.
   * @throws {Error} A `FORBIDDEN` service error when denied, or a retryable `DEPENDENCY_FAILURE`
   *   when the decision could not be made (fail closed).
   */
  require(actor: ActorContext, permission: Permission): Promise<void>;
}

/**
 * Schema for an authorization request crossing RPC.
 */
const AuthorizationRequestSchema = v.strictObject({
  userId: v.string(),
  permission: PermissionSchema,
  resource: v.optional(
    v.strictObject({
      type: v.pipe(v.string(), v.maxLength(64)),
      id: v.optional(v.string()),
      ownerId: v.optional(v.string())
    })
  )
});

/**
 * Permissions application service.
 */
export class PermissionsService implements Authorizer {
  /**
   * @param repository Storage port.
   * @param adminEmail Configured bootstrap owner e-mail.
   * @param runtime Clock and id source.
   */
  constructor(
    private readonly repository: PermissionsRepository,
    private readonly adminEmail: string,
    private readonly runtime: Runtime
  ) {}

  /**
   * Resolve a verified e-mail to an active user, provisioning a new identity on first sight.
   *
   * @param email Verified Access e-mail.
   * @param requestId Request identifier.
   * @returns The active user.
   * @throws {Error} `VALIDATION_FAILED` for a malformed e-mail, `FORBIDDEN` for a suspended user,
   *   or a retryable `DEPENDENCY_FAILURE` when storage fails.
   */
  async resolveActor(email: string, requestId: string): Promise<ResolvedActor> {
    const normalized = validate(
      v.pipe(v.string(), v.trim(), v.toLowerCase(), v.maxLength(254), v.email()),
      email,
      requestId
    );
    let user = await this.failClosed(() => this.repository.findUserByEmail(normalized), requestId);
    if (user === null) {
      await this.failClosed(
        () =>
          this.repository.provisionUser({
            id: this.runtime.newId(),
            email: normalized,
            displayName: displayNameFromEmail(normalized),
            role: initialRoleFor(normalized, this.adminEmail),
            requestId,
            createdAt: this.runtime.now().toISOString(),
            auditId: this.runtime.newId()
          }),
        requestId
      );
      user = await this.failClosed(() => this.repository.findUserByEmail(normalized), requestId);
    }
    if (user === null || user.status !== 'active') {
      throw serviceError('FORBIDDEN', 'This account is not active.', { requestId });
    }
    return { userId: user.id, email: user.email, displayName: user.displayName, status: 'active' };
  }

  /**
   * Look up a user by identifier.
   *
   * @param userId User identifier.
   * @returns The user.
   * @throws {Error} `VALIDATION_FAILED` for a malformed id, `NOT_FOUND` when absent, or
   *   `DEPENDENCY_FAILURE`.
   */
  async resolveUser(userId: string): Promise<ResolvedUser> {
    const id = validateId(userId, 'unknown');
    const user = await this.failClosed(() => this.repository.findUserById(id), 'unknown');
    if (user === null) {
      throw serviceError('NOT_FOUND', 'User not found.');
    }
    return {
      userId: user.id,
      displayName: user.displayName,
      status: user.status === 'active' ? 'active' : 'inactive'
    };
  }

  /**
   * Answer an authorization question.
   *
   * @param request The question.
   * @returns The decision (denials are values, not errors).
   * @throws {Error} `VALIDATION_FAILED` for a malformed request, or `DEPENDENCY_FAILURE`.
   */
  async authorize(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    const parsed = validate(AuthorizationRequestSchema, request, 'unknown');
    const user = await this.failClosed(
      () => this.repository.findUserById(parsed.userId),
      'unknown'
    );
    return evaluate(user, parsed.permission);
  }

  /**
   * @inheritdoc
   */
  async require(actor: ActorContext, permission: Permission): Promise<void> {
    const user = await this.failClosed(
      () => this.repository.findUserById(actor.userId),
      actor.requestId
    );
    const decision = evaluate(user, permission);
    if (!decision.allowed) {
      throw serviceError(
        'FORBIDDEN',
        `You do not have permission to perform this action (${permission}).`,
        {
          requestId: actor.requestId
        }
      );
    }
  }

  /**
   * The caller's session: user, roles, and capability hints.
   *
   * @param actor The caller.
   * @returns The session.
   * @throws {Error} `VALIDATION_FAILED` for a malformed actor, `FORBIDDEN` when inactive, or
   *   `DEPENDENCY_FAILURE`.
   */
  async getSession(actor: ActorContext): Promise<Session> {
    const caller = validateActor(actor);
    const user = await this.failClosed(
      () => this.repository.findUserById(caller.userId),
      caller.requestId
    );
    if (user === null || user.status !== 'active') {
      throw serviceError('FORBIDDEN', 'This account is not active.', {
        requestId: caller.requestId
      });
    }
    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      roles: user.roles.map((role) => ({ id: role, label: ROLE_LABELS[role] })),
      permissions: [...user.permissions]
    };
  }

  /**
   * Run a storage call, converting any unexpected failure into a retryable dependency error.
   *
   * @param work The storage call.
   * @param requestId Request identifier for the error.
   * @returns The call's result.
   * @throws {Error} The original service error, or a retryable `DEPENDENCY_FAILURE`.
   */
  private async failClosed<T>(work: () => Promise<T>, requestId: string): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (
        isServiceError(error)
        && error.code !== 'DEPENDENCY_FAILURE'
        && error.code !== 'INTERNAL'
      ) {
        throw error;
      }
      throw serviceError('DEPENDENCY_FAILURE', 'Permissions are temporarily unavailable.', {
        requestId,
        retryable: true
      });
    }
  }
}
