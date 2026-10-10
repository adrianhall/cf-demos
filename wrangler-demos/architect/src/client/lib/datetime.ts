/**
 * Shared timestamp formatting for identity/diagram metadata displayed across the dashboard and
 * admin directory. Previously duplicated verbatim in `DiagramGrid.tsx` and
 * `UserDirectoryTable.tsx` (GitLab issue #1); consolidated here as the single source of truth.
 */

/** One rung of the relative-time ladder used by {@link formatRelativeDate}. */
interface RelativeUnit {
  /** `Intl.RelativeTimeFormat` unit this rung reports in. */
  unit: Intl.RelativeTimeFormatUnit;
  /** Seconds in one of this rung's units. */
  seconds: number;
}

/**
 * Descending thresholds `formatRelativeDate` walks to pick the coarsest unit that still reports
 * a whole count of at least `1` (a year, then a month, etc.), falling through to seconds only
 * for the "just now" case handled separately.
 */
const RELATIVE_UNITS: readonly RelativeUnit[] = [
  { seconds: 60 * 60 * 24 * 365, unit: "year" },
  { seconds: 60 * 60 * 24 * 30, unit: "month" },
  { seconds: 60 * 60 * 24 * 7, unit: "week" },
  { seconds: 60 * 60 * 24, unit: "day" },
  { seconds: 60 * 60, unit: "hour" },
  { seconds: 60, unit: "minute" },
];

/**
 * Formats an ISO-8601 timestamp as an absolute, locale-aware date and time, for example
 * `Aug 10, 2026, 4:50 PM`. Used as the hover/tooltip and screen-reader text alongside the
 * relative timestamp shown in the diagram dashboard, and as the sole display format in the
 * admin user directory.
 *
 * @param iso ISO-8601 timestamp to format.
 * @returns The formatted date, in the runtime's default locale.
 */
export function formatAbsoluteDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * Formats an ISO-8601 timestamp as a relative, locale-aware phrase such as `2 days ago` or
 * `yesterday`, for the diagram dashboard's "Updated" line (GitLab issue #1). Falls back to
 * `just now` for anything under a minute, which also absorbs small amounts of clock skew that
 * would otherwise render as a confusing "in 3 seconds".
 *
 * @param iso ISO-8601 timestamp to format.
 * @param now Reference time to compare against; defaults to the current time. Exposed so tests
 *   can pass a fixed instant instead of relying on fake timers.
 * @returns The formatted relative phrase, in the runtime's default locale.
 */
export function formatRelativeDate(
  iso: string,
  now: Date = new Date(),
): string {
  const deltaSeconds = (new Date(iso).getTime() - now.getTime()) / 1000;
  const absoluteSeconds = Math.abs(deltaSeconds);

  if (absoluteSeconds < 60) {
    return "just now";
  }

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  // RELATIVE_UNITS is sorted coarsest-first and its last rung (minute, 60s) always matches once
  // the "just now" guard above has ruled out anything smaller, so this loop is exhaustive.
  for (const { seconds, unit } of RELATIVE_UNITS) {
    if (absoluteSeconds >= seconds) {
      const value = Math.round(deltaSeconds / seconds);
      return formatter.format(value, unit);
    }
  }

  // Unreachable: satisfies the compiler, which cannot see the loop's exhaustiveness above.
  return formatter.format(Math.round(deltaSeconds / 60), "minute");
}
