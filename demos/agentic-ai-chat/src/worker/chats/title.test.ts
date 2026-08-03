import { describe, expect, it } from "vitest";
import { sanitizeTitle } from "./title";

describe("sanitizeTitle", () => {
  it("trims surrounding whitespace", () => {
    expect(sanitizeTitle("  Trip Planning  ")).toBe("Trip Planning");
  });

  it("collapses internal whitespace and newlines to single spaces", () => {
    expect(sanitizeTitle("Trip\n  Planning   Ideas")).toBe(
      "Trip Planning Ideas",
    );
  });

  it("strips a single layer of wrapping straight quotes", () => {
    expect(sanitizeTitle('"Trip Planning"')).toBe("Trip Planning");
  });

  it("strips a single layer of wrapping curly quotes", () => {
    expect(sanitizeTitle("“Trip Planning”")).toBe("Trip Planning");
  });

  it("does not strip an internal quote that is not wrapping the whole string", () => {
    expect(sanitizeTitle('The "Best" Trip')).toBe('The "Best" Trip');
  });

  it("truncates an overlong title and appends an ellipsis", () => {
    const overlong = "a".repeat(200);
    const result = sanitizeTitle(overlong);
    expect(result.length).toBe(80);
    expect(result.endsWith("…")).toBe(true);
    expect(result.startsWith("a".repeat(79))).toBe(true);
  });

  it("returns an empty string for input that is only whitespace", () => {
    expect(sanitizeTitle("   \n\t  ")).toBe("");
  });
});
