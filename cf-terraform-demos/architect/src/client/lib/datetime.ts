/**
 * @file Timestamp formatting shared by every surface that shows when something last changed. Both
 *   formats exist because neither is sufficient alone: "2 days ago" is what a person actually wants
 *   to know while scanning a dashboard, and the exact date is what they need when the relative
 *   phrase is ambiguous. A card therefore shows the relative phrase and carries the absolute one
 *   for assistive technology and for a hover tooltip.
 */

/**
 * One rung of the relative-time ladder walked by {@link formatRelativeDate}.
 */
interface RelativeUnit {
  /**
   * `Intl.RelativeTimeFormat` unit this rung reports in.
   */
  unit: Intl.RelativeTimeFormatUnit;
  /**
   * Seconds in one of this rung's units.
   */
  seconds: number;
}

/**
 * Descending thresholds, coarsest first.
 *
 * {@link formatRelativeDate} picks the first rung that still reports a whole count of at least one,
 * so a three-week-old diagram reads as "3 weeks ago" rather than "21 days ago".
 */
const RELATIVE_UNITS: readonly RelativeUnit[] = [
  { seconds: 60 * 60 * 24 * 365, unit: 'year' },
  { seconds: 60 * 60 * 24 * 30, unit: 'month' },
  { seconds: 60 * 60 * 24 * 7, unit: 'week' },
  { seconds: 60 * 60 * 24, unit: 'day' },
  { seconds: 60 * 60, unit: 'hour' },
  { seconds: 60, unit: 'minute' }
];

/**
 * Formats an ISO-8601 timestamp as an absolute, locale-aware date and time.
 *
 * Used as the tooltip and the screen-reader text beside a relative timestamp, and as the only
 * format wherever an exact instant is what matters.
 *
 * @param iso ISO-8601 timestamp to format.
 * @returns The formatted date in the runtime's own locale, for example `Aug 10, 2026, 4:50 PM`.
 */
export function formatAbsoluteDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}

/**
 * Formats an ISO-8601 timestamp as a relative, locale-aware phrase.
 *
 * Anything under a minute reads as "just now", which also absorbs small clock skew between the
 * browser and the Worker that generated the timestamp. Without that floor, a diagram saved a moment
 * ago against a slightly fast server clock would read as "in 3 seconds".
 *
 * @param iso ISO-8601 timestamp to format.
 * @param now Reference instant to compare against. Injected so a test can pass a fixed time rather
 *   than racing the real clock across a unit boundary; defaults to the current time.
 * @returns The formatted phrase in the runtime's own locale, for example `2 days ago` or
 *   `yesterday`.
 */
export function formatRelativeDate(iso: string, now: Date = new Date()): string {
  const deltaSeconds = (new Date(iso).getTime() - now.getTime()) / 1000;
  const absoluteSeconds = Math.abs(deltaSeconds);

  if (absoluteSeconds < 60) {
    return 'just now';
  }

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  // Exhaustive by construction: the guard above has ruled out anything under a minute, and the
  // final rung is one minute, so some rung always matches.
  for (const { seconds, unit } of RELATIVE_UNITS) {
    if (absoluteSeconds >= seconds) {
      return formatter.format(Math.round(deltaSeconds / seconds), unit);
    }
  }

  // Unreachable. Present to satisfy the compiler, which cannot see the loop's exhaustiveness.
  return formatter.format(Math.round(deltaSeconds / 60), 'minute');
}
