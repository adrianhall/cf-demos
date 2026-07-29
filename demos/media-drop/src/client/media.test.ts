import { describe, expect, it } from "vitest";
import { formatFileSize, type MediaItem, replaceMedia } from "./media";

describe("formatFileSize", () => {
  it("formats kilobyte and megabyte media sizes", () => {
    expect(formatFileSize(12)).toBe("1 KB");
    expect(formatFileSize(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});

describe("replaceMedia", () => {
  const draft: MediaItem = {
    contentType: "image/png",
    createdAt: "2026-07-27T12:00:00.000Z",
    id: "adf5b4e7-ae77-49d0-a9ee-d11aedf38d65",
    publishedAt: null,
    sizeBytes: 12,
    status: "draft",
    title: "Private image",
    updatedAt: "2026-07-27T12:00:00.000Z",
  };
  const other: MediaItem = { ...draft, id: "other-id", title: "Other" };

  it("replaces the item matching id and leaves the rest untouched", () => {
    const published: MediaItem = { ...draft, status: "published" };

    expect(replaceMedia([other, draft], draft.id, published)).toEqual([
      other,
      published,
    ]);
  });

  it("returns the original items when no id matches", () => {
    expect(replaceMedia([other], draft.id, draft)).toEqual([other]);
  });
});
