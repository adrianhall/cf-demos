/**
 * @file Pure delivery rules: won-deal eligibility for conversion, project lifecycle edits, task
 *   completion stamps, sparse column positions, and dates. No I/O and no clock reads — callers pass
 *   "now" and "today" — so each rule is unit-testable with fixed values.
 */

import type { ProjectStatus, TaskStatus } from '../../../shared/api/projects.ts';
import type { DealStatus } from '../../../shared/api/sales.ts';

/**
 * Gap between consecutive task positions. A sparse gap leaves room to insert between two tasks
 * later without renumbering a column.
 */
export const POSITION_GAP = 1024;

/**
 * Why a deal cannot be converted, or `null` when it can.
 *
 * Only a won deal becomes delivery work, and only once: a pending deal may still be lost, and a
 * second project for the same deal would split its delivery history. With `markWon`, a pending deal
 * is also eligible, because it is closed as won in the same transaction as the conversion; a lost
 * deal never is.
 *
 * @param deal The deal's outcome and existing project link.
 * @param deal.status Outcome.
 * @param deal.projectId Project already created from it, if any.
 * @param markWon Whether the conversion also closes a pending deal as won.
 * @returns A caller-safe reason, or `null` when eligible.
 */
export function conversionBlocker(
  deal: { readonly status: DealStatus; readonly projectId: string | null },
  markWon = false
): string | null {
  if (deal.projectId !== null) {
    return 'This deal has already been converted into a project.';
  }
  if (deal.status === 'won' || (markWon && deal.status === 'pending')) {
    return null;
  }
  return markWon
    ? 'A lost deal cannot be won and converted. Reopen it first.'
    : 'Only a won deal can be converted into a project.';
}

/**
 * The permission tier a project edit needs beyond `project.write`.
 *
 * Archiving takes a project out of everyday work and unarchiving brings it back; both, like
 * changing who leads delivery, are management decisions. Everything else is ordinary delivery
 * work.
 *
 * @param before Current status and lead.
 * @param before.status Current status.
 * @param before.leadId Current lead.
 * @param change Requested status and lead (omitted = unchanged).
 * @param change.status Requested status.
 * @param change.leadId Requested lead.
 * @returns Whether `project.manage` is required.
 */
export function needsManage(
  before: { readonly status: ProjectStatus; readonly leadId: string },
  change: { readonly status?: ProjectStatus; readonly leadId?: string }
): boolean {
  const archiving =
    change.status !== undefined
    && change.status !== before.status
    && (change.status === 'archived' || before.status === 'archived');
  const reassigning = change.leadId !== undefined && change.leadId !== before.leadId;
  return archiving || reassigning;
}

/**
 * Whether an archived project's edit is limited to unarchiving it.
 *
 * An archived project is read-only history; the only permitted change is to restore it (possibly
 * together with other fields in the same request, which then apply to the restored project).
 *
 * @param before Current status.
 * @param nextStatus Requested status, or `undefined` when unchanged.
 * @returns Whether the edit is refused.
 */
export function archivedEditRefused(
  before: ProjectStatus,
  nextStatus: ProjectStatus | undefined
): boolean {
  return before === 'archived' && (nextStatus === undefined || nextStatus === 'archived');
}

/**
 * Compute a task's completion stamp after a status change.
 *
 * Moving into `done` records when; moving out clears it; staying keeps the original stamp so a
 * later unrelated edit does not change when the work finished.
 *
 * @param before Current status and stamp.
 * @param before.status Current status.
 * @param before.completedAt Current stamp.
 * @param status Resulting status.
 * @param now Change instant (UTC ISO).
 * @returns The resulting stamp.
 */
export function completionStamp(
  before: { readonly status: TaskStatus; readonly completedAt: string | null },
  status: TaskStatus,
  now: string
): string | null {
  if (status !== 'done') {
    return null;
  }
  return before.status === 'done' ? before.completedAt : now;
}

/**
 * The position for a task appended to the end of a column.
 *
 * @param lastPosition The highest position currently in the column, or `null` when empty.
 * @returns The new position.
 */
export function appendPosition(lastPosition: number | null): number {
  return lastPosition === null ? 0 : lastPosition + POSITION_GAP;
}

/**
 * Whether a newly entered date is acceptable. A date in the past is almost always a typo; existing
 * dates naturally become overdue and are not rejected.
 *
 * @param date The requested date, or `null` for none.
 * @param today Today's calendar date in the installation time zone.
 * @returns Whether it is acceptable.
 */
export function isAcceptableNewDate(date: string | null, today: string): boolean {
  return date === null || date >= today;
}
