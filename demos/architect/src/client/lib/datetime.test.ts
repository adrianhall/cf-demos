import { describe, expect, it } from "vitest";
import { formatAbsoluteDate, formatRelativeDate } from "./datetime";

describe("formatAbsoluteDate", () => {
  it("formats an ISO timestamp as a locale date and time", () => {
    // en-US default locale in the test environment; assert on stable substrings rather than the
    // exact separator characters, which vary slightly across Node/ICU versions.
    const formatted = formatAbsoluteDate("2026-08-10T16:50:00.000Z");
    expect(formatted).toContain("2026");
    expect(formatted).toContain("Aug");
  });
});

describe("formatRelativeDate", () => {
  const now = new Date("2026-08-12T00:00:00.000Z");

  it("reports sub-minute deltas as 'just now'", () => {
    expect(formatRelativeDate("2026-08-12T00:00:30.000Z", now)).toBe(
      "just now",
    );
  });

  it("absorbs small future clock skew as 'just now'", () => {
    expect(formatRelativeDate("2026-08-12T00:00:05.000Z", now)).toBe(
      "just now",
    );
  });

  it("reports minutes", () => {
    expect(formatRelativeDate("2026-08-11T23:55:00.000Z", now)).toBe(
      "5 minutes ago",
    );
  });

  it("reports hours", () => {
    expect(formatRelativeDate("2026-08-11T21:00:00.000Z", now)).toBe(
      "3 hours ago",
    );
  });

  it("reports 'yesterday' for a one-day delta", () => {
    expect(formatRelativeDate("2026-08-11T00:00:00.000Z", now)).toBe(
      "yesterday",
    );
  });

  it("reports multi-day deltas", () => {
    expect(formatRelativeDate("2026-08-10T00:00:00.000Z", now)).toBe(
      "2 days ago",
    );
  });

  it("reports weeks", () => {
    expect(formatRelativeDate("2026-07-28T00:00:00.000Z", now)).toBe(
      "2 weeks ago",
    );
  });

  it("reports months", () => {
    expect(formatRelativeDate("2026-05-01T00:00:00.000Z", now)).toBe(
      "3 months ago",
    );
  });

  it("reports years", () => {
    expect(formatRelativeDate("2024-08-01T00:00:00.000Z", now)).toBe(
      "2 years ago",
    );
  });
});
