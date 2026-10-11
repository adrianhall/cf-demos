/**
 * @file Delivery wire schemas: projects, tasks, won-deal conversion, and the personal task
 *   worklist. As with the other `src/shared/api` modules, the same values cross the Data Worker RPC
 *   boundary unchanged, and request schemas are `strictObject`s so server-owned fields (`version`,
 *   `completedAt`, `sourceDeal`) cannot be smuggled into a body. Statuses and priorities are the
 *   fixed Linear-style vocabularies of the introduction; custom workflows are not part of release
 *   one.
 */

import * as v from 'valibot';
import { DateOnlySchema, TimestampSchema } from '../common/dates.ts';
import { IdSchema } from '../common/ids.ts';
import { CursorSchema, MAX_PAGE_SIZE, pageSchema } from '../common/paging.ts';
import { optionalText, requiredText, SearchTermSchema } from '../validation/fields.ts';
import { HistoryEntrySchema, UserRefSchema } from './crm.ts';
import { CompanyRefSchema, ContactRefSchema, DealRefSchema } from './sales.ts';

/**
 * Project lifecycle states.
 */
export const PROJECT_STATUSES = ['active', 'on_hold', 'completed', 'archived'] as const;

/**
 * Schema for a project status.
 */
export const ProjectStatusSchema = v.picklist(
  PROJECT_STATUSES,
  'Status must be active, on_hold, completed, or archived.'
);

/**
 * A project status.
 */
export type ProjectStatus = v.InferOutput<typeof ProjectStatusSchema>;

/**
 * Task workflow states, in board column order.
 */
export const TASK_STATUSES = ['todo', 'in_progress', 'in_review', 'done'] as const;

/**
 * Schema for a task status.
 */
export const TaskStatusSchema = v.picklist(
  TASK_STATUSES,
  'Status must be todo, in_progress, in_review, or done.'
);

/**
 * A task status.
 */
export type TaskStatus = v.InferOutput<typeof TaskStatusSchema>;

/**
 * Task priorities, lowest first.
 */
export const TASK_PRIORITIES = ['no_priority', 'low', 'medium', 'high', 'urgent'] as const;

/**
 * Schema for a task priority.
 */
export const TaskPrioritySchema = v.picklist(
  TASK_PRIORITIES,
  'Priority must be no_priority, low, medium, high, or urgent.'
);

/**
 * A task priority.
 */
export type TaskPriority = v.InferOutput<typeof TaskPrioritySchema>;

/**
 * Most tasks returned with one project. A delivery project in a small business is far below this;
 * the bound keeps the RPC payload and the board render predictable.
 */
export const PROJECT_TASK_LIMIT = 200;

/**
 * Most rows in the personal worklist.
 */
export const MY_WORK_LIMIT = 100;

/**
 * Optional calendar date where `null` (or a blank string from a form) means "none".
 */
const OptionalDateSchema = v.optional(
  v.nullable(
    v.pipe(
      v.string(),
      v.transform((value) => (value.trim() === '' ? null : value.trim())),
      v.nullable(DateOnlySchema)
    )
  ),
  null
);

/**
 * A reference to a project.
 */
export const ProjectRefSchema = v.strictObject({
  /**
   * Project identifier.
   */
  id: IdSchema,
  /**
   * Project name.
   */
  name: v.string()
});

/**
 * A project reference.
 */
export type ProjectRef = v.InferOutput<typeof ProjectRefSchema>;

/**
 * Task counts by status.
 */
export const TaskCountsSchema = v.strictObject({
  /**
   * Not started.
   */
  todo: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * In progress.
   */
  in_progress: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * Awaiting review.
   */
  in_review: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * Finished.
   */
  done: v.pipe(v.number(), v.integer(), v.minValue(0))
});

/**
 * A project.
 */
export const ProjectSchema = v.strictObject({
  /**
   * Project identifier.
   */
  id: IdSchema,
  /**
   * Project name.
   */
  name: v.string(),
  /**
   * Optional plain-text description.
   */
  description: v.nullable(v.string()),
  /**
   * Lifecycle state.
   */
  status: ProjectStatusSchema,
  /**
   * The won deal this project delivers, or `null` for a standalone project. Immutable.
   */
  sourceDeal: v.nullable(DealRefSchema),
  /**
   * Customer company, copied from the deal at conversion.
   */
  company: v.nullable(CompanyRefSchema),
  /**
   * Customer contact, copied from the deal's primary contact at conversion.
   */
  primaryContact: v.nullable(ContactRefSchema),
  /**
   * Responsible delivery lead.
   */
  lead: UserRefSchema,
  /**
   * Target completion date.
   */
  targetDate: v.nullable(DateOnlySchema),
  /**
   * Live task counts by status.
   */
  taskCounts: TaskCountsSchema,
  /**
   * Optimistic-concurrency version.
   */
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /**
   * Creation instant.
   */
  createdAt: TimestampSchema,
  /**
   * Last modification instant.
   */
  updatedAt: TimestampSchema
});

/**
 * A project.
 */
export type Project = v.InferOutput<typeof ProjectSchema>;

/**
 * One page of projects.
 */
export const ProjectPageSchema = pageSchema(ProjectSchema);

/**
 * A task.
 */
export const TaskSchema = v.strictObject({
  /**
   * Task identifier.
   */
  id: IdSchema,
  /**
   * The project it belongs to.
   */
  project: ProjectRefSchema,
  /**
   * Short title.
   */
  title: v.string(),
  /**
   * Optional plain-text description.
   */
  description: v.nullable(v.string()),
  /**
   * Workflow state.
   */
  status: TaskStatusSchema,
  /**
   * Priority.
   */
  priority: TaskPrioritySchema,
  /**
   * Who is doing it, if anyone.
   */
  assignee: v.nullable(UserRefSchema),
  /**
   * Due date.
   */
  dueDate: v.nullable(DateOnlySchema),
  /**
   * Sparse order within its status column (lower first; ties break by id).
   */
  position: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * Who created it.
   */
  createdBy: UserRefSchema,
  /**
   * When it moved to `done`; `null` otherwise.
   */
  completedAt: v.nullable(TimestampSchema),
  /**
   * Optimistic-concurrency version.
   */
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /**
   * Creation instant.
   */
  createdAt: TimestampSchema,
  /**
   * Last modification instant.
   */
  updatedAt: TimestampSchema
});

/**
 * A task.
 */
export type Task = v.InferOutput<typeof TaskSchema>;

/**
 * A project with its tasks and history.
 */
export const ProjectDetailSchema = v.strictObject({
  /**
   * The project.
   */
  project: ProjectSchema,
  /**
   * Tasks in board order (status column, then position, then id), at most
   * {@link PROJECT_TASK_LIMIT}.
   */
  tasks: v.array(TaskSchema),
  /**
   * Most recent history entries, newest first.
   */
  history: v.array(HistoryEntrySchema)
});

/**
 * A project detail projection.
 */
export type ProjectDetail = v.InferOutput<typeof ProjectDetailSchema>;

/**
 * The signed-in user's open assigned tasks across every project.
 */
export const MyWorkSchema = v.strictObject({
  /**
   * The calendar date overdue was computed against (installation time zone).
   */
  today: DateOnlySchema,
  /**
   * Open tasks: dated first by due date (so overdue leads), then undated; each group by priority
   * (urgent first), then id. At most {@link MY_WORK_LIMIT}.
   */
  items: v.array(TaskSchema)
});

/**
 * The personal worklist.
 */
export type MyWork = v.InferOutput<typeof MyWorkSchema>;

/**
 * Request body for converting a won deal into a project.
 *
 * Every field is optional: the name defaults to the deal title and the lead to the caller. The
 * company and primary contact always come from the deal itself, never from the request.
 */
export const ConvertDealInputSchema = v.strictObject({
  /**
   * Project name; defaults to the deal title.
   */
  name: v.optional(requiredText('Name', 200)),
  /**
   * Delivery lead; defaults to the caller. Any active user may be chosen — handing delivery to
   * someone else is the purpose of conversion.
   */
  leadId: v.optional(IdSchema),
  /**
   * Target completion date.
   */
  targetDate: OptionalDateSchema
});

/**
 * A validated convert-deal request.
 */
export type ConvertDealInput = v.InferOutput<typeof ConvertDealInputSchema>;

/**
 * A convert-deal request before validation (every field optional). The Data Worker port accepts
 * this shape and validates it itself, so callers may pass `{}`.
 */
export type ConvertDealRequest = v.InferInput<typeof ConvertDealInputSchema>;

/**
 * Request body for updating a project. Omitted fields are unchanged; `null` clears a field.
 */
export const UpdateProjectInputSchema = v.pipe(
  v.strictObject({
    /**
     * New name.
     */
    name: v.optional(requiredText('Name', 200)),
    /**
     * New description.
     */
    description: v.optional(optionalText('Description', 4000)),
    /**
     * New status. Archiving or unarchiving needs `project.manage`.
     */
    status: v.optional(ProjectStatusSchema),
    /**
     * New lead; needs `project.manage`.
     */
    leadId: v.optional(IdSchema),
    /**
     * New target date.
     */
    targetDate: v.optional(OptionalDateSchema)
  }),
  v.check((input) => Object.keys(input).length > 0, 'Provide at least one field to change.')
);

/**
 * A validated update-project request.
 */
export type UpdateProjectInput = v.InferOutput<typeof UpdateProjectInputSchema>;

/**
 * Request body for creating a task.
 */
export const CreateTaskInputSchema = v.strictObject({
  /**
   * Title.
   */
  title: requiredText('Title', 200),
  /**
   * Description.
   */
  description: optionalText('Description', 8000),
  /**
   * Starting status; defaults to `todo`.
   */
  status: v.optional(TaskStatusSchema, 'todo'),
  /**
   * Priority; defaults to `no_priority`.
   */
  priority: v.optional(TaskPrioritySchema, 'no_priority'),
  /**
   * Assignee, or `null` for unassigned.
   */
  assigneeId: v.optional(v.nullable(IdSchema), null),
  /**
   * Due date.
   */
  dueDate: OptionalDateSchema
});

/**
 * A validated create-task request.
 */
export type CreateTaskInput = v.InferOutput<typeof CreateTaskInputSchema>;

/**
 * Request body for updating a task. Omitted fields are unchanged; `null` clears a field. Changing
 * the status moves the task to the end of its new column.
 */
export const UpdateTaskInputSchema = v.pipe(
  v.strictObject({
    /**
     * New title.
     */
    title: v.optional(requiredText('Title', 200)),
    /**
     * New description.
     */
    description: v.optional(optionalText('Description', 8000)),
    /**
     * New status.
     */
    status: v.optional(TaskStatusSchema),
    /**
     * New priority.
     */
    priority: v.optional(TaskPrioritySchema),
    /**
     * New assignee, or `null` to unassign.
     */
    assigneeId: v.optional(v.nullable(IdSchema)),
    /**
     * New due date.
     */
    dueDate: v.optional(OptionalDateSchema)
  }),
  v.check((input) => Object.keys(input).length > 0, 'Provide at least one field to change.')
);

/**
 * A validated update-task request.
 */
export type UpdateTaskInput = v.InferOutput<typeof UpdateTaskInputSchema>;

/**
 * Query string for listing projects.
 */
export const ProjectListQuerySchema = v.strictObject({
  /**
   * Search term matched against the project, company, and contact names.
   */
  q: v.optional(SearchTermSchema),
  /**
   * Restrict to one lifecycle state.
   */
  status: v.optional(ProjectStatusSchema),
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
