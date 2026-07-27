import { describe, expect, it } from "vitest";
import { createMediaKey } from "./storage";

describe("createMediaKey", () => {
  it("uses a stable hash rather than the owner's email in an R2 key", async () => {
    const id = "adf5b4e7-ae77-49d0-a9ee-d11aedf38d65";
    const key = await createMediaKey("creator@example.com", id);

    expect(key).toMatch(new RegExp(`^media/[0-9a-f]{64}/${id}$`, "u"));
    expect(key).not.toContain("creator@example.com");
    await expect(createMediaKey("creator@example.com", id)).resolves.toBe(key);
  });
});
