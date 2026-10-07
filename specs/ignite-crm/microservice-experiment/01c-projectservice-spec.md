# Ignite CRM — Projects service specification

## 1. Purpose and boundary

The Projects service owns delivery projects and tasks, including status, priority, assignments, due
dates, project/task worklists, and the project side of won-deal conversion. Its interaction model is
intentionally Linear-like but its first-release workflow is fixed.

It does not own deals/customers, users/roles, notes, time tracking, budgets, calendars, or a generic
workflow builder.

## 2. Architecture and dependencies

```text
ProjectsEntrypoint
  → ProjectsApplicationService
    → Project and Task domains
    → ProjectRepository / AuditRepository ports → PROJECTS_DB
    → PermissionsPort (required RPC)
    → CrmReferencePort (required for linked project creation/read labels)
    → Notes reference validation is composed by API, not called on ordinary writes
```

Required service bindings are `PERMISSIONS` and `CRM`. Projects stores CRM IDs as external
references but never declares foreign keys to CRM_DB and never copies CRM rows.

## 3. RPC contract

```ts
export abstract class ProjectsContract {
  abstract health(): Promise<Health>;
  abstract getProject(actor: ActorContext, id: string): Promise<Project>;
  abstract listProjects(
    actor: ActorContext,
    query: ProjectQuery,
    page: PageRequest
  ): Promise<Page<ProjectSummary>>;
  abstract createStandaloneProject(
    actor: ActorContext,
    input: CreateProjectInput,
    meta: MutationMeta
  ): Promise<Project>;
  abstract createFromDeal(
    actor: ActorContext,
    snapshot: DealConversionSnapshot,
    meta: MutationMeta
  ): Promise<Project>;
  abstract updateProject(
    actor: ActorContext,
    id: string,
    input: UpdateProjectInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Project>;
  abstract archiveProject(
    actor: ActorContext,
    id: string,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Project>;
  abstract markSourceLinkState(
    actor: ActorContext,
    projectId: string,
    state: 'linked' | 'pending',
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Project>;
  abstract getTask(actor: ActorContext, id: string): Promise<Task>;
  abstract listTasks(actor: ActorContext, query: TaskQuery, page: PageRequest): Promise<Page<Task>>;
  abstract createTask(
    actor: ActorContext,
    projectId: string,
    input: CreateTaskInput,
    meta: MutationMeta
  ): Promise<Task>;
  abstract updateTask(
    actor: ActorContext,
    id: string,
    input: UpdateTaskInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Task>;
  abstract moveTask(
    actor: ActorContext,
    id: string,
    input: MoveTaskInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Task>;
  abstract deleteTask(
    actor: ActorContext,
    id: string,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<DeletionResult>;
  abstract getMyWork(
    actor: ActorContext,
    query: MyWorkQuery,
    page: PageRequest
  ): Promise<Page<Task>>;
  abstract getDeliverySummary(actor: ActorContext): Promise<DeliverySummary>;
  abstract listAudit(
    actor: ActorContext,
    filter: AuditFilter,
    page: PageRequest
  ): Promise<Page<ProjectAuditEvent>>;
  abstract validateResourceRefs(
    actor: ActorContext,
    refs: readonly ResourceRef[]
  ): Promise<readonly ValidatedResourceRef[]>;
  abstract getResourceLabels(
    actor: ActorContext,
    refs: readonly ResourceRef[]
  ): Promise<readonly ResourceLabel[]>;
}
```

`createFromDeal` accepts only the CRM-owned immutable snapshot shape, not an arbitrary
caller-defined company/contact/title bundle. The API obtains it from CRM in the same request.

## 4. Domain model

### 4.1 Project

`Project`: `id`, `name`, optional `description`, status `active|on_hold|completed|archived`,
optional `sourceDealId`, optional `companyId`, optional `primaryContactId`,
`sourceLinkState: 'pending'|'linked'|'not_applicable'`, `leadId`, optional `targetDate`, `version`,
timestamps/deletion.

Rules:

- Name 1–200; description 0–4,000; lead must be an active registered user (authorization service
  decides permission, user existence is resolved through actor/invite flow).
- `sourceDealId` is immutable and unique. Deal-created projects cannot change linked
  company/contact.
- `createFromDeal` requires snapshot status `won`; duplicate source deal is idempotent success if
  the immutable snapshot hash matches, otherwise `CONFLICT`.
- Standalone projects are Should-have. They use `sourceLinkState = not_applicable`; company/contact
  links are optional but validated through CRM when supplied.
- Completed may return to active; archived may not be edited except unarchive by `project.manage`.
- Archiving a project does not delete tasks or notes.

### 4.2 Task

`Task`: `id`, `projectId`, `title`, optional Markdown-free `description`, status
`todo|in_progress|in_review|done`, priority `no_priority|low|medium|high|urgent`, optional
`assigneeId`, optional `dueDate`, integer `position`, `createdBy`, `completedAt?`, `version`,
timestamps/deletion.

Rules:

- Title 1–200; description 0–8,000; dates are date-only.
- Fixed statuses and priorities are shared contract enums. Custom workflows are not first release.
- `done` stamps `completedAt`; leaving done clears it.
- Position is a sparse integer. Move accepts status plus before/after task IDs; service computes a
  new position. If no integer gap remains, it renumbers that status column transactionally.
- An assignee is represented by permissions-service user ID. Release one verifies assignability with
  Permissions `resolveUser(userId)`, which reveals only active/inactive status to trusted services;
  suspended/deleted users cannot be newly assigned. This is identity validation, not authorization
  on behalf of the assignee.
- Task deletion is soft and requires `project.manage`; completion uses update/move.

## 5. D1 schema

### `projects`

Columns implement Project above. Unique partial index on non-null `source_deal_id`; indexes on
`status`, `company_id`, `lead_id`, `(target_date,id)`, and soft deletion.

### `tasks`

Columns implement Task. Indexes:

- `(project_id, status, position, id)` for board;
- `(assignee_id, status, due_date, priority, id)` for My Work;
- `(project_id, due_date)` and deletion.

### Supporting tables

`audit_events`, `idempotency_records`, and
`conversion_attempts(source_deal_id, project_id, snapshot_hash, state, last_error_code, updated_at)`.
The conversion row is operational state, not a copy of the CRM deal.

All are STRICT with local foreign keys from tasks to projects.

## 6. Authorization

- `project.read`: read/list/labels.
- `project.write`: create/update/move tasks and edit ordinary project fields.
- `project.manage`: archive/delete tasks/change lead.
- `deal.convert`: `createFromDeal` and the restricted `markSourceLinkState` conversion transition.
  The latter requires a deal-sourced project, permits only `pending → linked` (or idempotent linked
  → linked), and cannot alter any other project field. A sales rep does not need `project.write` for
  these two conversion operations.
- `report.read`: delivery summary.
- `audit.read`: service audit list.

Projects calls Permissions before touching storage. It does not infer access from task assignment.
Release one has installation-wide visibility governed by roles, not project membership ACLs.

## 7. Deal conversion and dependency failures

`createFromDeal` is locally atomic: project, conversion attempt, audit, and idempotency result
commit together. It does not call CRM during the write because the API supplies a fresh CRM
snapshot. The project starts `pending`; after CRM backlink succeeds API calls the versioned,
idempotent `markSourceLinkState(linked)`, which writes the state, conversion attempt, audit, and
idempotency result atomically.

If API dies between steps, replay with the same source deal returns the existing pending project and
continues backlink. If CRM already points to that project, retry skips the CRM write and finalizes
Projects with the current project version. The API exposes an owner/manager retry action. No
automated scheduler is required in release one.

CRM is called by standalone-project creation to validate optional refs and by hydrated read use
cases only. A CRM outage rejects ref-bearing creation with retryable dependency error; projects
without CRM refs remain creatable. List results return stored IDs without silently asserting they
still exist.

## 8. Independent testing

### Pure unit

Project status transitions, snapshot hash/idempotency, task state/completion timestamps, priority
sorting, sparse positioning/renumber, validation limits, archived preconditions.

### Application with fakes

Inject repository, PermissionsPort, CrmReferencePort, clock, and IDs. Test allow/deny/outage,
standalone ref validation, duplicate conversion, pending→linked, stale version, audit rollback, and
idempotency collision.

### D1 adapter

Migrations/constraints, unique source deal under concurrent/replayed calls, board order, renumber
transaction, My Work sorting, report aggregates, pagination, and soft deletes.

### Contract and integration

- `projectsContractTests` runs against real entrypoint and `FakeProjectsService` used by API/MCP/CRM
  label hydration tests.
- Real Projects + fake CRM/Permissions exercises all dependency failures deterministically.
- Real Projects + real CRM + real Permissions exercises won-deal snapshot/create, while API system
  tests own the full backlink saga.
- Test timeout is finite; no live account.

## 9. Acceptance criteria

- A source deal creates at most one project under retries.
- Board and My Work ordering are deterministic and bounded.
- Projects service can be tested with no CRM or Permissions Worker by injecting contract fakes.
- The real and fake services pass one contract suite.
- No project write changes CRM data directly.

## 10. Open questions

1. Should standalone projects ship in release one or remain schema-ready Should-have functionality?
2. Confirm fixed project statuses; is `cancelled` needed separately from `archived`?
3. Confirm fixed task statuses and whether `blocked` is a status or a separate boolean/reason.
   Current decision: no blocked status in release one.
4. Can any delivery contributor assign tasks to any active user, or only managers/leads? Current
   decision: anyone with `project.write` can assign.
5. Should task descriptions support Markdown? Current decision: plain text; durable knowledge
   belongs in Notes.
6. Should a deal-created project copy deal amount/status line for display? Current decision: no;
   hydrate from CRM to avoid stale duplicated authority.
