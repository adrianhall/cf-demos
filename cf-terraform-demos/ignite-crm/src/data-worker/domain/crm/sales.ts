/**
 * @file Pure sales rules: calendar dates in the installation time zone, the deal state machine,
 *   activity timing, and action-stream urgency and ordering. No I/O and no clock reads — callers
 *   pass "now" — so every rule is unit-testable with fixed dates.
 */

import type { DealStatus, Urgency } from '../../../shared/api/sales.ts';

/**
 * How far into the future an activity's `occurredAt` may be, to tolerate client clock skew.
 * Activities record what happened; they are not scheduling (introduction §1.3).
 */
export const ACTIVITY_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * The calendar date of an instant in a time zone.
 *
 * "Due today" must mean today for the business, not today in UTC: at 00:30 in London during British
 * Summer Time it is still yesterday in UTC.
 *
 * @param instant The instant.
 * @param timeZone IANA time zone, e.g. `Europe/London`.
 * @returns The date as `YYYY-MM-DD`.
 */
export function calendarDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(instant);
  const part = (type: string): string => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Classify an action's urgency.
 *
 * @param dueDate The action's date, or `null` for "as soon as possible".
 * @param today Today's calendar date.
 * @returns The urgency.
 */
export function urgencyOf(dueDate: string | null, today: string): Urgency {
  if (dueDate === null) {
    return 'asap';
  }
  if (dueDate < today) {
    return 'overdue';
  }
  return dueDate === today ? 'today' : 'upcoming';
}

/**
 * The fields of an action that decide its place in the stream.
 */
export interface Rankable {
  /**
   * Source of the action.
   */
  readonly kind: 'contact' | 'deal';
  /**
   * Stable identifier, the final tie-breaker.
   */
  readonly id: string;
  /**
   * Due date, or `null` for ASAP.
   */
  readonly dueDate: string | null;
}

/**
 * Order action-stream rows: ASAP first, then by date (overdue → today → upcoming). On the same day
 * a contact action precedes a deal action (chasing a person usually unblocks the deal), and the id
 * breaks any remaining tie so the order is stable across requests.
 *
 * @param a One row.
 * @param b Another row.
 * @returns Negative when `a` comes first.
 */
export function compareActions(a: Rankable, b: Rankable): number {
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate === null) {
      return -1;
    }
    if (b.dueDate === null) {
      return 1;
    }
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  if (a.kind !== b.kind) {
    return a.kind === 'contact' ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The next-action and close fields of a deal.
 */
export interface DealLifecycle {
  /**
   * Outcome.
   */
  readonly status: DealStatus;
  /**
   * Next action text.
   */
  readonly nextActionText: string | null;
  /**
   * Next action date.
   */
  readonly nextActionDate: string | null;
  /**
   * Close instant.
   */
  readonly closedAt: string | null;
}

/**
 * Why a deal state is inconsistent, keyed by the field to report it on.
 */
export type LifecycleViolation = Readonly<Record<string, string>>;

/**
 * Apply an outcome change to a deal's lifecycle fields.
 *
 * Winning or losing stamps the close time and clears the next action — a closed deal has nothing
 * left to chase, and leaving the action would keep it in the rep's worklist. Reopening clears the
 * close time. Keeping the same status leaves everything as it was.
 *
 * @param before The current state.
 * @param status The requested status.
 * @param now The change instant (UTC ISO).
 * @returns The resulting lifecycle fields.
 */
export function applyOutcome(
  before: DealLifecycle,
  status: DealStatus,
  now: string
): DealLifecycle {
  if (status === before.status) {
    return before;
  }
  if (status === 'pending') {
    return { ...before, status, closedAt: null };
  }
  return { status, nextActionText: null, nextActionDate: null, closedAt: now };
}

/**
 * Check a deal's merged state for consistency.
 *
 * @param state The state after applying a change.
 * @param changedNextActionDate Whether the change sets a new next-action date.
 * @param today Today's calendar date in the installation time zone.
 * @returns Field messages, empty when consistent.
 */
export function lifecycleViolations(
  state: DealLifecycle,
  changedNextActionDate: boolean,
  today: string
): LifecycleViolation {
  if ((state.nextActionText === null) !== (state.nextActionDate === null)) {
    return { nextActionDate: 'A next action needs both a description and a date.' };
  }
  if (state.status !== 'pending' && state.nextActionText !== null) {
    return { nextActionText: 'Only an open deal can have a next action.' };
  }
  if (changedNextActionDate && state.nextActionDate !== null && state.nextActionDate < today) {
    return { nextActionDate: 'The next action date cannot be in the past.' };
  }
  return {};
}

/**
 * Check that a new next-action date is not already in the past.
 *
 * A date in the past is almost always a typo, and would put the action straight into the overdue
 * section. Existing actions _become_ overdue as time passes; that is expected and not rejected.
 *
 * @param dueDate The requested date, or `null` for ASAP.
 * @param today Today's calendar date in the installation time zone.
 * @returns Whether the date is acceptable.
 */
export function isAcceptableDueDate(dueDate: string | null, today: string): boolean {
  return dueDate === null || dueDate >= today;
}

/**
 * Check that an activity did not happen in the future.
 *
 * @param occurredAt When the activity happened (UTC ISO).
 * @param now The current instant.
 * @returns Whether it is acceptable.
 */
export function isPastOrPresent(occurredAt: string, now: Date): boolean {
  return Date.parse(occurredAt) <= now.getTime() + ACTIVITY_CLOCK_SKEW_MS;
}
