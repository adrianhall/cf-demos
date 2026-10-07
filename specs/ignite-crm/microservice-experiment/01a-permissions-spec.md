# Ignite CRM — Permissions and identity service specification

## 1. Purpose and boundary

The Permissions service is the installation's source of truth for users, seeded roles, role
assignments, and authorization decisions. Cloudflare Access authenticates an email; this service
resolves it to an installation-local user and answers whether that user may perform an action.

It does **not** authenticate JWTs, own OAuth tokens, store CRM/project/note data, implement
per-record ACLs, or trust role claims supplied by callers. See
[`01-specification.md`](./01-specification.md) for shared RPC, error, idempotency, and test rules.

## 2. Architecture

```text
PermissionsEntrypoint (WorkerEntrypoint)
  → PermissionsApplicationService
    → PolicyEvaluator (pure domain)
    → UserRepository / RoleRepository / AuditRepository ports
      → D1 adapters (PERMISSIONS_DB only)
```

This Worker binds only `PERMISSIONS_DB`. It has no domain service bindings and therefore cannot form
an authorization dependency cycle. It has no public HTTP route or custom domain.

## 3. Fixed authorization model

### 3.1 Users and lifecycle

- SQL migrations seed roles/permissions only; they cannot read runtime configuration. On the first
  `resolveActor(ADMIN_EMAIL)`, a single conditional D1 insert creates the bootstrap active owner.
  Any other identity is denied until that row exists. The unique normalized-email constraint makes
  concurrent first requests converge on one owner; after insertion, `ADMIN_EMAIL` has no special
  authorization behavior.
- A previously unknown Access identity is **not** auto-provisioned. `resolveActor()` returns
  `FORBIDDEN` until an owner invites that email.
- Invitation in release one is a pre-authorization record, not an email delivery. On the invited
  person's first authenticated request, `resolveActor()` activates the user.
- User states are `invited`, `active`, `suspended`, `deleted`. Suspended/deleted users always deny.
- Email is unique after trim/lowercase normalization. User ID, not email, is stored in domain
  records.
- At least one active owner must remain. The final owner cannot be demoted, suspended, or deleted.

### 3.2 Seed roles

Permissions are stable string literals in `resource.action` form. Seed role contents are migration
versioned and not editable in release one.

| Permission                      | Owner | Manager | Sales rep | Delivery contributor | Read-only |
| ------------------------------- | :---: | :-----: | :-------: | :------------------: | :-------: |
| `users.manage` / `roles.assign` |   ✓   |    —    |     —     |          —           |     —     |
| `audit.read`                    |   ✓   |    ✓    |     —     |          —           |     —     |
| `crm.read`                      |   ✓   |    ✓    |     ✓     |          ✓           |     ✓     |
| `crm.write`                     |   ✓   |    ✓    |     ✓     |          —           |     —     |
| `crm.delete`                    |   ✓   |    ✓    |     —     |          —           |     —     |
| `deal.convert`                  |   ✓   |    ✓    |     ✓     |          —           |     —     |
| `project.read`                  |   ✓   |    ✓    |     ✓     |          ✓           |     ✓     |
| `project.write`                 |   ✓   |    ✓    |     —     |          ✓           |     —     |
| `project.manage`                |   ✓   |    ✓    |     —     |          —           |     —     |
| `note.read`                     |   ✓   |    ✓    |     ✓     |          ✓           |     ✓     |
| `note.write`                    |   ✓   |    ✓    |     ✓     |          ✓           |     —     |
| `note.manage`                   |   ✓   |    ✓    |     —     |          —           |     —     |
| `report.read`                   |   ✓   |    ✓    |     ✓     |          ✓           |     ✓     |

Roles are additive. A user may have multiple roles. Deny is the default; release one has no explicit
deny rule. Record ownership is passed as resource context and may narrow a permission only where a
child service specifies it (private contacts are not a Must-have).

## 4. RPC contract

```ts
export type Permission =
  | 'users.manage'
  | 'roles.assign'
  | 'audit.read'
  | 'crm.read'
  | 'crm.write'
  | 'crm.delete'
  | 'deal.convert'
  | 'project.read'
  | 'project.write'
  | 'project.manage'
  | 'note.read'
  | 'note.write'
  | 'note.manage'
  | 'report.read';

export interface AuthorizationRequest {
  readonly userId: string;
  readonly permission: Permission;
  readonly resource?: {
    readonly type: string;
    readonly id?: string;
    readonly ownerId?: string;
  };
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason: 'allowed' | 'no-role' | 'missing-permission' | 'inactive-user';
  readonly policyVersion: number;
}

export abstract class PermissionsContract {
  abstract health(): Promise<{ status: 'ok'; migrationVersion: string }>;
  abstract resolveActor(
    email: string,
    requestId: string
  ): Promise<{
    userId: string;
    email: string;
    displayName: string;
    status: 'active';
  }>;
  abstract resolveUser(userId: string): Promise<{
    userId: string;
    displayName: string;
    status: 'active' | 'inactive';
  }>;
  abstract authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
  abstract batchAuthorize(
    requests: readonly AuthorizationRequest[]
  ): Promise<readonly AuthorizationDecision[]>;
  abstract listUsers(actor: ActorContext, page: PageRequest): Promise<Page<UserSummary>>;
  abstract inviteUser(
    actor: ActorContext,
    input: InviteUserInput,
    meta: MutationMeta
  ): Promise<UserSummary>;
  abstract setUserRoles(
    actor: ActorContext,
    input: SetUserRolesInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<UserSummary>;
  abstract setUserStatus(
    actor: ActorContext,
    input: SetUserStatusInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<UserSummary>;
  abstract listRoles(actor: ActorContext): Promise<readonly RoleSummary[]>;
  abstract listAudit(
    actor: ActorContext,
    filter: AuditFilter,
    page: PageRequest
  ): Promise<Page<PermissionAuditEvent>>;
}
```

`authorize` deliberately takes a resolved user ID, not an `ActorContext`, so domain services cannot
accidentally ask about an unregistered email. `resolveUser` exists for trusted services to validate
assignees/owners without disclosing email or roles; every non-active state is returned as
`inactive`. Management calls authorize their actor internally. Batch order exactly matches request
order and is capped at 100.

## 5. D1 data model

All tables are `STRICT`; timestamps are ISO UTC text.

### `users`

| Column                                   | Rules                                  |
| ---------------------------------------- | -------------------------------------- |
| `id`                                     | TEXT primary key UUID                  |
| `email_normalized`                       | TEXT unique, not null                  |
| `display_name`                           | TEXT not null, 1–120                   |
| `status`                                 | CHECK invited/active/suspended/deleted |
| `version`                                | INTEGER not null                       |
| `invited_by`, `created_at`, `updated_at` | not null except bootstrap inviter      |
| `activated_at`, `deleted_at`             | nullable                               |

Indexes: `(status, email_normalized)`, `(created_at, id)`.

### `roles`, `role_permissions`, `user_roles`

- `roles(id, key UNIQUE, name, description, system, version)`.
- `role_permissions(role_id, permission, PRIMARY KEY(role_id, permission))`.
- `user_roles(user_id, role_id, assigned_by, assigned_at, PRIMARY KEY(user_id, role_id))`.
- Foreign keys enforce local references. Seed migrations use stable role UUIDs/keys.

### `audit_events`

`id`, `actor_id`, `action`, `target_type`, `target_id`, `before_json`, `after_json`, `request_id`,
`channel`, `created_at`. Before/after contain role keys/status only; never JWTs or OAuth data.
Indexes: `(created_at DESC, id DESC)`, `(target_type, target_id, created_at DESC)`.

### `idempotency_records`

Uses the shared schema and unique `(actor_id, operation, idempotency_key)`.

## 6. Business rules and errors

- Only `users.manage` can invite or change status; only `roles.assign` can assign roles.
- An owner cannot grant an unknown role key.
- Inviting an existing invited user is an idempotent success; inviting active/suspended users is
  `CONFLICT` with a safe message.
- Role/status changes require `expectedVersion`; user-row compare-and-swap, role replacement/status,
  final-owner predicate, audit, version increment, and idempotency result commit atomically. Empty
  roles are forbidden for active users.
- Final-owner protection is a single conditional mutation (`UPDATE`/`DELETE ... WHERE` with an
  active-owner count predicate), followed by a changed-row assertion in the same transaction. It is
  not a race-prone read-then-write check.
- `resolveActor` activation changes `invited → active` atomically and audits `user.activated`.
- `authorize` never throws for ordinary denial. Missing/inactive users return a deny decision.
  Database failure throws retryable `DEPENDENCY_UNAVAILABLE`.

Authorization decisions are evaluated per call from D1. No cross-invocation in-memory cache is
allowed. Callers MAY deduplicate identical checks within one request only.

## 7. Independent test strategy

### Pure unit

- Every seed-role/permission matrix cell.
- Additive multiple roles and default deny.
- Normalized email cases.
- Final-owner invariant for demote/suspend/delete.
- State transitions and invalid transitions.

### Application with repositories

Use in-memory ports to test invite, activation, concurrent-owner role/status compare-and-swap, role
replacement, audit, optimistic concurrency, idempotency replay/collision, and rollback on audit
failure.

### Workers-runtime adapter

Apply permissions migrations to isolated D1. Test constraints, unique normalized email, foreign
keys, transaction rollback, cursor ordering, and management entrypoint methods.

### Contract suite

`permissionsContractTests(factory)` runs against:

1. the real `PermissionsEntrypoint` with local D1;
2. `FakePermissionsService` used by CRM/Projects/Notes/API/MCP tests.

It asserts return shape, actor/user resolution, decision semantics, pagination, stable errors, and
batch ordering.

### Integration

- API + real Permissions: valid Access user, uninvited 403, suspended 403, owner management.
- Each domain service + real Permissions: one allow and one deny per permission family.
- Inject a throwing fake to prove every consumer fails closed on outage.

## 8. Acceptance criteria

- No domain Worker needs a role table or permission constants outside shared contracts.
- Role changes affect the next authorization call without reauthentication.
- Last-owner protection is race-safe within D1.
- Fakes pass the same contract suite as the real entrypoint.
- No public endpoint or storage binding escapes this Worker.

## 9. Open questions

1. Should managers receive `users.manage` limited to non-owner roles? Current decision: no; only
   owners manage users in release one.
2. Should first login auto-create a read-only user for any Access-approved identity? Current
   decision: no, invitation is required.
3. Should role definitions become owner-editable in release one? Current decision: no; schema allows
   future custom roles but seed roles are fixed.
4. What display name should an invite use before first login: owner-entered (current decision) or
   the Access identity's name when available?
5. Should audit before/after snapshots retain deleted users' email, or redact it on future purge?
