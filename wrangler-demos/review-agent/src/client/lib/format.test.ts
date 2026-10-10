import { describe, expect, it } from "vitest";
import { formatCost, formatTimestamp } from "./format";

describe("formatCost", () => {
  it("shows Pending for a cost that has not been confirmed yet", () => {
    expect(formatCost(null, "pending")).toBe("Pending");
    expect(formatCost(null)).toBe("Pending");
  });

  it("shows the raw amount for a cost with no source attribution", () => {
    expect(formatCost(0.0042)).toBe("$0.0042");
  });

  it("labels an AI-Gateway-confirmed cost distinctly from an unlabeled one", () => {
    expect(formatCost(0.0042, "gateway")).toBe("$0.0042 (AI Gateway)");
    expect(formatCost(0.0042, "pending")).toBe("$0.0042");
  });
});

describe("formatTimestamp", () => {
  it("returns a placeholder for a null timestamp", () => {
    expect(formatTimestamp(null)).toBe("—");
  });

  it("formats an ISO timestamp using the current locale", () => {
    const formatted = formatTimestamp("2026-08-01T12:00:00.000Z");
    expect(formatted).toBe(
      new Date("2026-08-01T12:00:00.000Z").toLocaleString(),
    );
  });
});
