/**
 * @file Convert the task form's value into API requests. Kept out of the components so the rules —
 *   blanks become `null`, and an update sends only changed fields — are unit-testable and shared by
 *   the project board and the personal worklist.
 */

import type {
  CreateTaskInput,
  Task,
  TaskPriority,
  TaskStatus,
  UpdateTaskInput
} from '../../shared/api/projects.ts';

/**
 * The values the task form submits.
 */
export interface TaskFormValue {
  /**
   * Title.
   */
  title: string;
  /**
   * Description ('' for none).
   */
  description: string;
  /**
   * Status.
   */
  status: TaskStatus;
  /**
   * Priority.
   */
  priority: TaskPriority;
  /**
   * Assignee id, or `null`.
   */
  assigneeId: string | null;
  /**
   * Due date ('' for none).
   */
  dueDate: string;
}

/**
 * A blank string as `null`.
 *
 * @param value Form text.
 * @returns The trimmed text, or `null` when blank.
 */
function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Build a create-task request.
 *
 * @param value The form value.
 * @returns The request body.
 */
export function toCreateTaskInput(value: TaskFormValue): CreateTaskInput {
  return {
    title: value.title.trim(),
    description: blankToNull(value.description),
    status: value.status,
    priority: value.priority,
    assigneeId: value.assigneeId,
    dueDate: blankToNull(value.dueDate)
  };
}

/**
 * Build an update-task request containing only the fields that changed.
 *
 * @param task The task as last loaded.
 * @param value The form value.
 * @returns The changed fields, or `null` when nothing changed.
 */
export function toUpdateTaskInput(task: Task, value: TaskFormValue): UpdateTaskInput | null {
  const next = toCreateTaskInput(value);
  const changes: Record<string, unknown> = {};
  if (next.title !== task.title) {
    changes.title = next.title;
  }
  if (next.description !== task.description) {
    changes.description = next.description;
  }
  if (next.status !== task.status) {
    changes.status = next.status;
  }
  if (next.priority !== task.priority) {
    changes.priority = next.priority;
  }
  if (next.assigneeId !== (task.assignee?.id ?? null)) {
    changes.assigneeId = next.assigneeId;
  }
  if (next.dueDate !== task.dueDate) {
    changes.dueDate = next.dueDate;
  }
  return Object.keys(changes).length === 0 ? null : (changes as UpdateTaskInput);
}
