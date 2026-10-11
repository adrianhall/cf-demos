/**
 * @file Projects module use cases: atomic won-deal conversion, project edits, tasks, and the
 *   personal worklist. Each operation follows the shared order: validate input → authorize →
 *   (mutations) replay check → domain rules over one read snapshot → one atomic repository write
 *   including audit and idempotency rows.
 *
 *   ## Conversion is one transaction
 *
 *   Because every module shares one D1 database (specification §7.1), converting a won deal is a
 *   single write set: the project, the conversion record, the deal's versioned back-link, the audit
 *   events, and the idempotency result — plus, for "Mark won" with conversion, closing the deal as
 *   won. Guards inside that write set re-check that the deal is still eligible, unconverted, and at
 *   the version the caller saw, so a concurrent conversion or edit rolls the whole conversion back.
 *   There is no pending state, retry endpoint, or saga — the contrast with
 *   `specs/ignite-crm/microservice-experiment/01c-projectservice-spec.md` §7.
 */

import * as v from 'valibot';
import type { UserRef } from '../../../shared/api/crm.ts';
import {
  type ConvertDealRequest,
  ConvertDealInputSchema,
  type CreateTaskInput,
  CreateTaskInputSchema,
  MY_WORK_LIMIT,
  type MyWork,
  type Project,
  type ProjectDetail,
  PROJECT_TASK_LIMIT,
  ProjectStatusSchema,
  type ProjectStatus,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type UpdateProjectInput,
  UpdateProjectInputSchema,
  type UpdateTaskInput,
  UpdateTaskInputSchema
} from '../../../shared/api/projects.ts';
import {
  DELIVERY_REPORT_PROJECT_LIMIT,
  type DeliveryReport,
  type DeliveryReportFilter,
  DeliveryReportFilterSchema
} from '../../../shared/api/reports.ts';
import type { DealStatus } from '../../../shared/api/sales.ts';
import { serviceError } from '../../../shared/common/errors.ts';
import { DEFAULT_PAGE_SIZE, type Page, PageRequestSchema } from '../../../shared/common/paging.ts';
import type {
  ActorContext,
  MutationMeta,
  ProjectListOptions,
  ProjectsPort
} from '../../../shared/data-service/contract.ts';
import { SearchTermSchema, VersionSchema } from '../../../shared/validation/fields.ts';
import { calendarDate } from '../../domain/crm/sales.ts';
import {
  appendPosition,
  archivedEditRefused,
  completionStamp,
  conversionBlocker,
  isAcceptableNewDate,
  needsManage
} from '../../domain/projects/delivery.ts';
import { sumTaskCounts } from '../../domain/reports/reports.ts';
import { decodeCursor, encodeCursor, type ListCriteria } from '../crm/crm-service.ts';
import type { Authorizer } from '../permissions/permissions-service.ts';
import {
  type IdempotencyRepository,
  IdempotentMutation,
  type MutationEnvelope
} from '../shared/mutations.ts';
import type { Runtime } from '../shared/runtime.ts';
import { validate, validateActor, validateId, validateIdempotencyKey } from '../shared/validate.ts';

/**
 * Number of history entries returned with a project.
 */
const HISTORY_LIMIT = 20;

/**
 * A deal as conversion needs it: outcome, link, version, and the customer it was sold to.
 */
export interface ConvertibleDeal {
  /**
   * Deal identifier.
   */
  readonly id: string;
  /**
   * Deal title (the default project name).
   */
  readonly title: string;
  /**
   * Outcome.
   */
  readonly status: DealStatus;
  /**
   * Project already created from it, if any.
   */
  readonly projectId: string | null;
  /**
   * Optimistic-concurrency version.
   */
  readonly version: number;
  /**
   * Customer company, if any.
   */
  readonly company: { readonly id: string; readonly name: string } | null;
  /**
   * The deal's primary contact.
   */
  readonly primaryContact: { readonly id: string; readonly displayName: string };
}

/**
 * Project columns as stored.
 */
export interface ProjectRow {
  /**
   * Identifier.
   */
  readonly id: string;
  /**
   * Name.
   */
  readonly name: string;
  /**
   * Description.
   */
  readonly description: string | null;
  /**
   * Lifecycle state.
   */
  readonly status: ProjectStatus;
  /**
   * Source deal (immutable).
   */
  readonly sourceDealId: string | null;
  /**
   * Customer company.
   */
  readonly companyId: string | null;
  /**
   * Customer contact.
   */
  readonly primaryContactId: string | null;
  /**
   * Delivery lead.
   */
  readonly leadId: string;
  /**
   * Target date.
   */
  readonly targetDate: string | null;
}

/**
 * Task columns as stored.
 */
export interface TaskRow {
  /**
   * Identifier.
   */
  readonly id: string;
  /**
   * Project.
   */
  readonly projectId: string;
  /**
   * Title.
   */
  readonly title: string;
  /**
   * Description.
   */
  readonly description: string | null;
  /**
   * Status.
   */
  readonly status: TaskStatus;
  /**
   * Priority.
   */
  readonly priority: TaskPriority;
  /**
   * Assignee.
   */
  readonly assigneeId: string | null;
  /**
   * Due date.
   */
  readonly dueDate: string | null;
  /**
   * Column position.
   */
  readonly position: number;
  /**
   * Creator.
   */
  readonly createdBy: string;
  /**
   * Completion stamp.
   */
  readonly completedAt: string | null;
}

/**
 * One project's delivery report row as stored.
 */
export type DeliveryRow = DeliveryReport['projects'][number];

/**
 * Storage port for the projects use cases.
 */
export interface ProjectsRepository extends IdempotencyRepository {
  /**
   * One active user.
   *
   * @param userId User id.
   * @returns The reference, or `null` when absent or suspended.
   */
  activeUser(userId: string): Promise<UserRef | null>;
  /**
   * The deal fields conversion needs.
   *
   * @param dealId Deal id.
   * @returns The deal, or `null` when absent or deleted.
   */
  convertibleDeal(dealId: string): Promise<ConvertibleDeal | null>;
  /**
   * One page of active projects ordered by lower-cased name then id.
   *
   * @param criteria Search and keyset position.
   * @param status Lifecycle filter.
   * @returns Up to `limit + 1` projects with sort keys.
   */
  listProjects(
    criteria: ListCriteria,
    status: ProjectStatus | null
  ): Promise<Array<Project & { sortKey: string }>>;
  /**
   * Read an active project.
   *
   * @param id Project id.
   * @returns The project, or `null`.
   */
  getProject(id: string): Promise<Project | null>;
  /**
   * A project's tasks in board order.
   *
   * @param projectId Project id.
   * @param limit Maximum rows.
   * @returns Tasks.
   */
  projectTasks(projectId: string, limit: number): Promise<Task[]>;
  /**
   * Active projects whose customer contact is the given contact, newest first.
   *
   * @param contactId Contact id.
   * @param limit Maximum rows.
   * @returns Projects.
   */
  contactProjects(contactId: string, limit: number): Promise<Project[]>;
  /**
   * Active projects for a company, newest first.
   *
   * @param companyId Company id.
   * @param limit Maximum rows.
   * @returns Projects.
   */
  companyProjects(companyId: string, limit: number): Promise<Project[]>;
  /**
   * Read an active task.
   *
   * @param id Task id.
   * @returns The task, or `null`.
   */
  getTask(id: string): Promise<Task | null>;
  /**
   * The highest position in a status column.
   *
   * @param projectId Project id.
   * @param status Column.
   * @returns The position, or `null` when the column is empty.
   */
  lastPosition(projectId: string, status: TaskStatus): Promise<number | null>;
  /**
   * A user's open assigned tasks in non-archived projects, worklist ordered.
   *
   * @param userId The user.
   * @param limit Maximum rows.
   * @returns Tasks.
   */
  myWork(userId: string, limit: number): Promise<Task[]>;
  /**
   * Delivery report rows: every matching project's task counts and overdue count, most open work
   * first.
   *
   * @param filter Project status and optional lead.
   * @param today Today's calendar date (tasks due before it and not done are overdue).
   * @returns One row per matching project, uncapped (a small business has tens of projects; the
   *   service caps the rows it returns but totals all of them).
   */
  deliveryRows(
    filter: { readonly status: ProjectStatus; readonly leadId: string | null },
    today: string
  ): Promise<DeliveryRow[]>;
  /**
   * Any user, active or suspended, for labelling a report filter.
   *
   * @param userId User id.
   * @returns The reference, or `null` when no such user exists.
   */
  userRef(userId: string): Promise<UserRef | null>;
  /**
   * Recent history for an entity.
   *
   * @param entityType Entity type.
   * @param entityId Entity id.
   * @param limit Maximum entries.
   * @returns Entries, newest first.
   */
  history(entityType: string, entityId: string, limit: number): Promise<ProjectDetail['history']>;
  /**
   * Atomically convert a deal: insert the project and conversion record, link the deal if it is
   * still won (or, with `markWon`, still pending — it is then closed as won in the same write),
   * unconverted, and at `expectedDealVersion`, and write the envelope rows.
   *
   * @param write The rows.
   * @returns Once committed.
   * @throws {Error} `VERSION_MISMATCH` when the deal changed, `CONFLICT` when it was converted
   *   concurrently, `NOT_FOUND` when the lead was suspended, or `DEPENDENCY_FAILURE`.
   */
  convert(write: {
    project: ProjectRow;
    expectedDealVersion: number;
    markWon: boolean;
    at: string;
    envelope: MutationEnvelope;
  }): Promise<void>;
  /**
   * Atomically replace a project's editable fields if it is still at `expectedVersion`.
   *
   * @param write The new state.
   * @returns Once committed.
   * @throws {Error} `VERSION_MISMATCH`, `NOT_FOUND` (lead suspended), or `DEPENDENCY_FAILURE`.
   */
  updateProject(write: {
    project: ProjectRow;
    expectedVersion: number;
    at: string;
    envelope: MutationEnvelope;
  }): Promise<void>;
  /**
   * Atomically insert a task, guarding that its project is not archived and its assignee active.
   *
   * @param write The rows.
   * @returns Once committed.
   * @throws {Error} `CONFLICT` (project archived), `NOT_FOUND`, or `DEPENDENCY_FAILURE`.
   */
  insertTask(write: { task: TaskRow; at: string; envelope: MutationEnvelope }): Promise<void>;
  /**
   * Atomically replace a task's fields if it is still at `expectedVersion`.
   *
   * @param write The new state.
   * @returns Once committed.
   * @throws {Error} `VERSION_MISMATCH`, `CONFLICT` (project archived), `NOT_FOUND`, or
   *   `DEPENDENCY_FAILURE`.
   */
  updateTask(write: {
    task: TaskRow;
    expectedVersion: number;
    at: string;
    envelope: MutationEnvelope;
  }): Promise<void>;
}

/**
 * Installation settings the delivery rules need.
 */
export interface ProjectsSettings {
  /**
   * IANA time zone that defines "today".
   */
  readonly timezone: string;
}

/**
 * Schema for project list options crossing RPC.
 */
const ProjectListOptionsSchema = v.strictObject({
  q: v.optional(SearchTermSchema),
  status: v.optional(ProjectStatusSchema),
  ...PageRequestSchema.entries
});

/**
 * Throw a validation failure on one field.
 *
 * @param field Field name.
 * @param message Message.
 * @param requestId Request identifier.
 * @returns Never.
 * @throws {Error} Always: a `VALIDATION_FAILED` service error.
 */
function invalid(field: string, message: string, requestId: string): never {
  throw serviceError('VALIDATION_FAILED', message, { requestId, fields: { [field]: message } });
}

/**
 * Project a project onto its stored columns.
 *
 * @param project The project.
 * @returns The row.
 */
function toProjectRow(project: Project): ProjectRow {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    sourceDealId: project.sourceDeal?.id ?? null,
    companyId: project.company?.id ?? null,
    primaryContactId: project.primaryContact?.id ?? null,
    leadId: project.lead.id,
    targetDate: project.targetDate
  };
}

/**
 * Project a task onto its stored columns.
 *
 * @param task The task.
 * @returns The row.
 */
function toTaskRow(task: Task): TaskRow {
  return {
    id: task.id,
    projectId: task.project.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    assigneeId: task.assignee?.id ?? null,
    dueDate: task.dueDate,
    position: task.position,
    createdBy: task.createdBy.id,
    completedAt: task.completedAt
  };
}

/**
 * Projects application service.
 */
export class ProjectsService implements ProjectsPort {
  /**
   * @param repository Storage port.
   * @param authorizer Permissions capability.
   * @param runtime Clock and id source.
   * @param settings Installation time zone.
   */
  constructor(
    private readonly repository: ProjectsRepository,
    private readonly authorizer: Authorizer,
    private readonly runtime: Runtime,
    private readonly settings: ProjectsSettings
  ) {}

  /**
   * @inheritdoc
   */
  async listProjects(actor: ActorContext, options: ProjectListOptions): Promise<Page<Project>> {
    const caller = validateActor(actor);
    const parsed = validate(
      ProjectListOptionsSchema,
      options ?? { limit: DEFAULT_PAGE_SIZE },
      caller.requestId
    );
    const criteria: ListCriteria = {
      q: parsed.q?.toLowerCase() ?? null,
      limit: parsed.limit,
      after: parsed.cursor === undefined ? null : decodeCursor(parsed.cursor, caller.requestId)
    };
    await this.authorizer.require(caller, 'project.read');
    const rows = await this.repository.listProjects(criteria, parsed.status ?? null);
    const visible = rows.slice(0, criteria.limit);
    const last = visible.at(-1);
    return {
      items: visible.map(({ sortKey: _sortKey, ...project }) => project),
      nextCursor:
        rows.length > criteria.limit && last !== undefined
          ? encodeCursor(last.sortKey, last.id)
          : null
    };
  }

  /**
   * @inheritdoc
   */
  async getProject(actor: ActorContext, id: string): Promise<ProjectDetail> {
    const caller = validateActor(actor);
    const projectId = validateId(id, caller.requestId);
    await this.authorizer.require(caller, 'project.read');
    const project = await this.repository.getProject(projectId);
    if (project === null) {
      throw serviceError('NOT_FOUND', 'Project not found.', { requestId: caller.requestId });
    }
    const [tasks, history] = await Promise.all([
      this.repository.projectTasks(projectId, PROJECT_TASK_LIMIT),
      this.repository.history('project', projectId, HISTORY_LIMIT)
    ]);
    return { project, tasks, history };
  }

  /**
   * @inheritdoc
   */
  async convertDeal(
    actor: ActorContext,
    dealId: string,
    input: ConvertDealRequest,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Project> {
    const caller = validateActor(actor);
    const id = validateId(dealId, caller.requestId);
    const fields = validate(ConvertDealInputSchema, input ?? {}, caller.requestId);
    const version = validate(VersionSchema, expectedVersion, caller.requestId);
    const key = validateIdempotencyKey(meta?.idempotencyKey, caller.requestId);
    await this.authorizer.require(caller, 'deal.convert');

    const mutation = await IdempotentMutation.begin(
      'projects.convertDeal',
      caller,
      { idempotencyKey: key },
      { dealId: id, fields, version },
      this.runtime
    );
    const replayed = await mutation.replay<Project>(this.repository);
    if (replayed !== undefined) {
      return replayed;
    }

    const deal = await this.repository.convertibleDeal(id);
    if (deal === null) {
      throw serviceError('NOT_FOUND', 'Deal not found.', { requestId: caller.requestId });
    }
    // An already-converted deal is reported before a stale version: the caller's intent is already
    // satisfied and the message tells them so, rather than asking them to reload and try again.
    const blocker = conversionBlocker(deal, fields.markWon);
    if (blocker !== null) {
      throw serviceError('CONFLICT', blocker, { requestId: caller.requestId });
    }
    // `deal.convert` authorizes project creation, not closing a pending sale. Keep the existing
    // `crm.write` check for a win even if a future role receives conversion without write access.
    if (fields.markWon && deal.status === 'pending') {
      await this.authorizer.require(caller, 'crm.write');
    }
    if (deal.version !== version) {
      throw serviceError(
        'VERSION_MISMATCH',
        'The deal was changed by someone else. Reload it and try again.',
        { requestId: caller.requestId }
      );
    }
    const now = this.runtime.now();
    const at = now.toISOString();
    if (!isAcceptableNewDate(fields.targetDate, calendarDate(now, this.settings.timezone))) {
      invalid('targetDate', 'The target date cannot be in the past.', caller.requestId);
    }
    const lead = await this.requireUser(fields.leadId ?? caller.userId, 'leadId', caller.requestId);
    // Winning happens only when the deal is still pending; an already-won deal is just converted.
    const winning = fields.markWon && deal.status === 'pending';

    const project: Project = {
      id: this.runtime.newId(),
      name: fields.name ?? deal.title,
      description: null,
      status: 'active',
      sourceDeal: { id: deal.id, title: deal.title },
      company: deal.company,
      primaryContact: deal.primaryContact,
      lead,
      targetDate: fields.targetDate,
      taskCounts: { todo: 0, in_progress: 0, in_review: 0, done: 0 },
      version: 1,
      createdAt: at,
      updatedAt: at
    };
    await this.repository.convert({
      project: toProjectRow(project),
      expectedDealVersion: version,
      markWon: winning,
      at,
      envelope: mutation.envelope(
        project,
        [
          mutation.audit(
            'projects',
            'project',
            project.id,
            'created-from-deal',
            { dealId: deal.id, leadId: lead.id },
            at
          ),
          ...(winning
            ? [mutation.audit('crm', 'deal', deal.id, 'won', { viaConversion: true }, at)]
            : []),
          mutation.audit('crm', 'deal', deal.id, 'converted', { projectId: project.id }, at)
        ],
        now
      )
    });
    return project;
  }

  /**
   * @inheritdoc
   */
  async updateProject(
    actor: ActorContext,
    id: string,
    input: UpdateProjectInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Project> {
    const caller = validateActor(actor);
    const projectId = validateId(id, caller.requestId);
    const fields = validate(UpdateProjectInputSchema, input, caller.requestId);
    const version = validate(VersionSchema, expectedVersion, caller.requestId);
    const key = validateIdempotencyKey(meta?.idempotencyKey, caller.requestId);
    await this.authorizer.require(caller, 'project.write');

    const mutation = await IdempotentMutation.begin(
      'projects.updateProject',
      caller,
      { idempotencyKey: key },
      { projectId, fields, version },
      this.runtime
    );
    const replayed = await mutation.replay<Project>(this.repository);
    if (replayed !== undefined) {
      return replayed;
    }
    const current = await this.repository.getProject(projectId);
    if (current === null) {
      throw serviceError('NOT_FOUND', 'Project not found.', { requestId: caller.requestId });
    }
    if (current.version !== version) {
      throw serviceError(
        'VERSION_MISMATCH',
        'The project was changed by someone else. Reload it and try again.',
        { requestId: caller.requestId }
      );
    }
    if (
      needsManage(
        { status: current.status, leadId: current.lead.id },
        {
          ...(fields.status === undefined ? {} : { status: fields.status }),
          ...(fields.leadId === undefined ? {} : { leadId: fields.leadId })
        }
      )
    ) {
      await this.authorizer.require(caller, 'project.manage');
    }
    if (archivedEditRefused(current.status, fields.status)) {
      throw serviceError('CONFLICT', 'An archived project is read-only. Unarchive it first.', {
        requestId: caller.requestId
      });
    }
    const now = this.runtime.now();
    const at = now.toISOString();
    if (
      fields.targetDate !== undefined
      && fields.targetDate !== current.targetDate
      && !isAcceptableNewDate(fields.targetDate, calendarDate(now, this.settings.timezone))
    ) {
      invalid('targetDate', 'The target date cannot be in the past.', caller.requestId);
    }
    const lead =
      fields.leadId === undefined || fields.leadId === current.lead.id
        ? current.lead
        : await this.requireUser(fields.leadId, 'leadId', caller.requestId);

    const project: Project = {
      ...current,
      name: fields.name ?? current.name,
      description: fields.description === undefined ? current.description : fields.description,
      status: fields.status ?? current.status,
      lead,
      targetDate: fields.targetDate === undefined ? current.targetDate : fields.targetDate,
      version: current.version + 1,
      updatedAt: at
    };
    const action =
      project.status === current.status
        ? 'updated'
        : project.status === 'archived'
          ? 'archived'
          : current.status === 'archived'
            ? 'unarchived'
            : `status-${project.status}`;
    await this.repository.updateProject({
      project: toProjectRow(project),
      expectedVersion: version,
      at,
      envelope: mutation.envelope(
        project,
        [
          mutation.audit(
            'projects',
            'project',
            projectId,
            action,
            {
              fields: Object.keys(fields).sort().join(','),
              status: project.status,
              version: project.version
            },
            at
          )
        ],
        now
      )
    });
    return project;
  }

  /**
   * @inheritdoc
   */
  async createTask(
    actor: ActorContext,
    projectId: string,
    input: CreateTaskInput,
    meta: MutationMeta
  ): Promise<Task> {
    const caller = validateActor(actor);
    const id = validateId(projectId, caller.requestId);
    const fields = validate(CreateTaskInputSchema, input, caller.requestId);
    const key = validateIdempotencyKey(meta?.idempotencyKey, caller.requestId);
    await this.authorizer.require(caller, 'project.write');

    const mutation = await IdempotentMutation.begin(
      'projects.createTask',
      caller,
      { idempotencyKey: key },
      { projectId: id, fields },
      this.runtime
    );
    const replayed = await mutation.replay<Task>(this.repository);
    if (replayed !== undefined) {
      return replayed;
    }
    const project = await this.requireWritableProject(id, caller.requestId);
    const now = this.runtime.now();
    const at = now.toISOString();
    if (!isAcceptableNewDate(fields.dueDate, calendarDate(now, this.settings.timezone))) {
      invalid('dueDate', 'The due date cannot be in the past.', caller.requestId);
    }
    const assignee =
      fields.assigneeId === null
        ? null
        : await this.requireUser(fields.assigneeId, 'assigneeId', caller.requestId);
    const creator = (await this.repository.activeUser(caller.userId)) ?? {
      id: caller.userId,
      displayName: caller.email
    };

    const task: Task = {
      id: this.runtime.newId(),
      project: { id: project.id, name: project.name },
      title: fields.title,
      description: fields.description,
      status: fields.status,
      priority: fields.priority,
      assignee,
      dueDate: fields.dueDate,
      position: appendPosition(await this.repository.lastPosition(project.id, fields.status)),
      createdBy: creator,
      completedAt: fields.status === 'done' ? at : null,
      version: 1,
      createdAt: at,
      updatedAt: at
    };
    await this.repository.insertTask({
      task: toTaskRow(task),
      at,
      envelope: mutation.envelope(
        task,
        [
          mutation.audit(
            'projects',
            'task',
            task.id,
            'created',
            { projectId: project.id, status: task.status, priority: task.priority },
            at
          )
        ],
        now
      )
    });
    return task;
  }

  /**
   * @inheritdoc
   */
  async updateTask(
    actor: ActorContext,
    id: string,
    input: UpdateTaskInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Task> {
    const caller = validateActor(actor);
    const taskId = validateId(id, caller.requestId);
    const fields = validate(UpdateTaskInputSchema, input, caller.requestId);
    const version = validate(VersionSchema, expectedVersion, caller.requestId);
    const key = validateIdempotencyKey(meta?.idempotencyKey, caller.requestId);
    await this.authorizer.require(caller, 'project.write');

    const mutation = await IdempotentMutation.begin(
      'projects.updateTask',
      caller,
      { idempotencyKey: key },
      { taskId, fields, version },
      this.runtime
    );
    const replayed = await mutation.replay<Task>(this.repository);
    if (replayed !== undefined) {
      return replayed;
    }
    const current = await this.repository.getTask(taskId);
    if (current === null) {
      throw serviceError('NOT_FOUND', 'Task not found.', { requestId: caller.requestId });
    }
    if (current.version !== version) {
      throw serviceError(
        'VERSION_MISMATCH',
        'The task was changed by someone else. Reload it and try again.',
        { requestId: caller.requestId }
      );
    }
    await this.requireWritableProject(current.project.id, caller.requestId);
    const now = this.runtime.now();
    const at = now.toISOString();
    if (
      fields.dueDate !== undefined
      && fields.dueDate !== current.dueDate
      && !isAcceptableNewDate(fields.dueDate, calendarDate(now, this.settings.timezone))
    ) {
      invalid('dueDate', 'The due date cannot be in the past.', caller.requestId);
    }
    const assignee =
      fields.assigneeId === undefined || fields.assigneeId === (current.assignee?.id ?? null)
        ? current.assignee
        : fields.assigneeId === null
          ? null
          : await this.requireUser(fields.assigneeId, 'assigneeId', caller.requestId);
    const status = fields.status ?? current.status;
    const moved = status !== current.status;

    const task: Task = {
      ...current,
      title: fields.title ?? current.title,
      description: fields.description === undefined ? current.description : fields.description,
      status,
      priority: fields.priority ?? current.priority,
      assignee,
      dueDate: fields.dueDate === undefined ? current.dueDate : fields.dueDate,
      position: moved
        ? appendPosition(await this.repository.lastPosition(current.project.id, status))
        : current.position,
      completedAt: completionStamp(current, status, at),
      version: current.version + 1,
      updatedAt: at
    };
    await this.repository.updateTask({
      task: toTaskRow(task),
      expectedVersion: version,
      at,
      envelope: mutation.envelope(
        task,
        [
          mutation.audit(
            'projects',
            'task',
            taskId,
            moved ? `moved-${status}` : 'updated',
            {
              fields: Object.keys(fields).sort().join(','),
              projectId: current.project.id,
              status,
              version: task.version
            },
            at
          )
        ],
        now
      )
    });
    return task;
  }

  /**
   * @inheritdoc
   */
  async myWork(actor: ActorContext): Promise<MyWork> {
    const caller = validateActor(actor);
    await this.authorizer.require(caller, 'project.read');
    return {
      today: calendarDate(this.runtime.now(), this.settings.timezone),
      items: await this.repository.myWork(caller.userId, MY_WORK_LIMIT)
    };
  }

  /**
   * @inheritdoc
   */
  async deliveryReport(actor: ActorContext, filter: DeliveryReportFilter): Promise<DeliveryReport> {
    const caller = validateActor(actor);
    const parsed = validate(DeliveryReportFilterSchema, filter ?? {}, caller.requestId);
    await this.authorizer.require(caller, 'report.read');
    let lead: UserRef | null = null;
    if (parsed.leadId !== undefined) {
      lead = await this.repository.userRef(parsed.leadId);
      if (lead === null) {
        throw serviceError('VALIDATION_FAILED', 'That person is not on the team.', {
          requestId: caller.requestId,
          fields: { leadId: 'That person is not on the team.' }
        });
      }
    }
    const today = calendarDate(this.runtime.now(), this.settings.timezone);
    const rows = await this.repository.deliveryRows(
      { status: parsed.projectStatus, leadId: lead?.id ?? null },
      today
    );
    return {
      today,
      filter: { projectStatus: parsed.projectStatus, lead },
      projectCount: rows.length,
      taskCounts: sumTaskCounts(rows.map((row) => row.taskCounts)),
      overdue: rows.reduce((sum, row) => sum + row.overdue, 0),
      projects: rows.slice(0, DELIVERY_REPORT_PROJECT_LIMIT),
      truncated: rows.length > DELIVERY_REPORT_PROJECT_LIMIT
    };
  }

  /**
   * A project that accepts task changes.
   *
   * @param id Project id.
   * @param requestId Request identifier.
   * @returns The project.
   * @throws {Error} `NOT_FOUND` when absent, or `CONFLICT` when archived.
   */
  private async requireWritableProject(id: string, requestId: string): Promise<Project> {
    const project = await this.repository.getProject(id);
    if (project === null) {
      throw serviceError('NOT_FOUND', 'Project not found.', { requestId });
    }
    if (project.status === 'archived') {
      throw serviceError('CONFLICT', 'An archived project is read-only. Unarchive it first.', {
        requestId
      });
    }
    return project;
  }

  /**
   * An active user for a lead or assignee field.
   *
   * @param userId User id.
   * @param field Field to report on.
   * @param requestId Request identifier.
   * @returns The user reference.
   * @throws {Error} `VALIDATION_FAILED` when the user is absent or suspended.
   */
  private async requireUser(userId: string, field: string, requestId: string): Promise<UserRef> {
    const user = await this.repository.activeUser(userId);
    return user ?? invalid(field, 'Choose an active user.', requestId);
  }
}
