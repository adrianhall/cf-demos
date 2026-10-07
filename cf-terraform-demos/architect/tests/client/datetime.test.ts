import { describe, expect, it } from 'vitest';
import { formatAbsoluteDate, formatRelativeDate } from '../../src/client/lib/datetime.ts';

/**
 * @file Covers both timestamp formats. Every relative case passes an explicit reference instant
 *   rather than relying on fake timers, because the function takes one for exactly that reason: a
 *   test that used the real clock would sit a fixed distance from a unit boundary and eventually
 *   cross it.
 */

/**
 * Fixed reference instant every relative assertion is measured against.
 */
const NOW = new Date('2026-08-12T00:00:00.000Z');

describe('formatAbsoluteDate', () => {
  it('formats a timestamp as a locale date and time', () => {
    const formatted = formatAbsoluteDate('2026-08-10T16:50:00.000Z');

    // Asserted on stable substrings rather than the exact separators, which vary between ICU
    // versions and would make this a test of the platform rather than of this function.
    expect(formatted).toContain('2026');
    expect(formatted).toContain('Aug');
  });
});

describe('formatRelativeDate', () => {
  it.each([
    ['sub-minute deltas', '2026-08-11T23:59:30.000Z', 'just now'],
    ['minutes', '2026-08-11T23:55:00.000Z', '5 minutes ago'],
    ['hours', '2026-08-11T21:00:00.000Z', '3 hours ago'],
    ['a single day', '2026-08-11T00:00:00.000Z', 'yesterday'],
    ['multiple days', '2026-08-10T00:00:00.000Z', '2 days ago'],
    ['weeks', '2026-07-28T00:00:00.000Z', '2 weeks ago'],
    ['months', '2026-05-01T00:00:00.000Z', '3 months ago'],
    ['years', '2024-08-01T00:00:00.000Z', '2 years ago']
  ])('reports %s', (_label, iso, expected) => {
    expect(formatRelativeDate(iso, NOW)).toBe(expected);
  });

  // Without the floor, a diagram saved a moment ago against a slightly fast server clock would
  // read as "in 3 seconds".
  it('absorbs small forward clock skew as "just now"', () => {
    expect(formatRelativeDate('2026-08-12T00:00:05.000Z', NOW)).toBe('just now');
  });

  it('reports a genuinely future timestamp as being in the future', () => {
    expect(formatRelativeDate('2026-08-13T00:00:00.000Z', NOW)).toBe('tomorrow');
  });

  // The coarsest matching rung, so three weeks reads as weeks rather than as 21 days.
  it('chooses the coarsest unit that still reports a whole count', () => {
    expect(formatRelativeDate('2026-07-22T00:00:00.000Z', NOW)).toBe('3 weeks ago');
  });

  it('defaults its reference instant to the current time', () => {
    expect(formatRelativeDate(new Date().toISOString())).toBe('just now');
  });
});
