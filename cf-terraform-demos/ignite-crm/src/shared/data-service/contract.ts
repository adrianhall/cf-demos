/**
 * @file The one grouped Data Worker contract, shared by the Application Worker (consumer) and the
 *   Data Worker (provider). Private to server code: the SPA never imports this directory. Two views
 *   of the same contract exist:
 *
 *   - {@link DataService} is the ergonomic, _throwing_ view the Application Worker codes against. A
 *     failure rejects with a {@link ServiceErrorValue}-shaped error.
 *   - {@link RpcResult} is the wire envelope the Data Worker actually returns. Every RPC method
 *     resolves to `{ ok: true, value }` or `{ ok: false, error }` instead of throwing. Expected
 *     failures (forbidden, not found, conflict) are ordinary outcomes for a data service; returning
 *     them as values keeps them out of the runtime's uncaught-exception logging, makes their
 *     serialization independent of RPC error-reconstruction rules, and lets a caller tell an
 *     answered failure from a transport failure (which still rejects).
 *     `src/application-worker/data-client.ts` converts the binding's envelope view into
 *     {@link DataService}; the fake in `tests/fakes` implements {@link DataService} directly, and
 *     the shared contract suite runs against both.
 */

import type { AuditEntityType, AuditEvent, AuditModuleName } from '../api/audit.ts';
import type {
  Company,
  CompanySummary,
  Contact,
  ContactSummary,
  CreateCompanyInput,
  CreateContactInput,
  Dashboard,
  UpdateCompanyInput,
  UserRef
} from '../api/crm.ts';
import type { CompanyDetail, ContactDetail } from '../api/customer.ts';
import type {
  CreateNoteInput,
  Note,
  NoteDetail,
  NoteLinkType,
  NoteSearchResult,
  NoteSummary,
  UpdateNoteInput
} from '../api/notes.ts';
import type {
  ConvertDealRequest,
  CreateTaskInput,
  MyWork,
  Project,
  ProjectDetail,
  ProjectStatus,
  Task,
  UpdateProjectInput,
  UpdateTaskInput
} from '../api/projects.ts';
import type {
  ActionStream,
  Activity,
  ContactNextAction,
  CreateActivityInput,
  CreateDealInput,
  Deal,
  DealDetail,
  DealStatus,
  Pipeline,
  PipelineSummary,
  SetNextActionInput,
  UpdateDealInput
} from '../api/sales.ts';
import type { Session } from '../api/session.ts';
import type {
  InviteUserInput,
  RoleDefinition,
  SetUserRolesInput,
  SetUserStatusInput,
  TeamMember
} from '../api/team.ts';
import type { ServiceErrorValue } from '../common/errors.ts';
import type { Page } from '../common/paging.ts';
import type { Permission } from '../permissions.ts';

/**
 * The verified caller of a Data Worker operation.
 *
 * Built by the Application Worker from the verified Access identity plus
 * {@link DataService.resolveActor}. Business input never carries identity; the Data Worker re-checks
 * the user's status and permissions on every call rather than trusting this value as
 * authorization.
 */
export interface ActorContext {
  /**
   * Verified, normalised e-mail.
   */
  readonly email: string;
  /**
   * Installation-local user identifier.
   */
  readonly userId: string;
  /**
   * Request identifier used for logs and audit correlation.
   */
  readonly requestId: string;
  /**
   * Transport the request arrived on; `mcp` is reserved for a later release.
   */
  readonly channel: 'api';
}

/**
 * Per-mutation metadata.
 */
export interface MutationMeta {
  /**
   * Client-chosen key making the mutation safe to retry.
   */
  readonly idempotencyKey: string;
}

/**
 * A user resolved from a verified identity.
 */
export interface ResolvedActor {
  /**
   * Installation-local user identifier.
   */
  readonly userId: string;
  /**
   * Normalised e-mail.
   */
  readonly email: string;
  /**
   * Display name.
   */
  readonly displayName: string;
  /**
   * Always active: inactive users are refused rather than resolved.
   */
  readonly status: 'active';
}

/**
 * A user looked up by identifier.
 */
export interface ResolvedUser {
  /**
   * User identifier.
   */
  readonly userId: string;
  /**
   * Display name.
   */
  readonly displayName: string;
  /**
   * Whether the user may currently act.
   */
  readonly status: 'active' | 'inactive';
}

/**
 * A question for the Permissions module.
 */
export interface AuthorizationRequest {
  /**
   * The user asking.
   */
  readonly userId: string;
  /**
   * The permission needed.
   */
  readonly permission: Permission;
  /**
   * Optional resource context for ownership-aware rules.
   */
  readonly resource?: {
    /**
     * Resource type, e.g. `contact`.
     */
    readonly type: string;
    /**
     * Resource identifier.
     */
    readonly id?: string;
    /**
     * Owning user, when the resource has one.
     */
    readonly ownerId?: string;
  };
}

/**
 * The Permissions module's answer.
 */
export interface AuthorizationDecision {
  /**
   * Whether the action may proceed.
   */
  readonly allowed: boolean;
  /**
   * Why.
   */
  readonly reason: 'allowed' | 'no-role' | 'missing-permission' | 'inactive-user';
}

/**
 * Data Worker health.
 */
export interface DataHealth {
  /**
   * Always `ok` when the Worker and its database answered.
   */
  readonly status: 'ok';
  /**
   * Name of the most recently applied migration.
   */
  readonly migration: string;
}

/**
 * List options passed to the Data Worker after API validation.
 */
export interface ListOptions {
  /**
   * Optional search term.
   */
  readonly q?: string;
  /**
   * Page size, 1–100.
   */
  readonly limit: number;
  /**
   * Cursor from the previous page.
   */
  readonly cursor?: string;
}

/**
 * Deal list options passed to the Data Worker after API validation.
 */
export interface DealListOptions extends ListOptions {
  /**
   * Restrict to one outcome.
   */
  readonly status?: DealStatus;
}

/**
 * Sales operations of the CRM module: pipeline, deals, activities, next actions, and reports.
 */
export interface SalesPort {
  /**
   * The sales pipeline and its stages.
   *
   * @param actor The caller.
   */
  getPipeline(actor: ActorContext): Promise<Pipeline>;
  /**
   * Active users a deal may be assigned to.
   *
   * @param actor The caller.
   */
  listAssignees(actor: ActorContext): Promise<UserRef[]>;
  /**
   * List or search deals by title, company, or primary contact, ordered by title.
   *
   * @param actor The caller.
   * @param options Search, status filter, and paging.
   */
  listDeals(actor: ActorContext, options: DealListOptions): Promise<Page<Deal>>;
  /**
   * Read one deal with its activities and history.
   *
   * @param actor The caller.
   * @param id Deal identifier.
   */
  getDeal(actor: ActorContext, id: string): Promise<DealDetail>;
  /**
   * Create a deal.
   *
   * @param actor The caller.
   * @param input Validated deal fields.
   * @param meta Idempotency metadata.
   */
  createDeal(actor: ActorContext, input: CreateDealInput, meta: MutationMeta): Promise<Deal>;
  /**
   * Update a deal if it is still at the expected version.
   *
   * @param actor The caller.
   * @param id Deal identifier.
   * @param input Fields to change.
   * @param expectedVersion Version the caller last read.
   * @param meta Idempotency metadata.
   */
  updateDeal(
    actor: ActorContext,
    id: string,
    input: UpdateDealInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Deal>;
  /**
   * Log a call or meeting linked to contacts and optionally a company and deal, atomically.
   *
   * @param actor The caller, who becomes the author.
   * @param input Validated activity fields.
   * @param meta Idempotency metadata.
   */
  createActivity(
    actor: ActorContext,
    input: CreateActivityInput,
    meta: MutationMeta
  ): Promise<Activity>;
  /**
   * Set or replace a contact's one open next action, assigned to the caller.
   *
   * @param actor The caller.
   * @param contactId Contact identifier.
   * @param input The action.
   * @param expectedVersion Version of the open action being replaced, or `null` when the caller
   *   believes there is none.
   * @param meta Idempotency metadata.
   */
  setContactNextAction(
    actor: ActorContext,
    contactId: string,
    input: SetNextActionInput,
    expectedVersion: number | null,
    meta: MutationMeta
  ): Promise<ContactNextAction>;
  /**
   * Mark a contact's open next action done.
   *
   * @param actor The caller.
   * @param contactId Contact identifier.
   * @param expectedVersion Version of the open action.
   * @param meta Idempotency metadata.
   */
  completeContactNextAction(
    actor: ActorContext,
    contactId: string,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<ContactNextAction>;
  /**
   * The caller's prioritized contact and deal next actions.
   *
   * @param actor The caller.
   */
  actionStream(actor: ActorContext): Promise<ActionStream>;
  /**
   * Pipeline totals by stage and outcome.
   *
   * @param actor The caller.
   */
  pipelineSummary(actor: ActorContext): Promise<PipelineSummary>;
}

/**
 * Contact and company operations of the CRM module.
 */
export interface ContactsPort {
  /**
   * Headline counts and recent contacts.
   *
   * @param actor The caller.
   */
  dashboard(actor: ActorContext): Promise<Dashboard>;
  /**
   * List or search active contacts by display name or e-mail, ordered by name.
   *
   * @param actor The caller.
   * @param options Search and paging.
   */
  listContacts(actor: ActorContext, options: ListOptions): Promise<Page<ContactSummary>>;
  /**
   * Read one active contact's customer timeline: deals, activities, next action, and history.
   *
   * @param actor The caller.
   * @param id Contact identifier.
   */
  getContact(actor: ActorContext, id: string): Promise<ContactDetail>;
  /**
   * Create a contact, reusing or creating its company.
   *
   * @param actor The caller, who becomes the owner.
   * @param input Validated contact fields.
   * @param meta Idempotency metadata.
   */
  createContact(
    actor: ActorContext,
    input: CreateContactInput,
    meta: MutationMeta
  ): Promise<Contact>;
  /**
   * List or search active companies by name, ordered by name.
   *
   * @param actor The caller.
   * @param options Search and paging.
   */
  listCompanies(actor: ActorContext, options: ListOptions): Promise<Page<CompanySummary>>;
  /**
   * Read one active company's customer timeline: contacts, deals, activities, and history.
   *
   * @param actor The caller.
   * @param id Company identifier.
   */
  getCompany(actor: ActorContext, id: string): Promise<CompanyDetail>;
  /**
   * Create a company.
   *
   * @param actor The caller.
   * @param input Validated company fields.
   * @param meta Idempotency metadata.
   */
  createCompany(
    actor: ActorContext,
    input: CreateCompanyInput,
    meta: MutationMeta
  ): Promise<Company>;
  /**
   * Update a company if it is still at the expected version.
   *
   * @param actor The caller.
   * @param id Company identifier.
   * @param input Fields to change.
   * @param expectedVersion Version the caller last read.
   * @param meta Idempotency metadata.
   */
  updateCompany(
    actor: ActorContext,
    id: string,
    input: UpdateCompanyInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Company>;
}

/**
 * CRM module operations: contacts and companies plus the sales workflow, behind one module group.
 */
export interface CrmPort extends ContactsPort, SalesPort {}

/**
 * Project list options passed to the Data Worker after API validation.
 */
export interface ProjectListOptions extends ListOptions {
  /**
   * Restrict to one lifecycle state.
   */
  readonly status?: ProjectStatus;
}

/**
 * Projects module operations: won-deal conversion, projects, tasks, and the personal worklist.
 */
export interface ProjectsPort {
  /**
   * List or search projects by project, company, or contact name, ordered by name.
   *
   * @param actor The caller.
   * @param options Search, status filter, and paging.
   */
  listProjects(actor: ActorContext, options: ProjectListOptions): Promise<Page<Project>>;
  /**
   * Read one project with its tasks (board order) and history.
   *
   * @param actor The caller.
   * @param id Project identifier.
   */
  getProject(actor: ActorContext, id: string): Promise<ProjectDetail>;
  /**
   * Convert a won, unconverted deal into a linked project in one atomic write: the project, the
   * conversion record, the deal's back-link, audit, and the idempotency result commit together.
   *
   * @param actor The caller (needs `deal.convert`).
   * @param dealId Deal identifier.
   * @param input Optional name, lead, and target date.
   * @param expectedVersion Deal version the caller last read.
   * @param meta Idempotency metadata.
   */
  convertDeal(
    actor: ActorContext,
    dealId: string,
    input: ConvertDealRequest,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Project>;
  /**
   * Update a project if it is still at the expected version.
   *
   * @param actor The caller.
   * @param id Project identifier.
   * @param input Fields to change.
   * @param expectedVersion Version the caller last read.
   * @param meta Idempotency metadata.
   */
  updateProject(
    actor: ActorContext,
    id: string,
    input: UpdateProjectInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Project>;
  /**
   * Add a task to the end of its status column.
   *
   * @param actor The caller.
   * @param projectId Project identifier.
   * @param input Task fields.
   * @param meta Idempotency metadata.
   */
  createTask(
    actor: ActorContext,
    projectId: string,
    input: CreateTaskInput,
    meta: MutationMeta
  ): Promise<Task>;
  /**
   * Update a task if it is still at the expected version. A status change moves the task to the end
   * of its new column (the keyboard-first board operation).
   *
   * @param actor The caller.
   * @param id Task identifier.
   * @param input Fields to change.
   * @param expectedVersion Version the caller last read.
   * @param meta Idempotency metadata.
   */
  updateTask(
    actor: ActorContext,
    id: string,
    input: UpdateTaskInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Task>;
  /**
   * The caller's open assigned tasks across projects.
   *
   * @param actor The caller.
   */
  myWork(actor: ActorContext): Promise<MyWork>;
}

/**
 * Note list options passed to the Data Worker after API validation.
 */
export interface NoteListOptions {
  /**
   * Restrict to notes linked to a record of this type; requires `linkId`.
   */
  readonly linkType?: NoteLinkType;
  /**
   * Restrict to notes linked to this record; requires `linkType`.
   */
  readonly linkId?: string;
  /**
   * Page size, 1–100.
   */
  readonly limit: number;
  /**
   * Cursor from the previous page.
   */
  readonly cursor?: string;
}

/**
 * Notes module operations: multi-linked Markdown notes, linked-record feeds, and search.
 */
export interface NotesPort {
  /**
   * List notes, most recently updated first, optionally only those linked to one record (the
   * context feed on a contact, company, deal, or project page).
   *
   * @param actor The caller (needs `note.read`).
   * @param options Optional linked record and paging.
   */
  listNotes(actor: ActorContext, options: NoteListOptions): Promise<Page<NoteSummary>>;
  /**
   * Read one note with its links and history.
   *
   * @param actor The caller (needs `note.read`).
   * @param id Note identifier.
   */
  getNote(actor: ActorContext, id: string): Promise<NoteDetail>;
  /**
   * Full-text search over note titles and bodies, best match first, at most 50 hits. The text is
   * tokenized into safe prefix terms; it is never used as an FTS expression.
   *
   * @param actor The caller (needs `note.read`).
   * @param text Search text, 2–200 characters.
   */
  searchNotes(actor: ActorContext, text: string): Promise<NoteSearchResult>;
  /**
   * Create a note linked to one or more records, atomically: the note, every link, audit, and the
   * idempotency result commit together.
   *
   * @param actor The caller, who becomes the author (needs `note.write` and read access to each
   *   linked record type).
   * @param input Title, Markdown body, and links.
   * @param meta Idempotency metadata.
   */
  createNote(actor: ActorContext, input: CreateNoteInput, meta: MutationMeta): Promise<Note>;
  /**
   * Update a note's text and/or replace its link set if it is still at the expected version. An
   * author may edit their own note; editing another's needs `note.manage`.
   *
   * @param actor The caller.
   * @param id Note identifier.
   * @param input Fields to change; `links` replaces the whole set.
   * @param expectedVersion Version the caller last read.
   * @param meta Idempotency metadata.
   */
  updateNote(
    actor: ActorContext,
    id: string,
    input: UpdateNoteInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Note>;
}

/**
 * Team directory options passed to the Data Worker after API validation.
 */
export interface TeamListOptions {
  /**
   * Search over display name and e-mail.
   */
  readonly q?: string;
  /**
   * Page size, 1–100.
   */
  readonly limit: number;
  /**
   * Cursor from the previous page.
   */
  readonly cursor?: string;
}

/**
 * Audit trail filters and paging passed to the Data Worker after API validation. Filters combine
 * with AND.
 */
export interface AuditListOptions {
  /**
   * Only events from this module.
   */
  readonly module?: AuditModuleName;
  /**
   * Only events about this entity type.
   */
  readonly entityType?: AuditEntityType;
  /**
   * Only events about this entity.
   */
  readonly entityId?: string;
  /**
   * Only events by this user.
   */
  readonly actorId?: string;
  /**
   * Page size, 1–100.
   */
  readonly limit: number;
  /**
   * Cursor from the previous page.
   */
  readonly cursor?: string;
}

/**
 * Permissions module operations beyond actor resolution and authorization: the session, team
 * administration, and the shared audit trail.
 */
export interface PermissionsPort {
  /**
   * The caller's user, roles, and capability hints.
   *
   * @param actor The caller.
   */
  getSession(actor: ActorContext): Promise<Session>;
  /**
   * The fixed role catalogue with each role's permissions.
   *
   * @param actor The caller (needs `users.read`).
   */
  listRoles(actor: ActorContext): Promise<RoleDefinition[]>;
  /**
   * The team directory, ordered by display name.
   *
   * @param actor The caller (needs `users.read`).
   * @param options Search and paging.
   */
  listTeam(actor: ActorContext, options: TeamListOptions): Promise<Page<TeamMember>>;
  /**
   * Add a teammate by Access e-mail with their initial roles. No e-mail is sent: the record means
   * the teammate's first sign-in already has these roles.
   *
   * @param actor The caller (needs `users.manage` and `roles.assign`).
   * @param input E-mail, display name, and roles.
   * @param meta Idempotency metadata.
   */
  inviteUser(actor: ActorContext, input: InviteUserInput, meta: MutationMeta): Promise<TeamMember>;
  /**
   * Replace a teammate's roles if their record is still at the expected version. Takes effect on
   * their next request. At least one active owner always remains.
   *
   * @param actor The caller (needs `roles.assign`).
   * @param userId The teammate.
   * @param input The complete new role set.
   * @param expectedVersion Version the caller last read.
   * @param meta Idempotency metadata.
   */
  setUserRoles(
    actor: ActorContext,
    userId: string,
    input: SetUserRolesInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<TeamMember>;
  /**
   * Suspend or reactivate a teammate if their record is still at the expected version. A suspended
   * user is refused on their next request. At least one active owner always remains.
   *
   * @param actor The caller (needs `users.manage`).
   * @param userId The teammate.
   * @param input The new status.
   * @param expectedVersion Version the caller last read.
   * @param meta Idempotency metadata.
   */
  setUserStatus(
    actor: ActorContext,
    userId: string,
    input: SetUserStatusInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<TeamMember>;
  /**
   * The shared audit trail, newest first, with allowlisted metadata only.
   *
   * @param actor The caller (needs `audit.read`).
   * @param options Filters and paging.
   */
  listAudit(actor: ActorContext, options: AuditListOptions): Promise<Page<AuditEvent>>;
}

/**
 * The grouped Data Worker contract (specification §5.2), in its throwing form.
 */
export interface DataService {
  /**
   * Report Data Worker and database health.
   */
  health(): Promise<DataHealth>;
  /**
   * Resolve a verified e-mail to an active user, provisioning it on first sight.
   *
   * @param email Verified Access e-mail.
   * @param requestId Request identifier for audit correlation.
   */
  resolveActor(email: string, requestId: string): Promise<ResolvedActor>;
  /**
   * Look up a user by identifier.
   *
   * @param userId User identifier.
   */
  resolveUser(userId: string): Promise<ResolvedUser>;
  /**
   * Answer an authorization question without throwing on denial.
   *
   * @param request The question.
   */
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
  /**
   * CRM module.
   */
  readonly crm: CrmPort;
  /**
   * Projects module.
   */
  readonly projects: ProjectsPort;
  /**
   * Notes module.
   */
  readonly notes: NotesPort;
  /**
   * Permissions module.
   */
  readonly permissions: PermissionsPort;
}

/**
 * The envelope every Data Worker RPC method resolves to.
 */
export type RpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ServiceErrorValue };

/**
 * Map every method of a port to its envelope-returning RPC form.
 */
export type Enveloped<T> = {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Promise<RpcResult<R>>
    : never;
};
