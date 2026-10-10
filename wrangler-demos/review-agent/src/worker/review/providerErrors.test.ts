import { describe, expect, it } from "vitest";
import { isPermanentFetchDiffError } from "./providerErrors";

describe("isPermanentFetchDiffError", () => {
  it.each([403, 404])("returns true for a status %i error message", (code) => {
    expect(
      isPermanentFetchDiffError(
        new Error(
          `GitHub pull request files request failed with status ${code}`,
        ),
      ),
    ).toBe(true);
  });

  it.each([500, 502, 503])(
    "returns false for a transient status %i error message",
    (code) => {
      expect(
        isPermanentFetchDiffError(
          new Error(
            `GitHub pull request files request failed with status ${code}`,
          ),
        ),
      ).toBe(false);
    },
  );

  it("returns false for a non-Error value", () => {
    expect(isPermanentFetchDiffError("not an error")).toBe(false);
    expect(isPermanentFetchDiffError(null)).toBe(false);
  });

  it("returns false for an unrelated error message", () => {
    expect(isPermanentFetchDiffError(new Error("network timeout"))).toBe(false);
  });
});
