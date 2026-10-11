/**
 * @file Pure sales rules with fixed dates: time-zone calendar dates, urgency, action ordering, the
 *   deal outcome state machine, and activity timing.
 */

import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_CLOCK_SKEW_MS,
  applyOutcome,
  calendarDate,
  compareActions,
  isAcceptableDueDate,
  isPastOrPresent,
  lifecycleViolations,
  urgencyOf
} from '../../../src/data-worker/domain/crm/sales.ts';

describe('calendarDate', () => {
  it('uses the installation time zone, not UTC', () => {
    // 23:30 UTC on 11 Oct is already 12 Oct in London (BST, UTC+1).
    expect(calendarDate(new Date('2026-10-11T23:30:00.000Z'), 'Europe/London')).toBe('2026-10-12');
    expect(calendarDate(new Date('2026-10-11T23:30:00.000Z'), 'UTC')).toBe('2026-10-11');
    // In winter London is on UTC.
    expect(calendarDate(new Date('2026-12-01T23:30:00.000Z'), 'Europe/London')).toBe('2026-12-01');
  });
});

describe('urgencyOf', () => {
  it('classifies ASAP, overdue, today, and upcoming', () => {
    expect(urgencyOf(null, '2026-10-11')).toBe('asap');
    expect(urgencyOf('2026-10-10', '2026-10-11')).toBe('overdue');
    expect(urgencyOf('2026-10-11', '2026-10-11')).toBe('today');
    expect(urgencyOf('2026-10-12', '2026-10-11')).toBe('upcoming');
  });
});

describe('compareActions', () => {
  it('orders ASAP first, then by date, contact before deal on the same day, then by id', () => {
    const rows = [
      { kind: 'deal' as const, id: 'd2', dueDate: '2026-10-11' },
      { kind: 'contact' as const, id: 'c3', dueDate: '2026-10-12' },
      { kind: 'contact' as const, id: 'c2', dueDate: '2026-10-11' },
      { kind: 'deal' as const, id: 'd1', dueDate: '2026-10-09' },
      { kind: 'contact' as const, id: 'c1', dueDate: null },
      { kind: 'deal' as const, id: 'd0', dueDate: '2026-10-11' },
      { kind: 'contact' as const, id: 'c0', dueDate: null }
    ];
    expect([...rows].sort(compareActions).map((row) => row.id)).toEqual([
      'c0',
      'c1',
      'd1',
      'c2',
      'd0',
      'd2',
      'c3'
    ]);
    expect(compareActions(rows[0]!, rows[0]!)).toBe(0);
  });
});

describe('deal lifecycle', () => {
  const open = {
    status: 'pending' as const,
    nextActionText: 'Call back',
    nextActionDate: '2026-10-12',
    closedAt: null
  };

  it('winning or losing clears the next action and stamps the close time', () => {
    expect(applyOutcome(open, 'won', '2026-10-11T10:00:00.000Z')).toEqual({
      status: 'won',
      nextActionText: null,
      nextActionDate: null,
      closedAt: '2026-10-11T10:00:00.000Z'
    });
    expect(applyOutcome(open, 'lost', 'x').status).toBe('lost');
  });

  it('reopening clears the close time; an unchanged status changes nothing', () => {
    const won = applyOutcome(open, 'won', '2026-10-11T10:00:00.000Z');
    expect(applyOutcome(won, 'pending', 'later')).toMatchObject({
      status: 'pending',
      closedAt: null
    });
    expect(applyOutcome(open, 'pending', 'later')).toBe(open);
  });

  it('rejects half a next action, an action on a closed deal, and a newly past date', () => {
    expect(
      lifecycleViolations({ ...open, nextActionDate: null }, false, '2026-10-11')
    ).toHaveProperty('nextActionDate');
    expect(
      lifecycleViolations({ ...open, status: 'won', closedAt: 'x' }, false, '2026-10-11')
    ).toHaveProperty('nextActionText');
    expect(lifecycleViolations(open, true, '2026-10-13')).toHaveProperty('nextActionDate');
    // An existing action that has since become overdue is not an error.
    expect(lifecycleViolations(open, false, '2026-10-13')).toEqual({});
  });

  it('accepts today and later as a new due date', () => {
    expect(isAcceptableDueDate(null, '2026-10-11')).toBe(true);
    expect(isAcceptableDueDate('2026-10-11', '2026-10-11')).toBe(true);
    expect(isAcceptableDueDate('2026-10-10', '2026-10-11')).toBe(false);
  });
});

describe('activity timing', () => {
  it('allows the past and a few minutes of clock skew, not the future', () => {
    const now = new Date('2026-10-11T10:00:00.000Z');
    expect(isPastOrPresent('2026-10-11T09:00:00.000Z', now)).toBe(true);
    expect(
      isPastOrPresent(new Date(now.getTime() + ACTIVITY_CLOCK_SKEW_MS).toISOString(), now)
    ).toBe(true);
    expect(isPastOrPresent('2026-10-11T11:00:00.000Z', now)).toBe(false);
  });
});
