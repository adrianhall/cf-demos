/**
 * @file Pure report rules: turning the installation's calendar-date window into UTC instants, and
 *   ordering delivery rows. No I/O and no clock reads, so each rule is unit-tested with fixed
 *   dates. Deal close times are stored as UTC timestamps, but people ask for "deals closed in
 *   October" in the business's own time zone. A London day during British Summer Time starts at
 *   23:00 UTC the previous evening, so a naive `closed_at >= '2026-10-01'` would miscount the first
 *   hour of every day.
 */

import type { TaskCounts } from '../../../shared/api/projects.ts';

/**
 * The UTC offset of a time zone at an instant, in milliseconds (positive east of Greenwich).
 *
 * @param instant The instant.
 * @param timeZone IANA time zone.
 * @returns Local wall-clock time minus UTC.
 */
function offsetAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(instant);
  const part = (type: string): number => Number(parts.find((item) => item.type === type)?.value);
  const wall = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second')
  );
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant at which a calendar date begins in a time zone.
 *
 * @param date `YYYY-MM-DD`.
 * @param timeZone IANA time zone, e.g. `Europe/London`.
 * @returns ISO-8601 UTC timestamp of local midnight.
 */
export function startOfLocalDay(date: string, timeZone: string): string {
  const utcMidnight = Date.parse(`${date}T00:00:00.000Z`);
  // Two passes settle the offset even when midnight is near a daylight-saving change.
  let instant = utcMidnight - offsetAt(new Date(utcMidnight), timeZone);
  instant = utcMidnight - offsetAt(new Date(instant), timeZone);
  return new Date(instant).toISOString();
}

/**
 * The calendar date after a given one.
 *
 * @param date `YYYY-MM-DD`.
 * @returns The next day as `YYYY-MM-DD`.
 */
export function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * A half-open UTC window `[from, before)` covering inclusive local calendar dates.
 *
 * @param closedFrom First local date, or `undefined` for unbounded.
 * @param closedTo Last local date (inclusive), or `undefined` for unbounded.
 * @param timeZone IANA time zone.
 * @returns UTC bounds, each `null` when unbounded.
 */
export function closedWindow(
  closedFrom: string | undefined,
  closedTo: string | undefined,
  timeZone: string
): { from: string | null; before: string | null } {
  return {
    from: closedFrom === undefined ? null : startOfLocalDay(closedFrom, timeZone),
    before: closedTo === undefined ? null : startOfLocalDay(nextDate(closedTo), timeZone)
  };
}

/**
 * Unfinished tasks in a set of counts.
 *
 * @param counts Task counts.
 * @returns Every task not yet done.
 */
export function openTasks(counts: TaskCounts): number {
  return counts.todo + counts.in_progress + counts.in_review;
}

/**
 * Sum task counts.
 *
 * @param rows Per-project counts.
 * @returns The totals.
 */
export function sumTaskCounts(rows: readonly TaskCounts[]): TaskCounts {
  return rows.reduce<TaskCounts>(
    (sum, row) => ({
      todo: sum.todo + row.todo,
      in_progress: sum.in_progress + row.in_progress,
      in_review: sum.in_review + row.in_review,
      done: sum.done + row.done
    }),
    { todo: 0, in_progress: 0, in_review: 0, done: 0 }
  );
}
