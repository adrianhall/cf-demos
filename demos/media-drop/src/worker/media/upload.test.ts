import { describe, expect, it, vi } from "vitest";
import { persistDraftMetadata } from "./upload";
import type { MediaItem } from "./types";

/** Draft metadata used to test the upload persistence transaction. */
const item: MediaItem = {
  contentType: "image/png",
  createdAt: "2026-07-27T12:00:00.000Z",
  id: "adf5b4e7-ae77-49d0-a9ee-d11aedf38d65",
  owner: "creator@example.com",
  publishedAt: null,
  r2Key: "media/owner/item",
  sizeBytes: 12,
  status: "draft",
  title: "Private image",
  updatedAt: "2026-07-27T12:00:00.000Z",
};

describe("persistDraftMetadata", () => {
  it("keeps the object when D1 metadata persistence succeeds", async () => {
    const createDraft = vi.fn().mockResolvedValue(undefined);
    const deleteObject = vi.fn();
    const bucket = { delete: deleteObject } as unknown as R2Bucket;

    await persistDraftMetadata({ createDraft }, bucket, item);

    expect(createDraft).toHaveBeenCalledWith(item);
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("deletes the stored object and rethrows when D1 rejects metadata", async () => {
    const failure = new Error("D1 unavailable");
    const deleteObject = vi.fn().mockResolvedValue(undefined);
    const bucket = { delete: deleteObject } as unknown as R2Bucket;

    await expect(
      persistDraftMetadata(
        { createDraft: vi.fn().mockRejectedValue(failure) },
        bucket,
        item,
      ),
    ).rejects.toThrow(failure);
    expect(deleteObject).toHaveBeenCalledWith(item.r2Key);
  });
});
