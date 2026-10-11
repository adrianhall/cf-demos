/**
 * @file Date and time wire formats. Instants travel as UTC ISO-8601 strings with millisecond
 *   precision (`toISOString()` output). Calendar dates with no time component — next-action dates,
 *   due dates — travel as `YYYY-MM-DD` so that a date picked in London is not shifted a day by a
 *   UTC conversion.
 */

import * as v from 'valibot';

/**
 * Schema for a UTC instant in `Date.prototype.toISOString()` form.
 */
export const TimestampSchema = v.pipe(
  v.string(),
  v.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u, 'Must be a UTC ISO-8601 timestamp.')
);

/**
 * A UTC instant string.
 */
export type Timestamp = v.InferOutput<typeof TimestampSchema>;

/**
 * Whether a `YYYY-MM-DD` string names a day that exists (rejects `2026-02-30`, which Valibot's
 * `isoDate` format check alone accepts).
 *
 * @param value A string already in `YYYY-MM-DD` form.
 * @returns Whether the date round-trips through the UTC calendar.
 */
function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Schema for a real calendar date in `YYYY-MM-DD` form.
 */
export const DateOnlySchema = v.pipe(
  v.string(),
  v.isoDate('Must be a date in YYYY-MM-DD form.'),
  v.check(isRealDate, 'Must be a real calendar date.')
);

/**
 * A calendar date string.
 */
export type DateOnly = v.InferOutput<typeof DateOnlySchema>;

/**
 * Format an instant for storage and the wire.
 *
 * @param date The instant to format.
 * @returns The UTC ISO-8601 representation.
 */
export function toTimestamp(date: Date): Timestamp {
  return date.toISOString();
}
