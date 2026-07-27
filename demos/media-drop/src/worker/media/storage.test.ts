import { describe, expect, it } from "vitest";
import { createMediaKey, resolveRequestedRange } from "./storage";

describe("createMediaKey", () => {
  it("uses a stable hash rather than the owner's email in an R2 key", async () => {
    const id = "adf5b4e7-ae77-49d0-a9ee-d11aedf38d65";
    const key = await createMediaKey("creator@example.com", id);

    expect(key).toMatch(new RegExp(`^media/[0-9a-f]{64}/${id}$`, "u"));
    expect(key).not.toContain("creator@example.com");
    await expect(createMediaKey("creator@example.com", id)).resolves.toBe(key);
  });
});

describe("resolveRequestedRange", () => {
  it("resolves bounded, open-ended, and suffix byte ranges", () => {
    expect(resolveRequestedRange("bytes=10-19", 100)).toEqual({
      offset: 10,
      length: 10,
    });
    expect(resolveRequestedRange("bytes=90-", 100)).toEqual({
      offset: 90,
      length: 10,
    });
    expect(resolveRequestedRange("bytes=-10", 100)).toEqual({
      offset: 90,
      length: 10,
    });
  });

  it("rejects malformed and unsatisfiable ranges", () => {
    expect(resolveRequestedRange(null, 100)).toBeNull();
    expect(resolveRequestedRange("bytes=90-10", 100)).toBeNull();
    expect(resolveRequestedRange("bytes=-0", 100)).toBeNull();
  });
});
