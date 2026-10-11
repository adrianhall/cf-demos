/**
 * @file Display labels and theme colours for task and project vocabularies, shared by the board,
 *   editor, worklist, and project screens so a status reads identically everywhere. Status and
 *   priority are always shown as text; colour only reinforces it (WCAG 1.4.1).
 */

import type { ProjectStatus, TaskPriority, TaskStatus } from '../../shared/api/projects.ts';

/**
 * Task status labels, in board column order.
 */
export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done'
};

/**
 * Task priority labels and theme colours.
 */
export const TASK_PRIORITY_VIEW: Readonly<Record<TaskPriority, { label: string; color: string }>> =
  {
    no_priority: { label: 'No priority', color: 'default' },
    low: { label: 'Low', color: 'info' },
    medium: { label: 'Medium', color: 'secondary-strong' },
    high: { label: 'High', color: 'warning' },
    urgent: { label: 'Urgent', color: 'error' }
  };

/**
 * Project status labels and theme colours.
 */
export const PROJECT_STATUS_VIEW: Readonly<
  Record<ProjectStatus, { label: string; color: string }>
> = {
  active: { label: 'Active', color: 'success' },
  on_hold: { label: 'On hold', color: 'warning' },
  completed: { label: 'Completed', color: 'info' },
  archived: { label: 'Archived', color: 'default' }
};
